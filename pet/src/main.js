// main.js — TD 记忆守护·控制台应用主进程
// 形态：常驻托盘 + 控制台窗口；应用自身即后台守护（采集上传 + 127.0.0.1:8100 recall 服务）。
// 配置真源：~/.zcode/tdai-mcp.json（守护进程 / MCP / hook 共用同一份，四处不再各存一份）；
//          应用偏好（主题/自启/自动更新）另存 ~/.zcode/tdai-app.json。
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const guard = require('./guard.js');
const register = require('./register.js');
const updater = require('./updater.js');
const metricsMod = require('./metrics.js');
const sessionsMod = require('./sessions.js');

const IS_DEV = !app.isPackaged;
const HOME = os.homedir();
const PREF_PATH = path.join(HOME, '.zcode', 'tdai-app.json');
const LEGACY_PREF_PATH = path.join(HOME, '.tdai-pet', 'config.json'); // 0.3.x 的应用偏好，迁移一次
// 开机自启：只驻托盘不弹窗（argv 与 Chromium switch 两处都认，Windows 下二者取值口径不同）
const HIDDEN_BOOT = process.argv.includes('--hidden') || app.commandLine.hasSwitch('hidden');

// dev 走仓库根，打包走 resources/（extraResources 铺平了 core / mcp / daemon）
function resPath(...p) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', '..', ...p);
}
const DAEMON_JS = resPath('daemon', 'tdai-daemon.js');
const MCP_JS = resPath('mcp', 'tdai-mcp.js');

const dm = require(DAEMON_JS);                       // 守护实现（同一份，不做二次开发）
const tdai = require(resPath('core', 'tdai-core.js'));

let consoleWin = null;
let tray = null;
let core = null;
let prefs = null;
let healthTimer = null;
let lastHealth = { running: false, health: null };

/* ---------- 实时指标（总览页数据源） ---------- */
// 计量链路：core 的 _onHttp/_onHttpStart 观察者（真实 socket 字节）→ metrics
//          → 1s 心跳 webContents.send('metrics', snapshot) → 渲染进程六分区
const metrics = metricsMod.createMetrics();
let tickTimer = null;
let pingTimer = null;
let sessionScanTimer = null;
let lastSessionScan = { ok: true, files: 0, total: 0, sessions: [] };
let lastCursor = { ok: false, count: 0, bySource: {} };

const fmtBytes = metricsMod.fmtBytes;
const fmtSpeed = metricsMod.fmtSpeed;
const shortEndpoint = metricsMod.shortEndpoint;

/* ---------- 应用偏好（主题 / 自启 / 自动更新） ---------- */

function defaultPrefs() { return { ui: { theme: 'dark' }, system: { autoStart: false }, update: { autoCheck: true } }; }

function mergeDeep(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = mergeDeep(a[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}

function loadPrefs() {
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(PREF_PATH, 'utf8')); } catch (_) { }
  if (!disk) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_PREF_PATH, 'utf8'));
      if (legacy) disk = { ui: legacy.ui, system: legacy.system, update: legacy.update };
    } catch (_) { }
  }
  prefs = mergeDeep(defaultPrefs(), disk || {});
  return prefs;
}

function savePrefs() {
  try { fs.mkdirSync(path.dirname(PREF_PATH), { recursive: true }); fs.writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2)); } catch (_) { }
}

/* ---------- 主题 / 自启 ---------- */

function resolveTheme() {
  if (prefs.ui.theme === 'auto') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return prefs.ui.theme === 'light' ? 'light' : 'dark';
}
function applyTheme() {
  nativeTheme.themeSource = prefs.ui.theme === 'auto' ? 'system' : (prefs.ui.theme === 'light' ? 'light' : 'dark');
  broadcast('theme', resolveTheme());
}
function applyAutoStart() {
  if (IS_DEV) return; // 开发模式不动注册表
  try {
    app.setLoginItemSettings({ openAtLogin: !!prefs.system.autoStart, openAsHidden: true, path: process.execPath, args: ['--hidden'] });
  } catch (e) { console.error('开机自启设置失败:', e.message); }
}

/* ---------- 记忆库连接（真源 ~/.zcode/tdai-mcp.json） ---------- */

function publicConn() { return dm.readPublicConfig(dm.loadConfig()); }

