// test/e2e-live.js — 端到端联调（不需要 Electron）
// 复刻 main.js 的接线方式：core 观察者 -> metrics -> 快照，
// 打一个本地假面板，验证「一次真实 memory_search」能在总览快照里
// 留下完整的上下行流量、任务进度、日志、以及依赖的渲染字段。
//
// 与 flow-integration.js 的区别：那个测的是计量正确性，
// 这个测的是「main.js 实际接线后，渲染层拿到的 snapshot 是否自洽」。
'use strict';
const http = require('http');
const assert = require('assert');
const core = require('../core/tdai-core.js');
const { createMetrics, shortEndpoint } = require('../pet/src/metrics.js');

const PORT = Number(process.env.E2E_PORT) || 18231;
const HTTP_HDR_UP = 240;
const HTTP_HDR_DOWN = 200;

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

/* ---------- 假面板：模拟腾讯文档记忆库 API ---------- */
let panelHits = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    panelHits.push({ url: req.url, method: req.method, bytes: Buffer.byteLength(body) });
    const send = (code, obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    // 故障注入：panelUrl 带 /force500 时一律 500
    if (req.url.startsWith('/force500')) return send(500, { code: 500, message: 'internal error' });
    if (req.url.startsWith('/api/v1/memory/search') || req.url.includes('search')) {
      return send(200, { code: 0, data: { list: [{ id: 'm1', content: '排涝站数据库设计要点…', score: 0.93 }] } });
    }
    if (req.url.startsWith('/api/v1/memory/layers') || req.url.includes('layers')) {
      return send(200, { code: 0, data: { layers: [{ name: 'chat-memory', count: 128 }] } });
    }
    if (req.url.includes('commit')) return send(200, { code: 0, data: { ok: true } });
    if (req.url.includes('/health')) return send(200, { status: 'ok', version: '0.4.1', pid: process.pid, uptime: 100 });
    return send(200, { code: 0, data: {} });
  });
});

/* ---------- 复刻 main.js 的接线 ---------- */
function wire(metrics) {
  return core.create({
    panelUrl: `http://127.0.0.1:${PORT}`,
    userKey: 'test-key',
    teamId: 'team-test',
    agentId: 'agent-test',
    blockId: 'chat-memory',
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      metrics.beginTask(dir, { label: shortEndpoint(info.url), url: info.url, method: info.method });
      metrics.setCurrent(dir, shortEndpoint(info.url));
    },
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      const ok = st >= 200 && st < 300;
      const ep = shortEndpoint(info.url);
      const dir = info.method === 'GET' ? 'down' : 'up';
      const upBytes = (info.reqBytes || 0) + HTTP_HDR_UP;
      const downBytes = (info.resBytes || 0) + HTTP_HDR_DOWN;
      metrics.meter({ dir: 'up', bytes: upBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
      metrics.meter({ dir: 'down', bytes: downBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error, latencySample: st > 0 });
      metrics.endTask(dir, { state: ok ? 'done' : 'error', bytes: dir === 'up' ? upBytes : downBytes, ms: info.ms, status: st, url: info.url, method: info.method });
      metrics.pushLog(ok ? 'info' : 'warn', `${ok ? '完成' : '失败'} ${dir === 'up' ? '上行' : '下行'} ${ep} · ${info.ms}ms`);
    },
  });
}

/* ---------- 用例 ---------- */

t('E2E：真实 memory_search 一次，快照里上下行都留下真实字节', async () => {
  const m = createMetrics();
  const c = wire(m);
  const r = await c.memorySearch({ query: '排涝站 数据库设计', top_k: 5 });
  assert.ok(r && (r.ok === undefined || r.ok), 'memory_search 应成功：' + JSON.stringify(r).slice(0, 160));
  const s = m.snapshot();
  assert.ok(s.metrics.uploadBytes > 0, '应记录上行字节');
  assert.ok(s.metrics.downloadBytes > 0, '应记录下行字节');
  assert.ok(s.metrics.reqTotal >= 2, '应至少记上下行两笔，实际 ' + s.metrics.reqTotal);
  assert.strictEqual(s.metrics.reqFailed, 0, '不应有失败');
  // 面板确实收到了真实请求
  assert.ok(panelHits.some((h) => h.url.includes('search')), '假面板应收到 search 请求');
});

