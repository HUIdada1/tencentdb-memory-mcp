// guard.js — 应用内后台守护宿主（复用 daemon/tdai-daemon.js 的同一份实现，不做二次开发）
// 职责：起 127.0.0.1:8100（recall 服务 + 控制台 API + push/health）+ 定时采集各客户端会话增量上传。
// 降级：端口已被占用（本机另跑了 SEA daemon exe）时不做采集上传，避免两个进程竞争游标重复上传，
//       仅标记为 external（由外部守护提供服务），界面据此提示。
'use strict';
const fs = require('fs');
const http = require('http');

let mod = null;          // daemon 模块（main 按 dev/prod 路径解析后传入）
let server = null;       // 内置 HTTP 服务实例
let timer = null;
let cfg = null, api = null, cache = null, state = null;
let external = false;    // 端口被外部守护进程占用
let lastError = '';
let startedAt = '';
let lastLoopAt = '';

function port() { return (mod && mod.RECALL_PORT) || 8100; }

function localStatus() {
  let queueLen = 0;
  try { queueLen = mod ? fs.readdirSync(mod.QUEUE_DIR).length : 0; } catch (_) { }
  return {
    running: !!server,
    external,
    port: port(),
    startedAt,
    lastLoopAt,
    lastError,
    queueLen,
    version: mod ? mod.APP_VER : '',
  };
}

async function loop() {
  if (!mod || !api) return;
  try {
    await mod.scanAndUpload(cfg, api, state);
    await mod.flushQueue(cfg, api, state);
    await cache.refresh();
  } catch (e) {
    lastError = '采集循环异常：' + (e && e.message);
  } finally {
    lastLoopAt = new Date().toISOString();
  }
}

async function start(daemonModule) {
  if (server) return localStatus();
  if (daemonModule) mod = daemonModule;
  if (!mod) { lastError = '守护模块未提供'; return localStatus(); }
  cfg = mod.loadConfig();
  api = mod.mkApi(cfg);
  state = mod.mkState();
  cache = mod.mkCache(cfg, api);
  try {
    server = await mod.startServer(cfg, api, cache, state);
    external = false;
    lastError = '';
    startedAt = new Date().toISOString();
  } catch (e) {
    server = null;
    if (e && e.code === 'EADDRINUSE') { external = true; lastError = ''; return localStatus(); }
    lastError = '守护服务启动失败：' + ((e && e.message) || e);
    return localStatus();
  }
  loop();
  timer = setInterval(loop, mod.SCAN_INTERVAL_MS || 120000);
  return localStatus();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (server) { try { server.close(); } catch (_) { } server = null; }
  startedAt = '';
}

// 配置保存后重启：daemon 模块的 cfg 是启动快照，换配置必须重建服务
async function restart(daemonModule) {
  stop();
  external = false;
  return start(daemonModule);
}

/* ---------- 服务探针（内置或外部守护都能查，答案一致） ---------- */

function request(pathname, method = 'GET', timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: port(), path: pathname, method, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { }
        resolve({ status: res.statusCode, json, latencyMs: Date.now() - t0 });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function health(timeoutMs = 4000) {
  return request('/health', 'GET', timeoutMs);
}

// 手动上传一轮：内置守护直接跑循环；外部守护走其 HTTP /push
async function push() {
  if (server) { await loop(); return { ok: true, via: 'builtin' }; }
  const r = await request('/push', 'POST', 60000);
  if (r && r.status === 200) return { ok: true, via: 'external', result: r.json };
  return { ok: false, error: '守护未运行（后台采集不可用）' };
}

module.exports = { start, stop, restart, localStatus, health, push, port };