// 重建 core 时挂上流量观察者：
//   上行字节 = 真实请求体长度（core 用 Buffer.byteLength 精确算出）+ HTTP 头固定开销
//   下行字节 = 真实响应体长度 + 固定开销
// 观察者缺省 noop，这里显式传入；失败也不抛出（core 内部已 try/catch）。
const HTTP_HDR_UP = 240;    // 请求头典型开销（Host/Content-Type/两个自定义 X-Tdai-*）
const HTTP_HDR_DOWN = 200;  // 响应头典型开销

/* ---------- 面板 / 守护健康状态（供渲染层判断"已连接"） ----------
 * 以前 console.js 读 snap.panelOk / snap.daemonOk，但主进程从未提供这两个字段，
 * 导致判据恒为 undefined，连接状态卡与右上角 pill 永远无法正确变化。
 * 现在由主进程权威维护：
 *   panelOk    = 最近一次面板往返是否成功（连接失败或 4xx/5xx 记为 false）
 *   panelError = 失败原因（面板不可达 / HTTP 状态码）
 *   daemonOk   = 最近一次守护探活是否成功
 */
let panelOk = null;                 // null = 尚无结论
let panelError = '';
let panelOkAt = 0;
let daemonOk = null;
let daemonOkAt = 0;

function rebuildCore() {
  core = tdai.create({
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      metrics.beginTask(dir, { label: shortEndpoint(info.url), url: info.url, method: info.method });
      metrics.setCurrent(dir, shortEndpoint(info.url));
    },
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      const ok = st >= 200 && st < 300;
      const ep = shortEndpoint(info.url);
      const dir = info.method === 'GET' ? 'down' : 'up';
      const upBytes = (info.reqBytes || 0) + HTTP_HDR_UP;
      const downBytes = (info.resBytes || 0) + HTTP_HDR_DOWN;

      metrics.meter({ dir: 'up', bytes: upBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
      metrics.meter({ dir: 'down', bytes: downBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
      metrics.endTask(dir, {
        state: ok ? 'done' : 'error',
        bytes: dir === 'up' ? upBytes : downBytes,
        ms: info.ms, status: st,
      });

      // 面板健康：任何一次真实往返都能给出结论（连接失败/5xx 都算不可达）
      panelOk = ok;
      panelOkAt = Date.now();
      panelError = ok ? '' : (st === 0 ? '面板不可达（连接失败或超时）' : `面板返回 HTTP ${st}`);

      if (ok) {
        metrics.pushLog('ok', `${ok && info.method === 'GET' ? '检索' : '提交'}成功 · ${ep} · ${info.ms}ms`,
          `HTTP ${st}\nendpoint : ${ep}\n方法     : ${info.method}\n上行     : ${fmtBytes(upBytes)}\n下行     : ${fmtBytes(downBytes)}\n耗时     : ${info.ms} ms`);
      } else {
        metrics.pushLog('error', `${st === 0 ? '连接失败' : 'HTTP ' + st} · ${ep}`,
          `${st === 0 ? '连接失败（面板不可达/超时）' : 'HTTP ' + st}\nendpoint : ${ep}\n方法     : ${info.method}\n错误     : ${info.error || '—'}\n耗时     : ${info.ms} ms`);
      }
    },
  });
}

function saveConn(body) {
  const cfg = dm.writeConfig(body || {});           // 白名单字段 + 跑前备份 .bak
  rebuildCore();
  guard.restart(dm).catch(() => { });
  return dm.readPublicConfig(cfg);
}

// 链接测试：面板可达性 + User Key 认证（与网页控制台同口径）
async function testConn() {
  const cfg = dm.loadConfig();
  const t0 = Date.now();
  if (!cfg.panelUrl || !cfg.userKey) return { nas: false, auth: false, latencyMs: 0, hint: '请先填写面板地址与 User Key' };
  try {
    const api = dm.mkApi(cfg);
    const r = await api('/skill/list', { method: 'POST', body: { team_id: cfg.teamId || undefined }, timeout: 8000 });
    const ok = r.status >= 200 && r.status < 300;
    let hint = '';
    if (!ok) hint = (r.status === 401 || r.status === 403) ? 'User Key 可能失效' : `面板返回 HTTP ${r.status}`;
    return { nas: ok, auth: ok, latencyMs: Date.now() - t0, hint };
  } catch (e) {
    return { nas: false, auth: false, latencyMs: Date.now() - t0, hint: '面板不可达（' + e.message + '）' };
  }
}

/* ---------- 健康轮询（内置/外部守护都能查，答案一致） ---------- */

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

async function pollHealth() {
  const h = await guard.health();
  lastHealth = Object.assign(guard.localStatus(), { health: h && h.json ? h.json : null });
  broadcast('health', lastHealth);
  return lastHealth;
}
function startPolling() { stopPolling(); pollHealth(); healthTimer = setInterval(pollHealth, 30000); }
function stopPolling() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }

/* ---------- 实时心跳（1s）----------
 * 每秒：采样速率 → 合并会话/日志/守护状态 → 推给控制台窗口。
 * 窗口不存在时也照常采样（序列保持连续），只是没人接收。
 */

function currentSnapshot() {
  return metrics.snapshot({
    panelUrl: (core && core.cfg && core.cfg.panelUrl) || '',
    panelOk,
    panelError,
    panelOkAt,
    daemonOk,
    daemonOkAt,
  });
}

function startTick() {
  stopTick();
  metrics.pushLog('info', `控制台已启动 · 守护端口 ${guard.port()}`);
  // 首帧立刻探活一次，避免右上角 pill 长时间停在"检测中"
  daemonPing().catch(() => { });
  pingTimer = setInterval(() => { daemonPing().catch(() => { }); }, 10000);
  tickTimer = setInterval(() => {
    try {
      metrics.sample();
      const snap = currentSnapshot();
      if (consoleWin && !consoleWin.isDestroyed()) {
        consoleWin.webContents.send('metrics', snap);
      }
    } catch (e) {
      metrics.pushLog('error', '心跳采样异常：' + e.message);
    }
  }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

/* ---------- 会话扫描（4s，供总览"实时会话"） ---------- */

function refreshSessions(reason) {
  try {
    const r = sessionsMod.scanSessions({ limit: 40 });
    lastSessionScan = r;
    lastCursor = sessionsMod.cursorStats();
    for (const s of r.sessions) metrics.touchSession(s);
    metrics.dropSessions(r.sessions.map((s) => s.id));
    return { ok: true, files: r.files, total: r.total };
  } catch (e) {
    metrics.pushLog('warn', '会话扫描失败：' + e.message);
    return { ok: false, error: e.message };
  }
}
function startSessionScan() {
  stopSessionScan();
  refreshSessions('start');
  sessionScanTimer = setInterval(() => refreshSessions('tick'), 4000);
}
function stopSessionScan() { if (sessionScanTimer) { clearInterval(sessionScanTimer); sessionScanTimer = null; } }

/* ---------- 守护探活（计入真实流量：这是本机 HTTP，但能反映"本地服务在不在"） ---------- */

function daemonPing() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const port = guard.port();
    const req = require('http').request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Date.now() - t0;
        const resBytes = chunks.reduce((n, c) => n + c.length, 0);
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { }
        metrics.meter({ dir: 'down', bytes: resBytes + HTTP_HDR_DOWN, ms, status: res.statusCode, url: `http://127.0.0.1:${port}/health`, method: 'GET' });
        metrics.meter({ dir: 'up', bytes: HTTP_HDR_UP, ms, status: res.statusCode, url: `http://127.0.0.1:${port}/health`, method: 'GET' });
        metrics.setLatency(ms);
        metrics.setCurrent('down', '/health');
        const good = !!(res.statusCode === 200 && json);
        daemonOk = good; daemonOkAt = Date.now();
        resolve({ ok: good, ms, payload: json, error: res.statusCode === 200 ? '' : 'HTTP ' + res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(); metrics.pushLog('warn', `守护进程 :${port} 探活超时`); daemonOk = false; daemonOkAt = Date.now(); resolve({ ok: false, ms: Date.now() - t0, payload: null, error: 'timeout' }); });
    req.on('error', (e) => {
      metrics.meter({ dir: 'up', bytes: HTTP_HDR_UP, ms: Date.now() - t0, status: 0, url: `http://127.0.0.1:${port}/health`, method: 'GET', error: e.code });
      daemonOk = false; daemonOkAt = Date.now();
      resolve({ ok: false, ms: Date.now() - t0, payload: null, error: e.code || e.message });
    });
    req.end();
  });
}