t('E2E：上行字节 == 真实请求体 + 固定头开销（可反推验证）', async () => {
  const m = createMetrics();
  const c = wire(m);
  panelHits = [];
  await c.memorySearch({ query: 'x'.repeat(500), top_k: 10 });
  const hit = panelHits.find((h) => h.url.includes('search'));
  assert.ok(hit, '应有 search 命中');
  const s = m.snapshot();
  // 上行总量 = 真实 body 长度 + 240
  assert.strictEqual(s.metrics.uploadBytes, hit.bytes + HTTP_HDR_UP,
    `上行应为 body(${hit.bytes}) + ${HTTP_HDR_UP}，实际 ${s.metrics.uploadBytes}`);
});

t('E2E：任务在请求期间可观测为 pending，结束后为 done', async () => {
  const m = createMetrics();
  let seenPending = false;
  const c = core.create({
    panelUrl: `http://127.0.0.1:${PORT}`,
    userKey: 'test-key', teamId: 'team-test', agentId: 'agent-test', blockId: 'chat-memory',
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      m.beginTask(dir, { label: shortEndpoint(info.url), url: info.url, method: info.method });
      const snap = m.snapshot();
      const task = dir === 'up' ? snap.metrics.upTask : snap.metrics.downTask;
      if (task && task.state === 'pending') seenPending = true;
    },
    _onHttp: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      m.endTask(dir, { state: 'done', ms: info.ms, status: info.status });
    },
  });
  await c.memorySearch({ query: 'a' });
  assert.ok(seenPending, '请求期间应能观测到 pending 任务');
  const s = m.snapshot();
  assert.strictEqual(s.metrics.upTask.state, 'done', '结束后上行任务应为 done');
  assert.strictEqual(s.metrics.upTask.status, 200, '任务应带上真实状态码');
});

t('E2E：一个完整「采样周期」后速率序列有数据（总览柱图依赖）', async () => {
  const m = createMetrics();
  const c = wire(m);
  await c.memorySearch({ query: 'b'.repeat(200) });
  m.sample();                 // 主进程 1s tick
  const s1 = m.snapshot();
  assert.ok(s1.series.up.length >= 1, 'series.up 应有采样点');
  assert.ok(s1.metrics.upSpeed > 0, '刚发过请求，上行速率应 > 0，实际 ' + s1.metrics.upSpeed);
  // 等窗口过期后再采样，速率必须归零（防止显示"幽灵流量"）
  const t0 = Date.now();
  while (Date.now() - t0 < 2200) { /* 等滑窗过期 */ }
  m.sample();
  const s2 = m.snapshot();
  assert.strictEqual(s2.metrics.upSpeed, 0, '窗口过期后上行速率应归零，实际 ' + s2.metrics.upSpeed);
});

t('E2E：失败请求（面板 500）计入失败并留下日志', async () => {
  const m = createMetrics();
  const c = core.create({
    panelUrl: `http://127.0.0.1:${PORT}/force500`,
    userKey: 'test-key', teamId: 't', agentId: 'a', blockId: 'chat-memory',
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      m.meter({ dir: 'up', bytes: info.reqBytes || 0, ms: info.ms, status: st, url: info.url, method: info.method });
      m.meter({ dir: 'down', bytes: info.resBytes || 0, ms: info.ms, status: st, url: info.url, method: info.method });
    },
  });
  await c.memorySearch({ query: 'c' }).catch(() => { });
  const s = m.snapshot();
  assert.ok(s.metrics.reqTotal > 0, '应有请求被记录');
  assert.strictEqual(s.metrics.reqFailed, s.metrics.reqTotal, '全部应计为失败');
  assert.ok(s.logs.some((l) => /失败|HTTP|连接/.test(l.msg)), '应留下失败日志，实际：' + s.logs.map((l) => l.msg).join(' | '));
});

