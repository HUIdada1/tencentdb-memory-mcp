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
  guardSet: (enabled) => ipcRenderer.invoke('guard-set', enabled),
  backfillStart: (opts) => ipcRenderer.invoke('backfill-start', opts),
  backfillStatus: () => ipcRenderer.invoke('backfill-status'),

  // Agent 接入
  agentsStatus: () => ipcRenderer.invoke('agents-status'),
  agentsRegister: () => ipcRenderer.invoke('agents-register'),
  agentsToggle: (key, enable) => ipcRenderer.invoke('agents-toggle', { key, enable }),
  recallSet: (v) => ipcRenderer.invoke('recall-set', v),
  logExport: (text, suggestedName) => ipcRenderer.invoke('log-export', { text, suggestedName }),

  // 记忆库只读工具 / 健康
  toolCall: (tool, args) => ipcRenderer.invoke('tool-call', { tool, args }),
  getHealth: () => ipcRenderer.invoke('get-health'),
  refresh: () => ipcRenderer.invoke('refresh'),

  // 实时监控
  metricsGet: () => ipcRenderer.invoke('metrics-get'),
  sessionsScan: (opts) => ipcRenderer.invoke('sessions-scan', opts),
  cursorStats: () => ipcRenderer.invoke('cursor-stats'),
  daemonPing: () => ipcRenderer.invoke('daemon-ping'),
  copyText: (text) => ipcRenderer.invoke('clipboard-write', text),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),

  // 渲染进程侧被动流量上报（由下面的脚本级拦截调用）
  reportFlow: (ev) => ipcRenderer.send('flow-passive', ev),

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

/* ---------- 渲染进程侧被动流量计量 ----------
 * 页面里任何 fetch/XHR 都会经过这里，从而把「渲染进程发起的请求」也计入总览流量。
 * 只上报语义（URL/方法/状态/耗时），字节数由主进程按 content-length 补；
 * 失败绝不影响业务请求（全部包在 try/catch 里）。
 */

function classify(method, url) {
  const m = String(method || 'GET').toUpperCase();
  const u = String(url || '');
  if (m === 'GET' || m === 'HEAD') return 'down';
  // POST 里的**纯读**端点按下行语义计（检索/列表/读取不产生写入流量）
  // 注意正则要锚定路径段，早先 /get/i 会误伤 /forget、/budget 之类的写入端点。
  try {
    const p = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (/\/(search|recall|query|list|get|read|layers|assets|status|health)(\/|$)/i.test(p)) return 'down';
  } catch (_) { }
  return 'up';
}

function report(ev) {
  // 只上报白名单字段：跨进程边界的对象越简单越安全（主进程侧仍会再校验一次）
  try {
    ipcRenderer.send('flow-passive', {
      dir: ev.dir === 'up' ? 'up' : 'down',
      url: String(ev.url || '').slice(0, 512),
      method: String(ev.method || '').slice(0, 16),
      status: Number.isFinite(Number(ev.status)) ? Number(ev.status) : undefined,
      ms: Number.isFinite(Number(ev.ms)) ? Number(ev.ms) : undefined,
      bytes: Number.isFinite(Number(ev.bytes)) ? Math.max(0, Number(ev.bytes)) : 0,
      error: ev.error == null ? undefined : String(ev.error).slice(0, 200),
    });
  } catch (_) { }
}

/* ---------- 渲染进程侧被动流量计量（IIFE 包裹：不向页面泄漏任何绑定） ---------- */
(function () {

// fetch
try {
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const t0 = Date.now();
      let bodyLen = 0;
      try {
        const b = init && init.body;
        if (typeof b === 'string') bodyLen = new Blob([b]).size;
        else if (b && typeof b.byteLength === 'number') bodyLen = b.byteLength;
        else if (b && typeof b.size === 'number') bodyLen = b.size;
      } catch (_) { }
      let p;
      try { p = origFetch.apply(this, arguments); } catch (e) { throw e; }  // 同步抛出（如非法 URL）原样透传
      return Promise.resolve(p).then((res) => {
        let resLen = 0;
        try { resLen = Number(res.headers.get('content-length')) || 0; } catch (_) { }
        report({ dir: classify(method, url), url, method, status: res && res.status, ms: Date.now() - t0, bytes: bodyLen + resLen });
        return res;
      }, (e) => {
        report({ dir: classify(method, url), url, method, status: 0, ms: Date.now() - t0, bytes: bodyLen, error: (e && e.message) || 'network' });
        throw e;   // 业务错误必须原样抛回，绝不能被计量逻辑吃掉
      });
    };
  }
} catch (_) { }

// XMLHttpRequest
try {
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__td = { method, url, t0: 0 };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const d = this.__td || (this.__td = { method: 'GET', url: '' });
    d.t0 = Date.now();
    let bodyLen = 0;
    try { if (typeof body === 'string') bodyLen = new Blob([body]).size; } catch (_) { }
    try {
      this.addEventListener('loadend', () => {
        try {
          let resLen = 0;
          try { resLen = Number(this.getResponseHeader('content-length')) || 0; } catch (_) { }
          if (!resLen && this.responseText) resLen = this.responseText.length;
          report({
            dir: classify(d.method, d.url), url: d.url, method: d.method,
            status: this.status, ms: Date.now() - d.t0, bytes: bodyLen + resLen,
            error: this.status === 0 ? 'network' : undefined,
          });
        } catch (_) { }   // 读取 responseText（responseType 非 text 时会抛）失败不影响业务
      });
    } catch (_) { }
    return XS.apply(this, arguments);
  };
} catch (_) { }

})();
