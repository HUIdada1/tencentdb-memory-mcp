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

/* ---------- 应用偏好（主题 / 自启 / 自动更新 / 守护开关） ---------- */

function defaultPrefs() { return { ui: { theme: 'dark' }, system: { autoStart: false, guardEnabled: true }, update: { autoCheck: true } }; }

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
      // 只有"真正拿到响应"的往返才算面板延迟样本（2xx/4xx/5xx 都算——服务端答复了就说明可达）
      metrics.meter({ dir: 'down', bytes: downBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error, latencySample: ok });
      metrics.endTask(dir, {
        state: ok ? 'done' : 'error',
        bytes: dir === 'up' ? upBytes : downBytes,
        ms: info.ms, status: st, url: info.url, method: info.method,
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
  // 早先 guard.restart 的错误被 .catch(() => {}) 吞掉，界面无任何反馈：
  // 用户改了地址以为生效，实际守护还跑在旧配置上。现在把结果带回渲染层。
  let restart = { ok: true, external: false, error: '' };
  const cfg = dm.writeConfig(body || {});           // 白名单字段 + 跑前备份 .bak
  rebuildCore();
  guard.restart(dm).then((st) => {
    restart = { ok: !(st && st.lastError), external: !!(st && st.external), error: (st && st.lastError) || '' };
    if (restart.error) metrics.pushLog('error', '守护重启失败：' + restart.error);
    else if (restart.external) metrics.pushLog('info', '端口被外部守护进程占用，已切换为外部守护模式');
  }).catch((e) => {
    restart = { ok: false, external: false, error: (e && e.message) || String(e) };
    metrics.pushLog('error', '守护重启异常：' + restart.error);
  });
  // 配置刚变，立刻刷新一次面板健康判据，避免 pill 举着旧结论
  panelOk = null; panelError = '';
  return Object.assign(dm.readPublicConfig(cfg), { restart });
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
    // webContents.send 在窗口销毁竞态下会抛错（"Object has been destroyed"），
    // 早先无 try/catch：一次时序错位就能打断整个广播循环，后面的窗口收不到。
    try {
      if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
    } catch (_) { }
  }
}

async function pollHealth() {
  // guard.health() 内部已把超时/错误收敛为 null，但 IPC 与定时器共用此函数，
  // 仍需外层兜底：任何异常都不能让 30s 轮询自己把自己打死。
  try {
    const h = await guard.health();
    lastHealth = Object.assign(guard.localStatus(), { health: h && h.json ? h.json : null });
    broadcast('health', lastHealth);
    return lastHealth;
  } catch (e) {
    lastHealth = Object.assign(guard.localStatus(), { health: null, error: (e && e.message) || String(e) });
    try { broadcast('health', lastHealth); } catch (_) { }
    return lastHealth;
  }
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
      if (consoleWin && !consoleWin.isDestroyed() && consoleWin.webContents && !consoleWin.webContents.isDestroyed()) {
        consoleWin.webContents.send('metrics', snap);
      }
    } catch (e) {
      // 心跳是 1s 一次的循环，这里绝不能把异常抛出去（会变成未捕获异常）
      try { metrics.pushLog('error', '心跳采样异常：' + ((e && e.message) || e)); } catch (_) { }
    }
  }, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

/* ---------- 会话扫描（4s，供总览"实时会话"） ---------- */