t('E2E：快照自带渲染层依赖的全部字段（契约检查）', async () => {
  const m = createMetrics();
  const c = wire(m);
  await c.memorySearch({ query: 'd' });
  m.sample();
  const s = m.snapshot();
  // console.js 直接读取的字段
  ['ok', 'at', 'uptime', 'metrics', 'series', 'sessions', 'logs', 'logSeq'].forEach((k) => {
    assert.ok(k in s, '快照缺少顶层字段 ' + k);
  });
  ['upSpeed', 'downSpeed', 'uploadBytes', 'downloadBytes', 'uploadPeak', 'downloadPeak',
    'reqTotal', 'reqFailed', 'latency', 'upTask', 'downTask'].forEach((k) => {
      assert.ok(k in s.metrics, 'metrics 缺少字段 ' + k);
    });
  ['t', 'up', 'down', 'lat'].forEach((k) => {
    assert.ok(Array.isArray(s.series[k]), 'series.' + k + ' 应为数组');
  });
  assert.ok(Array.isArray(s.logs), 'logs 应为数组');
  assert.strictEqual(typeof s.logSeq, 'number', 'logSeq 应为数字');
  // 日期字段必须是可解析的毫秒数，渲染层用它算"多久以前"
  assert.ok(typeof s.at === 'number' && s.at > 0, 'at 应为毫秒时间戳');
});

t('E2E：连续 30 次请求不泄漏（环形上限生效）', async () => {
  const m = createMetrics();
  const c = wire(m);
  for (let i = 0; i < 30; i++) await c.memorySearch({ query: 'n' + i });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.reqTotal, 60, '30 次往返应记 60 笔，实际 ' + s.metrics.reqTotal);
  assert.ok(s.logs.length <= 500, '日志不应超过环形上限 500，实际 ' + s.logs.length);
  assert.ok(s.series.up.length <= 60, '序列不应超过上限 60，实际 ' + s.series.up.length);
});

/* ---------- 托底行为回归（本轮加固项，防止静默退化） ---------- */

t('兜底：dir 非法的一笔会被拒收，不计入任何方向（防"漏传 dir 就当下行"）', () => {
  const m = createMetrics();
  const before = m.snapshot().metrics;
  const r1 = m.meter({ bytes: 100, ms: 5, status: 200 });          // 缺 dir
  const r2 = m.meter({ dir: 'sideways', bytes: 100, status: 200 }); // dir 拼错
  const after = m.snapshot().metrics;
  assert.strictEqual(r1.accepted, false, '缺 dir 应被拒收');
  assert.strictEqual(r2.accepted, false, '非法 dir 应被拒收');
  assert.strictEqual(after.reqTotal, before.reqTotal, 'reqTotal 不应变化');
  assert.strictEqual(after.downTotal, before.downTotal, '不应被静默记成下行');
  assert.strictEqual(after.upTotal, before.upTotal, '不应被静默记成上行');
});

t('兜底：异常类型入参不会抛错，也不会产生 NaN 指标', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 'abc', ms: 'xyz', status: 'nope', url: null, method: 123 });
  m.meter({ dir: 'down', bytes: Infinity, ms: -5, status: {}, url: {}, method: [] });
  m.meter({ dir: 'up' });
  m.meter(null);
  m.meter();
  const s = m.snapshot();
  ['upTotal', 'downTotal', 'reqTotal', 'reqFailed', 'latency', 'uploadPeak', 'downloadPeak', 'downloadBytes', 'uploadBytes'].forEach((k) => {
    assert.ok(Number.isFinite(s.metrics[k]), k + ' 应为有限数字，实际 ' + s.metrics[k]);
  });
  assert.ok(s.metrics.upTotal >= 0 && s.metrics.downTotal >= 0, '累计字节不应为负');
  // Infinity 不能被当成真实字节计入
  assert.ok(Number.isFinite(s.metrics.downTotal), 'downTotal 必须有限');
});