/* ---------- 控制台窗口 ---------- */

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 1080, height: 720, minWidth: 920, minHeight: 600,
    frame: false, show: false,
    backgroundColor: resolveTheme() === 'dark' ? '#0b0c10' : '#f3f4f8',
    icon: resPath('build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  consoleWin.loadFile(path.join(__dirname, 'console.html'));
  consoleWin.once('ready-to-show', () => consoleWin.show());
  // 首屏立即推一次，避免等 1s 心跳导致白屏
  consoleWin.webContents.once('did-finish-load', () => {
    try { consoleWin.webContents.send('metrics', currentSnapshot()); } catch (_) { }
  });
  consoleWin.on('closed', () => { consoleWin = null; });
}

/* ---------- 托盘 ---------- */

function createTray() {
  const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'build', 'tray.png') : resPath('build', 'tray.png');
  tray = new Tray(iconPath);
  tray.setToolTip('TD 记忆守护');
  refreshTrayMenu();
  tray.on('click', createConsole);
  tray.on('double-click', createConsole);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: createConsole },
    { label: `打开网页控制台（:${guard.port()}）`, click: () => shell.openExternal(`http://127.0.0.1:${guard.port()}/`) },
    { type: 'separator' },
    { label: '检查更新', click: () => updater.check(true) },
    {
      label: '开机自启（后台静默）', type: 'checkbox', checked: !!prefs.system.autoStart, click: (i) => {
        prefs.system.autoStart = i.checked; savePrefs(); applyAutoStart(); broadcast('prefs', prefs);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

/* ---------- IPC ---------- */

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  exePath: process.execPath,
  mcpJs: MCP_JS,
  daemonJs: DAEMON_JS,
  packaged: app.isPackaged,
  port: guard.port(),
  cfgPath: dm.CFG_PATH,
  // 面板地址与连接健康：供右上角连接状态 pill 与总览状态卡判断"是否已连接"
  panelUrl: (core && core.cfg && core.cfg.panelUrl) || '',
  panelOk,
  panelError,
  daemonOk,
}));

