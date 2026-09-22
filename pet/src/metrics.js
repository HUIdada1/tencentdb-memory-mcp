// metrics.js — 实时指标中心（主进程侧，零依赖）
// 职责：汇聚真实 HTTP 往返（由 core 的 _onHttp/_onHttpStart 观察者喂入）→
//       维护滑窗速率、累计量、环形日志、会话状态 → 供 1s 心跳推送给渲染进程。
// 设计要点：
//   1. 字节数是真实 socket 字节（reqBytes/resBytes 由 core 用 Buffer.byteLength 算出），不是估算。
//   2. 日志用环形缓冲，上限 RING_MAX，长时间运行不涨内存。
//   3. 速率用滑动窗口 + 实际窗口跨度归一；窗口无样本时强制归零（否则会一直显示旧值）。
'use strict';

const RING_MAX = 500;            // 日志环容量
const SERIES_MAX = 60;           // 曲线/柱状图保留的采样点数
const SPEED_WINDOW_MS = 2000;    // 速率滑窗
const FLOW_ACC_MAX = 60;         // 进行中流量事件上限
const TASK_HOLD_MS = 2500;       // 任务结束后保留展示多久
const TASK_PENDING_TTL_MS = 60 * 1000;   // 兜底：pending 任务最长存活多久（防泄漏）
const FAIL_LOG_THROTTLE_MS = 5000;
const LATENCY_TTL_MS = 30 * 1000;        // 延迟指标多久无新样本即视为过期归零

const SESSION_THINKING_MS = 15 * 1000;    // 15s 内有交互 → 交互中
const SESSION_IDLE_MS = 3 * 60 * 1000;    // 3min 内 → 空闲

function nowMs() { return Date.now(); }

// 防御性取值：任何外部喂进来的东西都可能不是预期类型（渲染进程上报、上游口径变化）
function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// 连接失败（status 0）也必须算失败——面板挂掉时这恰恰是最该看见的信息
function isFail(status) {
  if (status == null) return false;
  return status === 0 || status >= 400;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + u[i];
}

function fmtSpeed(n) {
  n = Number(n) || 0;
  if (n <= 0) return '0 B/s';
  return fmtBytes(n) + '/s';
}

// 从 URL 提取可读端点（去掉 /api/v1 前缀与 query）
function shortEndpoint(url) {
  let s = String(url || '');
  s = s.replace(/^https?:\/\/[^/]+/, '');
  s = s.replace(/^\/api\/v\d+/, '');
  s = s.split('?')[0];
  return s || '/';
}

