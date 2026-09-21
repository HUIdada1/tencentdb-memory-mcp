// TD AI Memory Pet — Electron 主进程
// 双窗口:Pet(透明置顶小窗) + Console(管理面板)
// 能力:开机自启 / 主题 / 自更新 / 设置弹窗
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tdai = require(path.join(__dirname, '..', 'core', 'tdai-core.js'));
const updater = require('./updater.js');

const IS_DEV = !app.isPackaged;
const CFG_DIR = path.join(os.homedir(), '.tdai-pet');
const CFG_PATH = path.join(CFG_DIR, 'config.json');

let petWin = null;
let consoleWin = null;
let tray = null;
let core = null;
let cfg = null;
let pollTimer = null;
let lastHealth = { ok: false, at: 0, latencyMs: 0, message: '未初始化' };

/* ---------- 配置 ---------- */

function defaultCfg() {
  return {
    panel: {
      url: 'http://muhuihao.top:8125',
      userKey: '',
      teamId: 'team-zcv52tgzwg',
      agentId: 'agt-zc6vu8z5ks',
      taskId: 'task-zdlxl0mp4h',
    },
    pet: {
      x: null, y: null,
      size: 200,
      alwaysOnTop: true,
      clickThrough: false,
      opacity: 1.0,
    },
    sync: {
      intervalSec: 60,
    },
    ai: {
      enabled: false,
      endpoint: '',
      apiKey: '',
      model: 'deepseek-chat',
    },
    ui: { theme: 'dark' },            // dark | light | auto
    system: { autoStart: false },      // 开机自启
    update: { autoCheck: true },
  };
}

function loadCfg() {
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); } catch (_) {}
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) {}
  cfg = mergeDeep(defaultCfg(), disk);
  return cfg;
}
function mergeDeep(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = mergeDeep(a[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}
function saveCfg() { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); }

/* ---------- 主题 ---------- */
function resolveTheme() {
  const t = cfg.ui.theme;
  if (t === 'auto') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return t;
}
function applyTheme() {
  const t = resolveTheme();
  if (t === 'dark') { nativeTheme.themeSource = 'dark'; } else if (t === 'light') { nativeTheme.themeSource = 'light'; } else { nativeTheme.themeSource = 'system'; }
  for (const w of [petWin, consoleWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('theme', t);
  }
}

/* ---------- 开机自启 ---------- */
function applyAutoStart() {
  if (IS_DEV) return; // 开发模式不动注册表
  const enabled = !!cfg.system.autoStart;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      path: process.execPath,
      args: [],
    });
  } catch (e) { console.error('autoStart 设置失败:', e.message); }
}

/* ---------- core 实例(跟着 cfg.panel 走) ---------- */
function rebuildCore() {
  // 若 pet 配置里 userKey 为空,尝试从 ZCode MCP 配置迁移
  if (!cfg.panel.userKey) {
    try {
      const mcpCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'tdai-mcp.json'), 'utf8'));
      if (mcpCfg.userKey) {
        cfg.panel.userKey = mcpCfg.userKey;
        saveCfg();
      }
    } catch (_) {}
  }
  core = tdai.create({
    panelUrl: cfg.panel.url,
    userKey: cfg.panel.userKey,
    teamId: cfg.panel.teamId,
    agentId: cfg.panel.agentId,
    taskId: cfg.panel.taskId,
  });
}