ipcMain.handle('conn-load', () => publicConn());
ipcMain.handle('conn-save', (_e, body) => saveConn(body));
ipcMain.handle('conn-test', () => testConn());

ipcMain.handle('prefs-load', () => prefs);
ipcMain.handle('prefs-save', (_e, patch) => {
  prefs = mergeDeep(prefs, patch || {});
  savePrefs();
  applyAutoStart();
  applyTheme();
  updater.setAutoCheck(prefs.update.autoCheck);
  refreshTrayMenu();
  return prefs;
});

ipcMain.handle('guard-status', async () => {
  const h = await guard.health();
  return Object.assign(guard.localStatus(), { health: h && h.json ? h.json : null });
});
ipcMain.handle('guard-push', () => guard.push());
ipcMain.handle('guard-restart', () => guard.restart(dm));

/* ---------- 历史会话回传（转发到守护进程 /api/backfill，任务在守护进程内异步跑） ---------- */

function daemonHttp(method, apiPath, body) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = require('http').request({
      host: '127.0.0.1', port: guard.port(), path: apiPath, method,
      timeout: 8000,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, payload: json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, payload: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, payload: null, error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}
ipcMain.handle('backfill-start', (_e, opts) => daemonHttp('POST', '/api/backfill', opts || {}));
ipcMain.handle('backfill-status', () => daemonHttp('GET', '/api/backfill'));

ipcMain.handle('agents-status', () => register.status({ home: HOME, exePath: process.execPath }));
ipcMain.handle('agents-register', () => {
  const results = register.register({ home: HOME, exePath: process.execPath, mcpJs: MCP_JS, daemonJs: DAEMON_JS });
  return { results, items: register.status({ home: HOME, exePath: process.execPath }) };
});

ipcMain.handle('get-health', () => lastHealth);
ipcMain.handle('refresh', () => pollHealth());

/* ---------- 实时监控 IPC ---------- */

// 仪表盘全量快照（渲染进程首屏 + 兜底轮询用）
ipcMain.handle('metrics-get', () => currentSnapshot());

// 会话扫描（可强制刷新）
ipcMain.handle('sessions-scan', (_e, opts) => {
  if (opts && opts.force) refreshSessions('manual');
  return { ok: true, files: lastSessionScan.files, total: lastSessionScan.total, sessions: lastSessionScan.sessions };
});

// 游标统计
ipcMain.handle('cursor-stats', () => lastCursor);

// 守护进程探活（真实 HTTP 到 127.0.0.1:<port>/health）
ipcMain.handle('daemon-ping', () => daemonPing());

// 渲染进程侧被动流量上报（preload 拦截 fetch/XHR 得到语义，主进程补真实字节）
ipcMain.on('flow-passive', (_e, ev) => {
  if (!ev || !ev.dir) return;
  metrics.meter({
    dir: ev.dir, bytes: Number(ev.bytes) || 0, ms: ev.ms,
    status: ev.status, url: ev.url, method: ev.method, error: ev.error,
  });
});

// 复制到剪贴板
ipcMain.handle('clipboard-write', (_e, text) => {
  try { require('electron').clipboard.writeText(String(text || '')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 打开目录/文件
ipcMain.handle('reveal-path', (_e, p) => { try { shell.showItemInFolder(String(p)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

ipcMain.handle('tool-call', async (_e, { tool, args }) => {
  if (!core) return { ok: false, error: 'core 未初始化' };
  const map = {
    memory_search: () => core.memorySearch(args),
    memory_layers: () => core.memoryLayers(args),
    team_assets: () => core.teamAssets(args),
    my_agents: () => core.myAgents(args),
    skill_list: () => core.skillList(args),
    skill_get: () => core.skillGet(args),
    wiki_search: () => core.wikiSearch(args),
    wiki_read: () => core.wikiRead(args),
    codegraph_search: () => core.codegraphSearch(args),
    codegraph_explore: () => core.codegraphExplore(args),
  };
  const fn = map[tool];
  if (!fn) return { ok: false, error: `未知工具 ${tool}` };
  const t0 = Date.now();
  metrics.beginTask('down', { label: tool, url: tool, method: 'POST' });
  metrics.setCurrent('down', tool);
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    metrics.endTask('down', { state: r.ok ? 'done' : 'error', bytes: 0, ms, status: r.ok ? 200 : 0 });
    if (r.ok) metrics.pushLog('flow', `工具调用 ${tool}`, `工具     : ${tool}\n耗时     : ${ms} ms\n参数     : ${JSON.stringify(args || {}).slice(0, 300)}`);
    else metrics.pushLog('warn', `工具调用失败 ${tool}`, `工具     : ${tool}\n错误     : ${r.error || ''}\n提示     : ${r.hint || ''}`);
    return r;
  } catch (e) {
    metrics.endTask('down', { state: 'error', bytes: 0, ms: Date.now() - t0, status: 0 });
    metrics.pushLog('error', `工具调用异常 ${tool}`, e.message);
    return { ok: false, error: e.message };
  }
});

// 更新（安装版 electron-updater / 便携版 latest.yml 比对）
ipcMain.handle('update-get', () => updater.getStatus());
ipcMain.handle('update-check', () => updater.check(true));
ipcMain.handle('update-download', () => updater.download());
ipcMain.handle('update-install', () => updater.triggerInstall());
ipcMain.handle('update-open-releases', () => updater.openReleases());
ipcMain.handle('update-open-repo', () => updater.openRepo());

// 窗口与外部链接
ipcMain.handle('win-min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle('win-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('open-external', (_e, url) => shell.openExternal(String(url)));
ipcMain.handle('quit', () => app.quit());

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => createConsole());

  app.whenReady().then(async () => {
    loadPrefs();
    rebuildCore();
    if (!HIDDEN_BOOT) createConsole();     // 开机自启时只驻托盘
    createTray();
    applyAutoStart();
    applyTheme();
    updater.init();
    updater.setAutoCheck(prefs.update.autoCheck);
    startPolling();
    startTick();
    startSessionScan();
    guard.start(dm).then(() => {
      pollHealth();
      metrics.pushLog('ok', `守护进程已就绪 · 本地服务 127.0.0.1:${guard.port()}`);
    }).catch((e) => {
      metrics.pushLog('warn', '守护进程启动失败：' + (e && e.message));
    });
    globalShortcut.register('CommandOrControl+Shift+M', () => createConsole());
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopPolling(); stopTick(); stopSessionScan(); guard.stop(); });
  app.on('window-all-closed', () => { /* 关窗不退出：守护与托盘继续运行 */ });
}
