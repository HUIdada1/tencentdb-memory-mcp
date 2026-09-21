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
const FAIL_LOG_THROTTLE_MS = 5000;

const SESSION_THINKING_MS = 15 * 1000;    // 15s 内有交互 → 交互中
const SESSION_IDLE_MS = 3 * 60 * 1000;    // 3min 内 → 空闲

function nowMs() { return Date.now(); }

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
    upPeak: 0, downPeak: 0,
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
  let currentUp = '', currentDown = '';

  function pushLog(level, msg, detail) {
    const d = new Date();
    const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      + ':' + String(d.getSeconds()).padStart(2, '0');
    const item = { seq: ++logSeq, level: level || 'info', msg: String(msg || ''), ts, detail: detail || String(msg || ''), at: nowMs() };
    logs.push(item);
    // 环形淘汰：先追加再裁剪，保证最新一条一定在
    if (logs.length > RING_MAX) logs.splice(0, logs.length - RING_MAX);
    return item;
  }

  function trimWin(arr, t) {
    while (arr.length && t - arr[0].t > SPEED_WINDOW_MS) arr.shift();
  }

  // 记一笔流量。opts: {dir, bytes, ms, status, label, url, state, sessionId, source}
  function meter(opts) {
    const o = opts || {};
    const dir = o.dir === 'up' ? 'up' : 'down';
    const bytes = Math.max(0, Number(o.bytes) || 0);
    const t = nowMs();

    if (dir === 'up') {
      state.upTotal += bytes;
      state.upReqs++;
      if (bytes > state.upPeak) state.upPeak = bytes;
    } else {
      state.downTotal += bytes;
      state.downReqs++;
      if (bytes > state.downPeak) state.downPeak = bytes;
      if (o.ms != null) { state.downloadMsSum += o.ms; state.downloadMsCount++; }
    }
    state.reqTotal++;

    const failed = isFail(o.status);
    if (failed) {
      state.reqFailed++;
      if (dir === 'up') state.upFails++; else state.downFails++;
    } else if (dir === 'up' && o.method && o.method !== 'GET') {
      state.upCommits++;
    }

    win[dir].push({ t, bytes });
    trimWin(win[dir], t);

    if (o.ms != null) state.latency = o.ms;

    // 失败日志（连接失败/4xx/5xx），做节流避免刷屏
    if (failed && t - lastFailLogAt > FAIL_LOG_THROTTLE_MS) {
      lastFailLogAt = t;
      const ep = shortEndpoint(o.url);
      const how = o.status === 0 ? '连接失败' : 'HTTP ' + o.status;
      pushLog('warn', `${dir === 'up' ? '上行' : '下行'} ${how} · ${ep}`,
        `${how}\nendpoint : ${ep}\n方向     : ${dir === 'up' ? '上传' : '下载'}\n错误     : ${o.error || '—'}`);
    }
    return { dir, bytes, failed };
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

  // 结束最近一个同方向的 pending 任务
  function endTask(dir, opts) {
    const o = opts || {};
    for (let i = flowEvents.length - 1; i >= 0; i--) {
      const ev = flowEvents[i];
      if (ev.dir === dir && ev.state === 'pending') {
        ev.state = o.state || 'done';
        ev.bytes = Number(o.bytes) || 0;
        ev.ms = o.ms == null ? null : o.ms;
        ev.status = o.status == null ? null : o.status;
        if (o.label) ev.label = o.label;
        return ev;
      }
    }
    return null;
  }

  // 清理过期任务（只保留最近 TASK_HOLD_MS 内结束的）
  function rebuildTasks() {
    const t = nowMs();
    for (let i = flowEvents.length - 1; i >= 0; i--) {
      const ev = flowEvents[i];
      if (ev.state !== 'pending' && t - ev.at > TASK_HOLD_MS) flowEvents.splice(i, 1);
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

  function setLatency(ms) { state.latency = Number(ms) || 0; }

  // 每秒采样：算速率、推序列
  function sample() {
    const t = nowMs();
    trimWin(win.up, t);
    trimWin(win.down, t);

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
    return Object.assign({
      ok: true,
      at: nowMs(),
      uptime: nowMs() - state.startedAt,
      metrics: {
        upSpeed, downSpeed,
        uploadBytes: state.upTotal, downloadBytes: state.downTotal,
        uploadRequests: state.upReqs, downloadRequests: state.downReqs,
        uploadCommits: state.upCommits, uploadFails: state.upFails, downloadFails: state.downFails,
        uploadPeak: state.upPeak, downloadPeak: state.downPeak,
        reqTotal: state.reqTotal, reqFailed: state.reqFailed,
        downloadAvgMs: state.downloadMsCount ? Math.round(state.downloadMsSum / state.downloadMsCount) : 0,
        latency: state.latency,
        currentUp, currentDown,
        upTask: upTask ? { label: upTask.label, state: upTask.state, dir: upTask.dir, bytes: upTask.bytes, ms: upTask.ms, status: upTask.status } : null,
        downTask: downTask ? { label: downTask.label, state: downTask.state, dir: downTask.dir, bytes: downTask.bytes, ms: downTask.ms, status: downTask.status } : null,
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
    RING_MAX, SERIES_MAX,
  };
}

module.exports = { createMetrics, fmtBytes, fmtSpeed, shortEndpoint, isFail, RING_MAX, SERIES_MAX, SPEED_WINDOW_MS };
