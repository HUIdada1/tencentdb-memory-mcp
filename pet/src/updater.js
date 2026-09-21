// updater.js — 自更新模块(抄 AgentHub updater.cjs 精简版)
// 安装版(NSIS):electron-updater 自动下载/安装
// 便携版(portable):只读 latest.yml,提示后跳 GitHub 手动下
'use strict';
const path = require('path');
const { app, BrowserWindow, Notification, nativeImage, shell, net } = require('electron');

const GITHUB_REPO_URL = 'https://github.com/HUIdada1/tencentdb-memory-mcp';
const GITHUB_RELEASES_URL = GITHUB_REPO_URL + '/releases';
const LATEST_YML_URL = GITHUB_RELEASES_URL + '/latest/download/latest.yml';
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* 无 */ }

let status = idleStatus();
let lastManualCheckAt = 0;
let installTriggered = false;
let currentCheckIsManual = false;
let timer = null;
let notifiedVersion = '';

function isPortable() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  // 与 AgentHub 同口径：exe 同目录放 portable.flag 手动开启便携模式，
  // 不然手动便携副本会走 electron-updater 自动更新路径（更新的是被当便携用的副本）
  try {
    const fs = require('fs');
    if (app.isPackaged && fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'portable.flag'))) return true;
  } catch { /* 判定失败按非便携 */ }
  return false;
}

function idleStatus() {
  return {
    status: 'idle',
    isPortable: isPortable(),
    currentVersion: app.getVersion(),
    latestVersion: '',
    percent: 0,
    notes: '',
    message: '',
  };
}

function notifyIcon() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png');
    return nativeImage.createFromPath(p);
  } catch { return nativeImage.createEmpty(); }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: notifyIcon() });
  n.show();
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:state', status);
  }
}

function setState(s, extra) {
  status = Object.assign({}, status, extra || {}, { status: s });
  broadcast();
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function htmlToText(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function toNotes(n) {
  if (typeof n === 'string') return htmlToText(n);
  if (Array.isArray(n)) return htmlToText(n.map((r) => r && r.note || '').filter(Boolean).join('\n'));
  return '';
}

function notifyAvailable(v) {
  if (notifiedVersion === v) return;
  notifiedVersion = v;
  if (isPortable()) notify(`检测到新版本 ${v}`, '便携版请前往 GitHub 手动下载');
  else notify(`发现新版本 ${v}`, '点击查看更新内容,可在更新中心下载');
}

function onError(e) {
  const msg = e && e.message ? e.message : String(e || '未知错误');
  const action = status.status === 'checking' ? '检查更新失败' : status.status === 'downloading' ? '下载更新失败' : '更新失败';
  setState('error', { percent: 0, message: `${action}:${msg}` });
}

function checkInstalled() {
  if (!app.isPackaged) { setState('up-to-date', { message: '开发模式不检查' }); return status; }
  if (!autoUpdater) { setState('error', { message: '更新组件缺失' }); return status; }
  setState('checking');
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

function netFetch(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => { if (done) return; done = true; try { req.abort(); } catch {} reject(new Error('请求超时')); }, FETCH_TIMEOUT_MS);
    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.on('data', () => {});
        res.on('end', () => {
          try {
            const next = new URL(res.headers.location, url).toString();
            finish(() => netFetch(next, redirectsLeft - 1).then(resolve, reject));
          } catch (e) { finish(reject, e); }
        });
        return;
      }
      if (res.statusCode !== 200) {
        res.on('data', () => {});
        res.on('end', () => finish(reject, new Error('HTTP ' + res.statusCode)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

async function checkPortable() {
  setState('checking');
  try {
    const text = await netFetch(LATEST_YML_URL, 5);
    const m = text.match(/^version:\s*([^\s]+)/m);
    if (!m) throw new Error('版本信息格式异常');
    const latest = m[1].trim();
    if (compareVersions(latest, app.getVersion()) > 0) {
      setState('available', { latestVersion: latest, message: '' });
      if (!currentCheckIsManual) notifyAvailable(latest);
    } else setState('up-to-date', { latestVersion: '', notes: '', percent: 0, message: '' });
  } catch (e) { onError(e); }
  return status;
}

function check(manual) {
  if (status.status === 'checking' || status.status === 'downloading' || status.status === 'downloaded') return status;
  if (manual) {
    const now = Date.now();
    if (now - lastManualCheckAt < MANUAL_COOLDOWN_MS) {
      if (status.status !== 'error') setState(status.status, { message: '刚刚检查过,请稍后再试' });
      return status;
    }
    lastManualCheckAt = now;
  }
  currentCheckIsManual = !!manual;
  return isPortable() ? checkPortable() : checkInstalled();
}

function download() {
  if (isPortable() || status.status !== 'available' || !autoUpdater) return status;
  autoUpdater.downloadUpdate().catch(() => {});
  return status;
}

function triggerInstall() {
  if (installTriggered || !autoUpdater || status.status !== 'downloaded') return status;
  installTriggered = true;
  autoUpdater.quitAndInstall(true, true);
  setTimeout(() => {
    if (installTriggered) {
      installTriggered = false;
      onError(new Error('安装程序未能启动'));
    }
  }, 10 * 1000);
  return status;
}

function openReleases() { shell.openExternal(GITHUB_RELEASES_URL); }
function openRepo() { shell.openExternal(GITHUB_REPO_URL); }

function bindEvents() {
  autoUpdater.on('checking-for-update', () => setState('checking'));
  autoUpdater.on('update-available', (info) => {
    setState('available', { latestVersion: info.version, notes: toNotes(info.releaseNotes), percent: 0, message: '' });
    if (!currentCheckIsManual) notifyAvailable(info.version);
  });
  autoUpdater.on('update-not-available', () => setState('up-to-date', { latestVersion: '', notes: '', percent: 0, message: '' }));
  autoUpdater.on('download-progress', (p) => {
    setState('downloading', { percent: Number.isFinite(p.percent) ? Math.round(p.percent) : 0, message: '' });
  });
  autoUpdater.on('update-downloaded', () => {
    setState('downloaded', { percent: 100, message: '' });
    notify('新版本已就绪', '退出应用时自动安装');
  });
  autoUpdater.on('error', (e) => onError(e));
}

function init() {
  status = idleStatus();
  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    bindEvents();
  }
  if (app.isPackaged) timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
}
function tick() {
  if (status.status !== 'downloading' && status.status !== 'downloaded') check(false);
  timer = setTimeout(tick, CHECK_INTERVAL_MS);
}

module.exports = { init, check, download, triggerInstall, openReleases, openRepo, isPortable, getStatus: () => status };