function createMetrics() {
  const state = {
    startedAt: nowMs(),
    upTotal: 0, downTotal: 0,
    upReqs: 0, downReqs: 0,
    upCommits: 0, upFails: 0, downFails: 0, reqFailed: 0,
    upPeak: 0, downPeak: 0,          // 峰值**速率**（bytes/s），只由 sample() 抬高
    upPeakBytes: 0, downPeakBytes: 0, // 单笔最大字节数（另一套量纲，不参与速率展示/量程）
    reqTotal: 0,
    downloadMsSum: 0, downloadMsCount: 0,
    latency: 0,
    currentUp: '', currentDown: '',
  };

  // 滑窗样本：[{t, bytes}]
  const win = { up: [], down: [] };
  const series = { t: [], up: [], down: [], lat: [] };
  const logs = [];
  const sessions = new Map();
  const flowEvents = [];
  let logSeq = 0;
  let lastFailLogAt = 0;
  let latencyAt = nowMs();       // 最近一次有效延迟样本时刻（用于过期归零）
  let currentUp = '', currentDown = '';

  function pushLog(level, msg, detail) {
    const d = new Date();
    const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      + ':' + String(d.getSeconds()).padStart(2, '0');
    // detail 兜底：调用方可能传对象/异常，避免渲染层 esc() 拿到非字符串
    const det = detail == null ? String(msg || '') : (typeof detail === 'string' ? detail : (() => { try { return JSON.stringify(detail); } catch (_) { return String(detail); } })());
    const item = { seq: ++logSeq, level: level || 'info', msg: String(msg || ''), ts, detail: det, at: nowMs() };
    logs.push(item);
    // 环形淘汰：先追加再裁剪，保证最新一条一定在
    if (logs.length > RING_MAX) logs.splice(0, logs.length - RING_MAX);
    return item;
  }

  function trimWin(arr, t) {
    while (arr.length && t - arr[0].t > SPEED_WINDOW_MS) arr.shift();
  }

  // 记一笔流量。opts: {dir, bytes, ms, status, label, url, method, state, sessionId, source}
  // 返回 {dir, bytes, failed, accepted}；accepted=false 表示入参非法被丢弃。
  function meter(opts) {
    const o = opts || {};
    // 方向必须显式声明：早先缺省按 'down' 记账，导致漏传 dir 的调用被静默算成下载。
    // 现在 dir 非法即拒收（宁可少记一笔，也不要记错一笔）。
    if (o.dir !== 'up' && o.dir !== 'down') return { dir: '', bytes: 0, failed: false, accepted: false };
    const dir = o.dir;
    const bytes = Math.max(0, num(o.bytes));
    const ms = o.ms == null ? null : Math.max(0, num(o.ms));
    const t = nowMs();

    if (dir === 'up') {
      // bytesSource:'none' = 请求根本没发出去（连接被拒/超时），**不计入流量**。
      // 早先探活失败也照记 240B"请求头开销"，守护掉线时上行累计值会凭空增长
      // （这些字节从未离开过本机），是"明明没上传却有流量"的第二个来源。
      // 请求计数与失败计数照记 —— 那才是判断"探活还通不通"所需的语义。
      const counted = o.bytesSource === 'none' ? 0 : bytes;
      state.upTotal += counted;
      state.upReqs++;
      // ⚠️ 这里记的是**单笔字节数**，量纲是 bytes；绝不能用它抬高 upPeak
      //（upPeak 的量纲是 bytes/s，只由 sample() 的速率抬高）。早先两者混用，
      // 界面「峰值速率」会把一次大请求的字节数当成速度显示（如 5MB → 显示 4.77 MB/s），
      // 而且仪表量程 ref=upPeak 被抬到 5e6，指针永远贴在 0 附近，看起来像坏了。
      if (counted > state.upPeakBytes) state.upPeakBytes = counted;
    } else {
      state.downTotal += bytes;
      state.downReqs++;
      if (bytes > state.downPeakBytes) state.downPeakBytes = bytes;
      if (ms != null) { state.downloadMsSum += ms; state.downloadMsCount++; }
    }
    state.reqTotal++;

    const failed = isFail(o.status);
    if (failed) {
      state.reqFailed++;
      if (dir === 'up') state.upFails++; else state.downFails++;
    } else if (dir === 'up' && o.method && o.method !== 'GET') {
      state.upCommits++;
    }

    win[dir].push({ t, bytes: dir === 'up' && o.bytesSource === 'none' ? 0 : bytes });
    trimWin(win[dir], t);

    // 延迟样本必须**显式声明**（latencySample: true）才写入：
    // 早先任意方向的 ms 都会覆盖 latency，且 status 0（根本没到服务端）也照写，
    // 一旦覆盖便永不失效（面板离线后 pill 仍举着旧延迟显示"已连接"）。
    // 现在语义收紧为"只有真正拿到响应的往返才算延迟样本"。
    if (ms != null && o.latencySample === true) {
      state.latency = ms;
      latencyAt = t;
    }

    // 失败日志（连接失败/4xx/5xx），做节流避免刷屏
    if (failed && t - lastFailLogAt > FAIL_LOG_THROTTLE_MS) {
      lastFailLogAt = t;
      const ep = shortEndpoint(o.url);
      const st = num(o.status);
      const how = st === 0 ? '连接失败' : 'HTTP ' + st;
      pushLog('warn', `${dir === 'up' ? '上行' : '下行'} ${how} · ${ep}`,
        `${how}\nendpoint : ${ep}\n方向     : ${dir === 'up' ? '上传' : '下载'}\n错误     : ${o.error || '—'}`);
    }
    return { dir, bytes, failed, accepted: true };
  }

  // 任务占位：只登记"正在发生"，不计入累计（避免一次往返被算 3 笔）
  function beginTask(dir, opts) {
    const o = opts || {};
    const t = nowMs();
    const ev = {
      at: t, dir: dir === 'up' ? 'up' : 'down',
      bytes: 0, label: o.label || shortEndpoint(o.url),
      url: o.url || '', method: o.method || '', status: null, ms: null,
      state: 'pending', source: o.source || '', sessionId: o.sessionId || '',
    };
    flowEvents.push(ev);
    if (flowEvents.length > FLOW_ACC_MAX) flowEvents.splice(0, flowEvents.length - FLOW_ACC_MAX);
    return ev;
  }

  // 结束最近一个同方向的 pending 任务。
  // 并发保护：同一方向可能有多笔在飞（如两个并发 memorySearch），
  // 按"最近一个 pending"结束是 LIFO，会与真实完成顺序错配。
  // 这里优先按 url+method 精确匹配，找不到再退回 LIFO，并显式返回 matched 供调用方观测。
  function endTask(dir, opts) {
    const o = opts || {};
    const want = dir === 'up' ? 'up' : 'down';
    let picked = -1;
    if (o.url) {
      for (let i = flowEvents.length - 1; i >= 0; i--) {
        const ev = flowEvents[i];
        if (ev.dir === want && ev.state === 'pending' && ev.url === o.url && (!o.method || !ev.method || ev.method === o.method)) { picked = i; break; }
      }
    }
    if (picked < 0) {
      for (let i = flowEvents.length - 1; i >= 0; i--) {
        const ev = flowEvents[i];
        if (ev.dir === want && ev.state === 'pending') { picked = i; break; }
      }
    }
    if (picked < 0) return null;
    const ev = flowEvents[picked];
    ev.state = o.state || 'done';
    ev.bytes = Math.max(0, num(o.bytes));
    ev.ms = o.ms == null ? null : Math.max(0, num(o.ms));
    ev.status = o.status == null ? null : num(o.status);
    ev.doneAt = nowMs();
    if (o.label) ev.label = o.label;
    return ev;
  }

  // 清理过期任务：
  //   - 已结束的任务保留 TASK_HOLD_MS 供展示；
  //   - **pending 任务也必须有过期机制**（否则请求异常中断后永久占位，
  //     挤掉 FLOW_ACC_MAX 名额，让真实任务无法登记）。
  function rebuildTasks() {
    const t = nowMs();
    for (let i = flowEvents.length - 1; i >= 0; i--) {
      const ev = flowEvents[i];
      if (ev.state === 'pending') {
        if (t - ev.at > TASK_PENDING_TTL_MS) { ev.state = 'stale'; ev.ms = t - ev.at; ev.doneAt = t; }
      } else if (t - ev.at > TASK_HOLD_MS) {
        flowEvents.splice(i, 1);
      }
    }
  }

  function latestTask(dir) {
    for (let i = flowEvents.length - 1; i >= 0; i--) {
      if (flowEvents[i].dir === dir) return flowEvents[i];
    }
    return null;
  }

  // 会话触达：由扫描/工具调用上报
  function touchSession(rec) {
    if (!rec || !rec.id) return;
    const prev = sessions.get(rec.id) || {};
    sessions.set(rec.id, Object.assign({}, prev, rec, { touchedAt: nowMs() }));
  }

  function dropSessions(keepIds) {
    const keep = new Set(keepIds || []);
    for (const id of Array.from(sessions.keys())) if (!keep.has(id)) sessions.delete(id);
  }

  function sessionStateOf(lastTs) {
    const age = nowMs() - (Number(lastTs) || 0);
    if (age <= SESSION_THINKING_MS) return 'thinking';
    if (age <= SESSION_IDLE_MS) return 'idle';
    return 'stale';
  }

  function listSessions() {
    const out = [];
    for (const s of sessions.values()) {
      out.push(Object.assign({}, s, { state: sessionStateOf(s.lastTs) }));
    }
    // 活跃优先，其次按最近交互倒序
    const rank = { thinking: 0, idle: 1, stale: 2 };
    out.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.lastTs - a.lastTs));
    return out;
  }

  function setCurrent(dir, label) {
    if (dir === 'up') { currentUp = label || ''; state.currentUp = currentUp; }
    else { currentDown = label || ''; state.currentDown = currentDown; }
  }

  function setLatency(ms) { state.latency = Math.max(0, num(ms)); latencyAt = nowMs(); }

  // 每秒采样：算速率、推序列
  function sample() {
    const t = nowMs();
    trimWin(win.up, t);
    trimWin(win.down, t);

    // 延迟过期归零：没有新鲜样本时不能一直举着旧值（面板离线后 pill 会误报"已连接"）
    if (state.latency > 0 && t - latencyAt > LATENCY_TTL_MS) state.latency = 0;

    function rate(arr) {
      if (!arr.length) return 0;                       // 窗口空了必须归零
      const earliest = arr[0].t;
      const span = Math.max(1, (t - earliest) / 1000); // 用窗口内最早样本算跨度
      let sum = 0;
      for (const s of arr) sum += s.bytes;
      return Math.round(sum / span);
    }
    const up = rate(win.up);
    const down = rate(win.down);
    if (up > state.upPeak) state.upPeak = up;
    if (down > state.downPeak) state.downPeak = down;

    series.t.push(t);
    series.up.push(up);
    series.down.push(down);
    series.lat.push(state.latency);
    for (const k of ['t', 'up', 'down', 'lat']) {
      if (series[k].length > SERIES_MAX) series[k].splice(0, series[k].length - SERIES_MAX);
    }
    rebuildTasks();
    return { up, down };
  }

  function snapshot(extra) {
    const upSpeed = series.up.length ? series.up[series.up.length - 1] : 0;
    const downSpeed = series.down.length ? series.down[series.down.length - 1] : 0;
    const upTask = latestTask('up');
    const downTask = latestTask('down');
    const sess = listSessions();
    // 渲染层用来判断延迟是否还可信（> LATENCY_TTL_MS 即过期，应显示"—"）
    const latencyAge = state.latency > 0 ? Math.max(0, nowMs() - latencyAt) : -1;
    return Object.assign({
      ok: true,
      at: nowMs(),
      uptime: nowMs() - state.startedAt,
      metrics: {
        upSpeed, downSpeed,
        uploadBytes: state.upTotal, downloadBytes: state.downTotal,
        // 兼容别名：早期调用方/测试用的是 upTotal/downTotal
        upTotal: state.upTotal, downTotal: state.downTotal,
        uploadRequests: state.upReqs, downloadRequests: state.downReqs,
        uploadCommits: state.upCommits, uploadFails: state.upFails, downloadFails: state.downFails,
        uploadPeak: state.upPeak, downloadPeak: state.downPeak,
        // 单笔最大字节数（量纲 bytes）：仅用于"最大单笔"这类展示，**不要**拿它当速率量程
        uploadPeakBytes: state.upPeakBytes, downloadPeakBytes: state.downPeakBytes,
        reqTotal: state.reqTotal, reqFailed: state.reqFailed,
        downloadAvgMs: state.downloadMsCount ? Math.round(state.downloadMsSum / state.downloadMsCount) : 0,
        latency: state.latency,
        latencyAge,
        latencyStale: latencyAge < 0 ? true : latencyAge > LATENCY_TTL_MS,
        currentUp, currentDown,
        upTask: upTask ? { label: upTask.label, state: upTask.state, dir: upTask.dir, bytes: upTask.bytes, ms: upTask.ms, status: upTask.status, url: upTask.url } : null,
        downTask: downTask ? { label: downTask.label, state: downTask.state, dir: downTask.dir, bytes: downTask.bytes, ms: downTask.ms, status: downTask.status, url: downTask.url } : null,
      },
      series: { t: series.t.slice(), up: series.up.slice(), down: series.down.slice(), lat: series.lat.slice() },
      sessions: sess,
      logs: logs.slice(),
      logSeq,
    }, extra || {});
  }

  return {
    state, pushLog, meter, beginTask, endTask, rebuildTasks, latestTask,
    touchSession, dropSessions, listSessions, sessionStateOf, setCurrent, setLatency,
    sample, snapshot, shortEndpoint, fmtBytes, fmtSpeed,
    RING_MAX, SERIES_MAX, LATENCY_TTL_MS,
  };
}

module.exports = { createMetrics, fmtBytes, fmtSpeed, shortEndpoint, isFail, RING_MAX, SERIES_MAX, SPEED_WINDOW_MS, LATENCY_TTL_MS, TASK_PENDING_TTL_MS };