let sessionScanRunning = false;
function refreshSessions(reason) {
  // 重叠保护：4s 定时器 + 手动刷新 + 页面切换都会调用它，
  // 单轮全量扫描（多文件 stat + 96KB 回读）在会话多时可能超过 4s，
  // 无保护时会出现多轮扫描并发叠加，CPU 与磁盘 IO 雪崩。
  if (sessionScanRunning) return { ok: true, skipped: true, files: lastSessionScan.files, total: lastSessionScan.total };
  sessionScanRunning = true;
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
  } finally {
    sessionScanRunning = false;
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
    const url = `http://127.0.0.1:${port}/health`;
    // done 守卫：timeout 与 error 可能先后触发，保证只结算一次
    let done = false;
    const settle = (v) => { if (done) return; done = true; resolve(v); };
    // 统一的"探活失败"计量：**上下行对称各记一笔**。
    // 早先成功路径记两笔（up+down），失败路径只记一笔 up、超时路径一笔都不记，
    // 导致 reqTotal / 上速率在守护掉线时失真，且 up 失败数被人为放大。
    const meterFail = (errorText, ms) => {
      metrics.meter({ dir: 'up', bytes: HTTP_HDR_UP, ms, status: 0, url, method: 'GET', error: errorText });
      metrics.meter({ dir: 'down', bytes: 0, ms, status: 0, url, method: 'GET', error: errorText });
    };
    let req;
    try {
      req = require('http').request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 4000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Date.now() - t0;
          const resBytes = chunks.reduce((n, c) => n + c.length, 0);
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { }
          metrics.meter({ dir: 'down', bytes: resBytes + HTTP_HDR_DOWN, ms, status: res.statusCode, url, method: 'GET', latencySample: true });
          metrics.meter({ dir: 'up', bytes: HTTP_HDR_UP, ms, status: res.statusCode, url, method: 'GET' });
          metrics.setLatency(ms);
          metrics.setCurrent('down', '/health');
          const good = !!(res.statusCode === 200 && json);
          daemonOk = good; daemonOkAt = Date.now();
          if (good) { daemonOkLog(port, ms); metricOkLog(port, ms); }
          else metricFailLog('HTTP ' + res.statusCode, port, ms);
          settle({ ok: good, ms, payload: json, error: res.statusCode === 200 ? '' : 'HTTP ' + res.statusCode });
        });
      });
    } catch (e) {
      // 端口非法等构造期异常：不能让它把整个 1s 心跳带崩
      daemonOk = false; daemonOkAt = Date.now();
      metrics.pushLog('warn', `守护探活无法发起：${e.message}`);
      settle({ ok: false, ms: Date.now() - t0, payload: null, error: e.code || e.message });
      return;
    }
    req.on('timeout', () => {
      // 超时是"往返未完成"：不再用 setLatency 污染延迟指标（早先这里会写入超时值）
      req.destroy();
      const ms = Date.now() - t0;
      metricFailLog('timeout', port, ms);
      meterFail('timeout', ms);
      daemonOk = false; daemonOkAt = Date.now();
      settle({ ok: false, ms, payload: null, error: 'timeout' });
    });
    req.on('error', (e) => {
      if (done) return;                        // 超时后 destroy 也会触发 error，别再记一笔
      const ms = Date.now() - t0;
      meterFail(e.code || e.message || 'network', ms);
      daemonOk = false; daemonOkAt = Date.now();
      settle({ ok: false, ms, payload: null, error: e.code || e.message });
    });
    req.end();
  });
}

// 守护探活失败告警：做状态翻转去抖。
// 守护重启空窗期会连续探活失败，早先每 5s 就打一条 WARN，日志很快被噪音淹没；
// 现在只在"由好变坏"时告警一次，恢复时给一条 ok，中间不再重复。
let daemonWasOk = null;
function metricFailLog(errorText, port, ms) {
  if (daemonWasOk === false) return;
  daemonWasOk = false;
  metrics.pushLog('warn', `守护进程 :${port} 探活失败 · ${errorText}`,
    `守护探活（GET /health）未成功\n端口     : ${port}\n原因     : ${errorText}\n耗时     : ${ms} ms\n说明     : 采集上传可能停摆；若外部已跑独立守护进程可忽略`);
}
function daemonOkLog(port, ms) {
  if (daemonWasOk === true) return;
  const recovered = daemonWasOk === false;
  daemonWasOk = true;
  if (recovered) metrics.pushLog('ok', `守护进程 :${port} 探活已恢复 · ${ms}ms`);
}
// 首次探活成功时留一条基线日志，便于事后回看"什么时候开始探得到"
let pingOkLogged = false;
function metricOkLog(port, ms) {
  if (pingOkLogged) return;
  pingOkLogged = true;
  metrics.pushLog('ok', `守护进程 :${port} 探活正常 · ${ms}ms`);
}

