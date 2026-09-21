// preload.js — contextBridge 白名单
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdai', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  getHealth: () => ipcRenderer.invoke('get-health'),
  refresh: () => ipcRenderer.invoke('refresh'),
  toolCall: (tool, args) => ipcRenderer.invoke('tool-call', { tool, args }),

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
  openConsole: () => ipcRenderer.invoke('open-console'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quit: () => ipcRenderer.invoke('quit'),

  // 事件
  on: (channel, cb) => {
    const sub = (_e, data) => cb(data);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
