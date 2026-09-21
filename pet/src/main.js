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

function rebuildCore() { core = tdai.create(); }

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

ipcMain.handle('agents-status', () => register.status({ home: HOME, exePath: process.execPath }));
ipcMain.handle('agents-register', () => {
  const results = register.register({ home: HOME, exePath: process.execPath, mcpJs: MCP_JS, daemonJs: DAEMON_JS });
  return { results, items: register.status({ home: HOME, exePath: process.execPath }) };
});

ipcMain.handle('get-health', () => lastHealth);
ipcMain.handle('refresh', () => pollHealth());

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
  try { return await fn(); } catch (e) { return { ok: false, error: e.message }; }
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
    guard.start(dm).then(() => pollHealth()).catch(() => { });
    globalShortcut.register('CommandOrControl+Shift+M', () => createConsole());
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopPolling(); guard.stop(); });
  app.on('window-all-closed', () => { /* 关窗不退出：守护与托盘继续运行 */ });
}
