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

// 并发保护：SCAN_INTERVAL 定时器、手动 /push、配置保存后的 restart 都可能同时进来。
// 无保护时两轮采集会并发读写同一份 cursors.json → 重复上传 / 游标互相覆盖。
let looping = false;
async function loop() {
  if (!mod || !api) return { ok: false, error: '守护模块未就绪' };
  if (looping) return { ok: false, skipped: true, error: '上一轮采集尚未结束' };
  looping = true;
  try {
    await mod.scanAndUpload(cfg, api, state);
    await mod.flushQueue(cfg, api, state);
    await cache.refresh();
    return { ok: true };
  } catch (e) {
    lastError = '采集循环异常：' + (e && e.message);
    return { ok: false, error: lastError };
  } finally {
    lastLoopAt = new Date().toISOString();
    looping = false;
  }
}

async function start(daemonModule) {
  if (server) return localStatus();
  if (daemonModule) mod = daemonModule;
  if (!mod) { lastError = '守护模块未提供'; return localStatus(); }
  // 全程兜底：loadConfig / mkApi / mkCache 任一抛错都不能让应用主进程挂掉
  try {
    cfg = mod.loadConfig();
    api = mod.mkApi(cfg);
    state = mod.mkState ? mod.mkState() : { startedAt: new Date().toISOString(), hookCalls: 0, lastPush: '', agentCreated: {}, queue: 0 };
    cache = mod.mkCache(cfg, api);
  } catch (e) {
    lastError = '守护初始化失败：' + ((e && e.message) || e);
    return localStatus();
  }
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
  // 定时器回调里 loop 已自带 try/catch，这里再加一层防"定时器整体失效"
  timer = setInterval(() => { loop().catch(() => { }); }, mod.SCAN_INTERVAL_MS || 120000);
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
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port: port(), path: pathname, method, timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          let jsonError = '';
          // 非 JSON 响应（如 /recall 的 text/plain）不能被当成"服务异常"，
          // 早先 json=null 与"连接失败"无法区分，调用方只能一律当失败。
          try { json = JSON.parse(body); } catch (e) { jsonError = e.message; }
          resolve({ status: res.statusCode, json, body, jsonError, latencyMs: Date.now() - t0 });
        });
        res.on('error', () => resolve({ status: 0, json: null, body: '', error: 'response error', latencyMs: Date.now() - t0 }));
      });
    } catch (e) {
      resolve({ status: 0, json: null, body: '', error: (e && e.message) || String(e), latencyMs: Date.now() - t0 });
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_) { } resolve({ status: 0, json: null, body: '', error: 'timeout', latencyMs: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 0, json: null, body: '', error: (e && e.code) || (e && e.message) || 'error', latencyMs: Date.now() - t0 }));
    req.end();
  });
}

async function health(timeoutMs = 4000) {
  return request('/health', 'GET', timeoutMs);
}

// 手动上传一轮：内置守护直接跑循环；外部守护走其 HTTP /push
async function push() {
  if (server) {
    const r = await loop();
    return (r && r.ok) ? { ok: true, via: 'builtin' } : { ok: false, via: 'builtin', error: (r && r.error) || '采集失败' };
  }
  const r = await request('/push', 'POST', 60000);
  if (r && r.status === 200) return { ok: true, via: 'external', result: r.json };
  // 区分"守护没跑"和"跑了但失败"，便于控制台给出可操作提示
  return { ok: false, error: r && r.error === 'timeout' ? '外部守护响应超时' : '守护未运行（后台采集不可用）', status: (r && r.status) || 0 };
}

module.exports = { start, stop, restart, localStatus, health, push, port };
