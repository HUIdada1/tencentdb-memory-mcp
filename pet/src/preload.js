// preload.js — contextBridge 白名单
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdai', {
  // 应用信息 / 记忆库连接
  appInfo: () => ipcRenderer.invoke('app-info'),
  connLoad: () => ipcRenderer.invoke('conn-load'),
  connSave: (body) => ipcRenderer.invoke('conn-save', body),
  connTest: () => ipcRenderer.invoke('conn-test'),

  // 应用偏好（主题 / 自启 / 自动更新）
  prefsLoad: () => ipcRenderer.invoke('prefs-load'),
  prefsSave: (patch) => ipcRenderer.invoke('prefs-save', patch),

  // 后台守护
  guardStatus: () => ipcRenderer.invoke('guard-status'),
  guardPush: () => ipcRenderer.invoke('guard-push'),
  guardRestart: () => ipcRenderer.invoke('guard-restart'),

  // Agent 接入
  agentsStatus: () => ipcRenderer.invoke('agents-status'),
  agentsRegister: () => ipcRenderer.invoke('agents-register'),

  // 记忆库只读工具 / 健康
  toolCall: (tool, args) => ipcRenderer.invoke('tool-call', { tool, args }),
  getHealth: () => ipcRenderer.invoke('get-health'),
  refresh: () => ipcRenderer.invoke('refresh'),

  // 更新
  updateGet: () => ipcRenderer.invoke('update-get'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateOpenReleases: () => ipcRenderer.invoke('update-open-releases'),
  updateOpenRepo: () => ipcRenderer.invoke('update-open-repo'),

  // 窗口
  winMin: () => ipcRenderer.invoke('win-min'),
  winClose: () => ipcRenderer.invoke('win-close'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quit: () => ipcRenderer.invoke('quit'),

  // 事件
  on: (channel, cb) => {
    const sub = (_e, data) => cb(data);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
