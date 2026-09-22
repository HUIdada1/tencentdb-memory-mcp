// guard.js — 应用内后台守护宿主（复用 daemon/tdai-daemon.js 的同一份实现，不做二次开发）
// 职责：起 127.0.0.1:8100（recall 服务 + 控制台 API + push/health）+ 定时采集各客户端会话增量上传。
//
// 端口被占用时的处理（2026-09-22 重做）：
//   旧逻辑：EADDRINUSE → 一律标记 external 并让位，不采集上传。
//   问题：外部守护可能是**老版本**（实测本机长期跑着 v0.2.2，而应用已是 0.5.7）。
//         老版本的 /health 可能没有新接口（如 /api/backfill/inventory），
//         控制台会一直显示旧版本、新功能静默不可用，且永远不会自我纠正。
//   新逻辑：占用者健康检查探到版本 < 自身版本 → 主动接管（结束老进程 → 抢回端口 →
//         用自己的当前版本启动）。版本相同或更新 → 保持让位（尊重用户自己跑的 exe）。
//         接管动作只在本应用启动时做一次，且失败不影响应用使用。
'use strict';
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

let mod = null;          // daemon 模块（main 按 dev/prod 路径解析后传入）
let server = null;       // 内置 HTTP 服务实例
let timer = null;
let cfg = null, api = null, cache = null, state = null;
let external = false;    // 端口被外部守护进程占用
let lastError = '';
let startedAt = '';
let lastLoopAt = '';
let takeover = null;     // 最近一次接管的结果（供控制台展示）

function port() { return (mod && mod.RECALL_PORT) || 8100; }
// 版本号来自注入的 daemon 模块；selfVerOverride 仅用于测试注入（生产环境恒为 null）
let selfVerOverride = null;
function selfVer() { return selfVerOverride || (mod && mod.APP_VER) || ''; }

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
    takeover,
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
    if (e && e.code === 'EADDRINUSE') {
      // 端口被占：先判断占用者是不是"过期的自己"，是就接管；否则让位。
      const t = await tryTakeover();
      if (t && t.took) {
        try {
          server = await mod.startServer(cfg, api, cache, state);
          external = false; lastError = '';
          startedAt = new Date().toISOString();
        } catch (e2) {
          server = null; external = true;
          lastError = '接管后仍无法启动：' + ((e2 && e2.message) || e2);
        }
      } else {
        external = true; lastError = '';
      }
      if (!server) return localStatus();
    } else {
      lastError = '守护服务启动失败：' + ((e && e.message) || e);
      return localStatus();
    }
  }
  loop();
  // 定时器回调里 loop 已自带 try/catch，这里再加一层防"定时器整体失效"
  timer = setInterval(() => { loop().catch(() => { }); }, mod.SCAN_INTERVAL_MS || 120000);
  return localStatus();
}

/* ---------- 过期守护进程接管 ---------- */

// 版本比较：a > b 返回 true（逐段数值比较，忽略 v 前缀与后缀）
function gtVer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// 找出占用目标端口的进程 PID（Windows: netstat -ano；类 Unix: lsof）
function findListenPid(p) {
  return new Promise((resolve) => {
    const unix = process.platform !== 'win32';
    const cmd = unix ? 'lsof' : 'netstat';
    const args = unix ? ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'] : ['-ano'];
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(0);
      const text = String(stdout || '');
      let pid = 0;
      if (unix) {
        const m = text.trim().match(/^(\d+)/m);
        pid = m ? parseInt(m[1], 10) : 0;
      } else {
        // 只认处于 LISTENING 且本地地址端口匹配的行
        for (const line of text.split(/\r?\n/)) {
          if (!/LISTENING/i.test(line)) continue;
          const cols = line.trim().split(/\s+/);
          const local = cols[1] || '';
          const tail = local.split(':').pop();
          if (String(parseInt(tail, 10)) !== String(p)) continue;
          pid = parseInt(cols[cols.length - 1], 10) || 0;
          if (pid) break;
        }
      }
      resolve(pid || 0);
    });
  });
}

// 结束进程（先温和再强杀）
function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    const unix = process.platform !== 'win32';
    if (unix) {
      execFile('kill', ['-TERM', String(pid)], { timeout: 4000 }, () => {
        execFile('kill', ['-KILL', String(pid)], { timeout: 4000 }, () => resolve(true));
      });
      return;
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 判断占用者是否需要被接管：
//   探不到 /health（不是本工具的服务）→ 不动它，让位并提示
//   版本 < 自身 → 接管
//   版本 >= 自身 → 让位（用户自己跑的新版 exe，尊重它）
async function tryTakeover() {
  const self = selfVer();
  takeover = { checkedAt: new Date().toISOString(), self, externalVersion: '', took: false, reason: '', pid: 0 };
  let h = null;
  try { h = await health(2500); } catch (_) { h = null; }

  if (!h || h.status !== 200 || !h.json) {
    takeover.reason = '端口被非本工具进程占用，不接管（避免误杀）';
    return takeover;
  }
  const ext = String(h.json.version || '');
  takeover.externalVersion = ext;

  if (!ext) { takeover.reason = '外部守护未上报版本（疑似极老版本），保持让位'; return takeover; }
  if (!gtVer(self, ext)) {
    takeover.reason = `外部守护 v${ext} 不早于当前 v${self}，保持让位`;
    return takeover;
  }

  // 确认是过期版本 → 找 PID 并结束
  const pid = await findListenPid(port());
  takeover.pid = pid;
  if (!pid) { takeover.reason = `检测到过期外部守护 v${ext}，但未能定位进程 PID`; return takeover; }

  // 安全护栏：绝不误杀自己（本进程 / 父进程）
  if (pid === process.pid || pid === process.ppid) {
    takeover.reason = '占用者就是本进程，跳过接管';
    return takeover;
  }

  const killed = await killPid(pid);
  if (!killed) { takeover.reason = `结束过期守护 v${ext}（PID ${pid}）失败，可能权限不足`; return takeover; }
  // 等端口释放：TIME_WAIT / socket 关闭有延迟，直接重试会立刻又 EADDRINUSE
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    const busy = await new Promise((resolve) => {
      const s = http.request({ host: '127.0.0.1', port: port(), path: '/health', method: 'GET', timeout: 600 });
      s.on('response', (res) => { res.resume(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { try { s.destroy(); } catch (_) { } resolve(false); });
      s.end();
    });
    if (!busy) break;
  }
  takeover.took = true;
  takeover.reason = `已结束过期守护 v${ext}（PID ${pid}），改用当前 v${self}`;
  return takeover;
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
  takeover = null;
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

module.exports = {
  start, stop, restart, localStatus, health, push, port,
  // 接管相关：gtVer / findListenPid 供测试直接调用；takeover 供控制台读取最近一次接管结果
  gtVer, findListenPid, tryTakeover,
  get takeover() { return takeover; },
  set takeover(v) { takeover = v; },
  get selfVerOverride() { return selfVerOverride; },
  set selfVerOverride(v) { selfVerOverride = v; },
};