/* ---------- 控制台窗口 ---------- */

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 1080, height: 720, minWidth: 920, minHeight: 600,
    frame: false, show: false,
    // 与 console.css 的 --bg 令牌同值，避免启动瞬间闪白/闪黑
    backgroundColor: resolveTheme() === 'dark' ? '#16171c' : '#f4f4f7',
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
  // 渲染进程崩溃：留痕并在 1s 后尝试重载，避免用户看到永久白屏
  consoleWin.webContents.on('render-process-gone', (_e, details) => {
    try { metrics.pushLog('error', '控制台渲染进程异常退出：' + ((details && details.reason) || 'unknown')); } catch (_) { }
    setTimeout(() => {
      if (consoleWin && !consoleWin.isDestroyed()) { try { consoleWin.reload(); } catch (_) { } }
    }, 1000);
  });
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
// 记忆策略（recallAlways）：只改配置里的这一项，不触发守护重启。
// hook 每次实时读配置 → 立即生效；采集循环的 enabledSources 不受影响。
ipcMain.handle('recall-set', (_e, v) => {
  try {
    const disk = (() => { try { return JSON.parse(fs.readFileSync(dm.CFG_PATH, 'utf8')); } catch (_) { return {}; } })();
    disk.recallAlways = !!v;
    fs.mkdirSync(path.dirname(dm.CFG_PATH), { recursive: true });
    try { fs.copyFileSync(dm.CFG_PATH, dm.CFG_PATH + '.bak'); } catch (_) { }
    fs.writeFileSync(dm.CFG_PATH, JSON.stringify(disk, null, 2));
    metrics.pushLog('info', `记忆策略已切换为「${disk.recallAlways ? '每次对话都存读' : '仅提到才存读'}」`);
    return { ok: true, recallAlways: disk.recallAlways };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

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
// 守护服务开关（右上角 pill 点击）：停止后不再采集上传 / 不提供本地 recall 服务；
// 状态持久化在 prefs.system.guardEnabled，重启应用后保持
ipcMain.handle('guard-set', async (_e, enabled) => {
  prefs.system.guardEnabled = !!enabled;
  savePrefs();
  if (enabled) {
    const st = await guard.start(dm);
    metrics.pushLog('ok', '守护服务已手动开启');
    return { ok: true, running: !!st.running, external: !!st.external, enabled: true };
  }
  guard.stop();
  daemonOk = false; daemonOkAt = Date.now();
  metrics.pushLog('warn', '守护服务已手动停止（采集上传与本地 recall 服务已暂停）');
  return { ok: true, running: false, external: false, enabled: false };
});

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
/* ---------- 历史会话回传 ----------
 * 优先转发到守护进程 /api/backfill（任务在守护进程内异步跑，进度走 /api/backfill）。
 * 外部守护是老版本（无 /api/backfill，POST 返回 404）或守护未运行时，降级为应用
 * 进程内直接跑同一份 startBackfill 实现（daemon 模块已 require 进主进程），
 * 多机部署场景不再卡"守护进程版本过旧"。进程内回传状态通过 'backfill' 频道推送。
 */
const localBackfill = { state: null, timer: null };
function startLocalBackfill(opts) {
  if (localBackfill.state && dm.backfillStatus().running) return { ok: false, error: '已有回传任务在进行中，请等它跑完' };
  const cfg = dm.loadConfig();
  const api = dm.mkApi(cfg);
  localBackfill.state = dm.mkState();
  dm.ensureUserId(cfg, api, localBackfill.state);
  const r = dm.startBackfill(cfg, api, localBackfill.state, opts || {});
  if (r && r.ok) {
    if (localBackfill.timer) clearInterval(localBackfill.timer);
    localBackfill.timer = setInterval(() => {
      try { broadcast('backfill', dm.backfillStatus()); } catch (_) { }
      const st = dm.backfillStatus();
      if (!st.running) {
        clearInterval(localBackfill.timer); localBackfill.timer = null;
        metrics.pushLog('ok', `历史回传完成：${st.filesDone}/${st.files} 个文件 · 共 ${st.msgs} 条`);
      }
    }, 1000);
  }
  return r;
}
ipcMain.handle('backfill-start', async (_e, opts) => {
  const r = await daemonHttp('POST', '/api/backfill', opts || {});
  // 外部守护无此接口（404）或守护未运行（连接失败 status 0）→ 进程内兜底
  if (r && (r.status === 404 || r.status === 0)) {
    const lr = startLocalBackfill(opts || {});
    if (lr && lr.ok) return { ok: true, local: true, startedAt: lr.startedAt };
    return { ok: false, error: (lr && lr.error) || '守护未运行且进程内回传启动失败' };
  }
  return r;
});
ipcMain.handle('backfill-status', async () => {
  const r = await daemonHttp('GET', '/api/backfill');
  // 守护侧有真实回传任务（running 或 doneAt）就用它的；否则看进程内兜底
  if (r && r.payload && (r.payload.running || r.payload.doneAt)) return r;
  if (localBackfill.state) {
    const st = dm.backfillStatus();
    if (st.running || st.doneAt) return { ok: true, status: 200, payload: st };
  }
  return r;
});

ipcMain.handle('agents-status', () => register.status({ home: HOME, exePath: process.execPath }));
ipcMain.handle('agents-register', () => {
  const results = register.register({ home: HOME, exePath: process.execPath, mcpJs: MCP_JS, daemonJs: DAEMON_JS });
  return { results, items: register.status({ home: HOME, exePath: process.execPath }) };
});
// 单个客户端开关：{ key, enable: true|false } → 接入 / 断开该客户端
ipcMain.handle('agents-toggle', (_e, { key, enable } = {}) => {
  try {
    const results = enable
      ? register.registerOneClient(key, { home: HOME, exePath: process.execPath, mcpJs: MCP_JS, daemonJs: DAEMON_JS })
      : register.unregisterOneClient(key, { home: HOME });
    return { ok: true, results, items: register.status({ home: HOME, exePath: process.execPath }) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
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
// 这是**跨信任边界**的输入：渲染进程可能被页面脚本影响，字段一律白名单 + 范围裁剪，
// 非法方向直接丢弃（不能像早先那样把任意 dir 悄悄算成 down）。
const FLOW_BYTES_MAX = 64 * 1024 * 1024;   // 单笔上报字节上限 64MB，防伪造撑爆统计
const FLOW_MS_MAX = 10 * 60 * 1000;        // 单笔耗时上限 10min
const FLOW_URL_MAX = 512;
function sanitizeFlow(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.dir !== 'up' && ev.dir !== 'down') return null;
  const rawBytes = Number(ev.bytes);
  const rawMs = Number(ev.ms);
  const rawStatus = Number(ev.status);
  return {
    dir: ev.dir,
    bytes: Number.isFinite(rawBytes) ? Math.min(Math.max(Math.round(rawBytes), 0), FLOW_BYTES_MAX) : 0,
    ms: Number.isFinite(rawMs) ? Math.min(Math.max(Math.round(rawMs), 0), FLOW_MS_MAX) : undefined,
    status: Number.isFinite(rawStatus) ? Math.round(rawStatus) : undefined,
    url: ev.url == null ? '' : String(ev.url).slice(0, FLOW_URL_MAX),
    method: ev.method == null ? '' : String(ev.method).slice(0, 16).toUpperCase(),
    error: ev.error == null ? undefined : String(ev.error).slice(0, 200),
  };
}
ipcMain.on('flow-passive', (_e, ev) => {
  const clean = sanitizeFlow(ev);
  if (!clean) return;
  // 渲染进程上报的字节是"估算值"（拿不到真实 socket 字节），只记流量，
  // 不参与 us/ms 派生指标（latencySample:false），避免污染面板延迟。
  metrics.meter(Object.assign({ latencySample: false }, clean));
});

// 复制到剪贴板
ipcMain.handle('clipboard-write', (_e, text) => {
  try { require('electron').clipboard.writeText(String(text || '')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 实时日志导出：保存为 .log 文本文件
ipcMain.handle('log-export', async (_e, { text, suggestedName } = {}) => {
  try {
    const { dialog } = require('electron');
    const name = suggestedName || `tdai-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const r = await dialog.showSaveDialog({
      title: '导出实时日志',
      defaultPath: name,
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, String(text || ''), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
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
  // 工具调用走 core，core 的 _onHttp 观察者**已经**登记过同一条真实往返任务；
  // 这里再登记一次会凭空多出一个"永远 pending"的僵尸任务（挤掉 FLOW_ACC_MAX 名额）。
  // 早先靠"url 精确匹配不上 → 落到 LIFO 分支"歪打正着结束了它，属于隐患。
  // 现在只更新"当前正在访问的端点"文案，任务生命周期完全交给观察者。
  metrics.setCurrent('down', tool);
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    if (r.ok) metrics.pushLog('flow', `工具调用 ${tool}`, `工具     : ${tool}\n耗时     : ${ms} ms\n参数     : ${JSON.stringify(args || {}).slice(0, 300)}`);
    else metrics.pushLog('warn', `工具调用失败 ${tool}`, `工具     : ${tool}\n错误     : ${r.error || ''}\n提示     : ${r.hint || ''}`);
    return r;
  } catch (e) {
    metrics.pushLog('error', `工具调用异常 ${tool}`, (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e) };
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

/* ---------- 全局异常兜底 ----------
 * 常驻托盘应用一旦有未捕获异常就可能整进程退出（而用户以为它还在后台跑）。
 * 这里把两类全局异常收敛为日志，保证进程存活；主进程日志走 daemon.log 便于事后排查。
 */
process.on('uncaughtException', (e) => {
  const msg = (e && e.stack) || (e && e.message) || String(e);
  try { metrics.pushLog('error', '主进程未捕获异常', String(msg).slice(0, 1500)); } catch (_) { }
  try { console.error('[tdai] uncaughtException:', msg); } catch (_) { }
});
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.stack) || (reason && reason.message) || String(reason);
  try { metrics.pushLog('warn', '主进程未处理 Promise 拒绝', String(msg).slice(0, 1500)); } catch (_) { }
  try { console.error('[tdai] unhandledRejection:', msg); } catch (_) { }
});

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
    if (prefs.system.guardEnabled === false) {
      // 用户已手动停止守护：不自动启动，界面保持"已停止"状态
      metrics.pushLog('info', '守护服务处于停止状态（右上角可重新开启）');
    } else {
      guard.start(dm).then(() => {
        pollHealth();
        metrics.pushLog('ok', `守护进程已就绪 · 本地服务 127.0.0.1:${guard.port()}`);
      }).catch((e) => {
        metrics.pushLog('warn', '守护进程启动失败：' + (e && e.message));
      });
    }
    globalShortcut.register('CommandOrControl+Shift+M', () => createConsole());
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopPolling(); stopTick(); stopSessionScan(); guard.stop(); });
  app.on('window-all-closed', () => { /* 关窗不退出：守护与托盘继续运行 */ });
}