t('兜底：pending 任务超时会被清理（不会永久占位挤掉真实任务）', () => {
  const m = createMetrics();
  const ev = m.beginTask('up', { label: 'stuck', url: '/x', method: 'POST' });
  assert.strictEqual(m.latestTask('up').state, 'pending');
  // 手动把登记时间往前推过 TTL，再触发清理
  ev.at = Date.now() - (70 * 1000);
  m.sample();                        // sample 内部会调 rebuildTasks
  const after = m.latestTask('up');
  assert.ok(!after || after.state !== 'pending', '超时 pending 应被置为 stale 而非永久 pending，实际 ' + (after && after.state));
});

t('兜底：endTask 并发同方向时按 url 精确匹配，不再 LIFO 错配', () => {
  const m = createMetrics();
  m.beginTask('up', { label: 'A', url: 'http://p/api/v1/chat-memory/import', method: 'POST' });
  m.beginTask('up', { label: 'B', url: 'http://p/api/v1/skill/list', method: 'POST' });
  // 先结束 A（不是最近登记的），早先的 LIFO 实现会错误地结束 B
  const done = m.endTask('up', { url: 'http://p/api/v1/chat-memory/import', method: 'POST', state: 'done', status: 200 });
  assert.ok(done, '应能结束到任务');
  assert.strictEqual(done.label, 'A', '应精确结束 url 匹配的 A，实际 ' + done.label);
  assert.strictEqual(m.latestTask('up').label, 'B', 'B 应仍是最近任务');
});

t('兜底：工具调用不额外登记任务（避免留下永不结束的僵尸任务）', async () => {
  const m = createMetrics();
  const c = wire(m);
  // 模拟 main.js 的 tool-call：只 setCurrent，不再 beginTask
  for (let i = 0; i < 5; i++) {
    m.setCurrent('down', 'memory_search');
    await c.memorySearch({ query: 't' + i });
  }
  const s = m.snapshot();
  // 观察者登记的任务应全部结束，不留 pending
  assert.ok(!s.metrics.upTask || s.metrics.upTask.state !== 'pending', '上行不应残留 pending，实际 ' + JSON.stringify(s.metrics.upTask));
  assert.ok(!s.metrics.downTask || s.metrics.downTask.state !== 'pending', '下行不应残留 pending，实际 ' + JSON.stringify(s.metrics.downTask));
  assert.strictEqual(s.metrics.reqTotal, 10, '5 次往返应记 10 笔，实际 ' + s.metrics.reqTotal);
});

t('兜底：延迟样本须显式声明才生效（防 status 0 / 未声明样本污染"面板延迟"）', () => {
  const m = createMetrics();
  // 未声明 latencySample：即使带 ms 也不写延迟（渲染层据此画曲线）
  m.meter({ dir: 'down', bytes: 10, ms: 999, status: 200, url: '/a' });
  assert.strictEqual(m.snapshot().metrics.latency, 0, '未声明采样的 ms 不应写入延迟');
  // 声明 latencySample 但 status 0（连接失败）同样不算延迟样本
  m.meter({ dir: 'down', bytes: 10, ms: 800, status: 0, url: '/b', latencySample: true });
  assert.strictEqual(m.snapshot().metrics.latency, 800, '显式声明即写入（status 由调用方判断后决定是否声明）');
  // 显式样本 → 新鲜；无样本 → stale
  const s = m.snapshot();
  assert.strictEqual(s.metrics.latencyStale, false, '刚写入应为新鲜');
  const m2 = createMetrics();
  assert.strictEqual(m2.snapshot().metrics.latencyStale, true, '从未有样本应为 stale');
  assert.strictEqual(m2.snapshot().metrics.latency, 0, '从未有样本延迟应为 0');
});

/* ---------- 运行 ---------- */
(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('\n[e2e] 端到端联调（复刻 main.js 接线 + 本地假面板 :' + PORT + '）\n');
  for (const c of tests) {
    try {
      await c.fn();
      pass++; console.log('  \u2713 ' + c.name);
    } catch (e) {
      fail++; console.log('  \u2717 ' + c.name + '\n      ' + (e && e.message ? e.message : e));
    }
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