/* ---------- 轮询 ---------- */
async function pollOnce(reason) {
  if (!core) return;
  const t0 = Date.now();
  const r = await core.health();
  lastHealth = {
    ok: !!(r.ok && r.data && r.data.auth && r.data.auth.ok),
    at: Date.now(),
    latencyMs: Date.now() - t0,
    message: r.ok
      ? (r.data && r.data.auth && r.data.auth.ok ? '已连接' : (r.data.auth.hint || r.data.auth.error || '异常'))
      : (r.hint || r.error || '异常'),
    raw: r,
  };
  broadcast('health', lastHealth, reason);
}
function broadcast(channel, payload, reason) {
  for (const w of [petWin, consoleWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, { payload, reason: reason || '' });
  }
}
function startPolling() {
  stopPolling();
  pollOnce('boot');
  pollTimer = setInterval(() => pollOnce('tick'), Math.max(15, cfg.sync.intervalSec) * 1000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ---------- Pet 窗口 ---------- */
function createPet() {
  const size = cfg.pet.size;
  const d = screen.getPrimaryDisplay().workAreaSize;
  const x = cfg.pet.x != null ? cfg.pet.x : d.width - size - 24;
  const y = cfg.pet.y != null ? cfg.pet.y : d.height - size - 24;

  petWin = new BrowserWindow({
    width: size, height: size, x, y,
    frame: false, transparent: true, resizable: false,
    skipTaskbar: true, hasShadow: false,
    alwaysOnTop: cfg.pet.alwaysOnTop,
    opacity: cfg.pet.opacity,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  petWin.setAlwaysOnTop(cfg.pet.alwaysOnTop, 'screen-saver');
  petWin.setIgnoreMouseEvents(cfg.pet.clickThrough, { forward: true });
  petWin.loadFile(path.join(__dirname, 'pet.html'));
  petWin.on('moved', () => {
    if (!petWin) return;
    const [x, y] = petWin.getPosition();
    cfg.pet.x = x; cfg.pet.y = y; saveCfg();
  });
  petWin.on('closed', () => { petWin = null; });
}

/* ---------- Console 窗口 ---------- */
function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 1140, height: 740, minWidth: 980, minHeight: 620,
    frame: false,
    backgroundColor: resolveTheme() === 'dark' ? '#08080d' : '#eceef4',
    icon: path.join(__dirname, 'logo-128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  consoleWin.loadFile(path.join(__dirname, 'console.html'));
  consoleWin.on('closed', () => { consoleWin = null; });
}

/* ---------- Tray ---------- */
function createTray() {
  const iconPath = IS_DEV
    ? path.join(__dirname, '..', '..', 'build', 'tray.png')
    : path.join(process.resourcesPath, 'build', 'tray.png');
  tray = new Tray(iconPath);
  tray.setToolTip('TD 记忆守护');
  refreshTrayMenu();
  tray.on('click', createConsole);
  tray.on('double-click', createConsole);
}
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '控制台', click: createConsole },
    { type: 'separator' },
    { label: '检查更新', click: () => updater.check(true) },
    { label: '开机自启', type: 'checkbox', checked: !!cfg.system.autoStart, click: (i) => {
      cfg.system.autoStart = i.checked; saveCfg(); applyAutoStart();
    } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

/* ---------- IPC ---------- */
ipcMain.handle('get-config', () => cfg);
ipcMain.handle('set-config', (_e, patch) => {
  cfg = mergeDeep(cfg, patch || {});
  saveCfg();
  rebuildCore();
  startPolling();
  applyAutoStart();
  applyTheme();
  if (petWin && !petWin.isDestroyed()) {
    petWin.setAlwaysOnTop(cfg.pet.alwaysOnTop, 'screen-saver');
    petWin.setIgnoreMouseEvents(cfg.pet.clickThrough, { forward: true });
    petWin.setOpacity(cfg.pet.opacity);
  }
  refreshTrayMenu();
  broadcast('config', cfg, 'set');
  return cfg;
});
ipcMain.handle('get-health', () => lastHealth);
ipcMain.handle('refresh', async () => { await pollOnce('manual'); return lastHealth; });

ipcMain.handle('tool-call', async (_e, { tool, args }) => {
  if (!core) return { ok: false, error: 'core 未初始化' };
  const map = {
    'memory_search': () => core.memorySearch(args),
    'memory_layers': () => core.memoryLayers(args),
    'team_assets': () => core.teamAssets(args),
    'skill_list': () => core.skillList(args),
    'skill_get': () => core.skillGet(args),
    'wiki_search': () => core.wikiSearch(args),
    'wiki_read': () => core.wikiRead(args),
    'codegraph_search': () => core.codegraphSearch(args),
    'codegraph_explore': () => core.codegraphExplore(args),
  };
  const fn = map[tool];
  if (!fn) return { ok: false, error: `未知工具 ${tool}` };
  try { return await fn(); } catch (e) { return { ok: false, error: e.message }; }
});

// 更新相关
ipcMain.handle('update-get', () => updater.getStatus());
ipcMain.handle('update-check', () => updater.check(true));
ipcMain.handle('update-download', () => updater.download());
ipcMain.handle('update-install', () => updater.triggerInstall());
ipcMain.handle('update-open-releases', () => updater.openReleases());
ipcMain.handle('update-open-repo', () => updater.openRepo());

// 窗口控制
ipcMain.handle('win-min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle('win-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('open-console', createConsole);
ipcMain.handle('quit', () => app.quit());
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

/* ---------- 生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (petWin) { petWin.show(); petWin.focus(); } });

  app.whenReady().then(() => {
    loadCfg();
    rebuildCore();
    // Pet 窗口默认不自启,只开控制台;用户可以从托盘或快捷键再打开
    // createPet();  ← 暂时隐藏,最终版由用户决定是否启用
    createConsole();
    createTray();
    applyAutoStart();
    applyTheme();
    startPolling();
    updater.init();
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (consoleWin && !consoleWin.isDestroyed()) consoleWin.focus(); else createConsole();
    });
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopPolling(); });
  app.on('window-all-closed', () => { /* 活在托盘 */ });
}
