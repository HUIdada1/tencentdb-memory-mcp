// test/flow-integration.js — 流量计量链路集成测试
// 起一个本地假面板，让真实的 core（带 _onHttp 观察者）去打它，
// 验证：真实字节计量 / 失败归类 / 任务进度 / 观察者缺省透明。
'use strict';
const http = require('http');
const assert = require('assert');
const path = require('path');

const fs = require('fs');

const core = require('../core/tdai-core.js');
const { createMetrics } = require('../pet/src/metrics.js');

const PANEL_PORT = Number(process.env.TEST_PANEL_PORT) || 18225;
let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

/* ---------- 假面板 ---------- */
let mode = 'ok';
let lastBody = '';
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastBody = Buffer.concat(chunks).toString('utf8');
    if (mode === 'ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { items: [{ content: '命中记忆' }] } }));
    } else if (mode === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    } else if (mode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    }
  });
});

/* ---------- 构造 core ----------
 * 注意：core.create() 的 overrides 里 **没有 cfgPath** —— 配置文件路径是模块常量
 * （~/.zcode/tdai-mcp.json），不受 overrides 影响。所以测试必须直接覆盖
 * panelUrl / userKey / teamId / agentId / blockId 这几个字段，
 * 否则请求会打到用户真实的记忆库面板上（曾踩过这个坑）。
 */
function testCoreCfg(extra) {
  return Object.assign({
    panelUrl: `http://127.0.0.1:${PANEL_PORT}`,
    userKey: 'sk-test-key',
    teamId: 'team-test',
    agentId: 'agt-test',
    blockId: 'chat-memory',    // memorySearch 需要 blockId，否则在发 HTTP 前就返回
  }, extra || {});
}

function mkCore(metrics, extra) {
  return core.create(Object.assign(testCoreCfg(extra), {
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      metrics.beginTask(dir, { label: info.url, url: info.url, method: info.method });
    },
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      const ok = st >= 200 && st < 300;
      const dir = info.method === 'GET' ? 'down' : 'up';
      const upBytes = (info.reqBytes || 0) + 240;
      const downBytes = (info.resBytes || 0) + 200;
      metrics.meter({ dir: 'up', bytes: upBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
      metrics.meter({ dir: 'down', bytes: downBytes, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
      metrics.endTask(dir, { state: ok ? 'done' : 'error', bytes: dir === 'up' ? upBytes : downBytes, ms: info.ms, status: st });
    },
  }));
}

/* ---------- 用例 ---------- */

t('成功请求：上下行都按真实字节计量', async () => {
  const m = createMetrics();
  const c = mkCore(m);
  await c.memorySearch({ query: '排涝站 数据库设计', top_k: 5 });
  const s = m.snapshot();
  assert.ok(s.metrics.uploadBytes > 240, '上行应含请求体 + 头开销，实际 ' + s.metrics.uploadBytes);
  assert.ok(s.metrics.downloadBytes > 200, '下行应含响应体 + 头开销，实际 ' + s.metrics.downloadBytes);
  assert.strictEqual(s.metrics.reqTotal, 2, '一次往返记上下行各一笔');
  assert.strictEqual(s.metrics.reqFailed, 0);
});

t('上行字节与真实请求体长度一致（含固定开销 240）', async () => {
  const m = createMetrics();
  const c = mkCore(m);
  let observedReqBytes = 0;
  const c2 = core.create(Object.assign(testCoreCfg(), {
    _onHttp: (info) => {
      observedReqBytes = info.reqBytes;
      m.meter({ dir: 'up', bytes: (info.reqBytes || 0) + 240, status: info.status, url: info.url, method: info.method });
    },
  }));
  lastBody = '';
  await c2.memorySearch({ query: 'abc', top_k: 5 });
  await new Promise((r) => setTimeout(r, 60));   // 等假面板写完 lastBody
  const actualBody = Buffer.byteLength(lastBody, 'utf8');
  assert.ok(actualBody > 0, '假面板应收到非空请求体');
  assert.strictEqual(observedReqBytes, actualBody,
    `core 报出的 reqBytes(${observedReqBytes}) 应等于面板实收(${actualBody})`);
  assert.strictEqual(m.snapshot().metrics.uploadBytes, actualBody + 240,
    `上行应为 请求体 ${actualBody} + 240`);
});

t('面板不可达（连接失败）：计为失败并留下 warn 日志', async () => {
  const m = createMetrics();
  let warned = false;
  // 指向一个没人监听的端口（1 端口不可能是面板）
  const c = core.create(Object.assign(testCoreCfg({ panelUrl: 'http://127.0.0.1:1' }), {
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      if (st === 0 || st >= 400) { warned = true; m.pushLog('warn', '连接失败 · ' + info.url); }
      m.meter({ dir: 'down', bytes: (info.resBytes || 0) + 200, ms: info.ms, status: st, url: info.url, method: info.method, error: info.error });
    },
  }));
  await c.memorySearch({ query: 'x' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.reqFailed, 1, '连接失败必须计入失败');
  assert.ok(warned, '应触发连接失败告警');
  assert.ok(s.logs.some((l) => l.level === 'warn' && l.msg.includes('连接失败')),
    '应留下连接失败 warn 日志，实际：' + JSON.stringify(s.logs.map((l) => l.msg)));
});

t('HTTP 500：计为失败，不污染成功计数', async () => {
  mode = '500';
  try {
    const m = createMetrics();
    const c = mkCore(m);
    await c.memorySearch({ query: 'x' });
    const s = m.snapshot();
    assert.strictEqual(s.metrics.reqFailed, 2, '上下行各一笔失败');
    assert.strictEqual(s.metrics.uploadCommits, 0, '失败不应算作提交');
  } finally { mode = 'ok'; }
});

t('HTTP 401：计为失败', async () => {
  mode = '401';
  try {
    const m = createMetrics();
    const c = mkCore(m);
    await c.memorySearch({ query: 'x' });
    assert.strictEqual(m.snapshot().metrics.reqFailed, 2);
  } finally { mode = 'ok'; }
});

t('任务进度：请求期间 pending，结束后 done', async () => {
  const m = createMetrics();
  const c = mkCore(m);
  // memorySearch 是 POST —— _onHttpStart 会把它登记为「上行」任务。
  // 用一个手动拦截的 metrics 包装，确保在 begin/end 之间能观测到 pending。
  let midUp = null;
  const mProbe = Object.assign(Object.create(m), {
    beginTask: (dir, o) => { const ev = m.beginTask(dir, o); mProbe._last = ev; return ev; },
  });
  const c2 = core.create(Object.assign(testCoreCfg(), {
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      const ev = mProbe.beginTask(dir, { label: info.url, url: info.url, method: info.method });
      // 立刻快照：此刻任务必为 pending
      midUp = m.snapshot().metrics.upTask;
      assert.strictEqual(ev.state, 'pending', 'beginTask 后应立即为 pending');
    },
    _onHttp: (info) => {
      const st = info.status == null ? 0 : info.status;
      const ok = st >= 200 && st < 300;
      const dir = info.method === 'GET' ? 'down' : 'up';
      m.meter({ dir: 'up', bytes: (info.reqBytes || 0) + 240, ms: info.ms, status: st, url: info.url, method: info.method });
      m.meter({ dir: 'down', bytes: (info.resBytes || 0) + 200, ms: info.ms, status: st, url: info.url, method: info.method });
      m.endTask(dir, { state: ok ? 'done' : 'error', bytes: 0, ms: info.ms, status: st });
    },
  }));
  await c2.memorySearch({ query: 'x' });
  assert.ok(midUp, '请求期间应有进行中的上行任务（POST → up 方向）');
  assert.strictEqual(midUp.state, 'pending', '请求期间任务应为 pending');
  const after = m.snapshot().metrics.upTask;
  assert.strictEqual(after.state, 'done', '请求结束后任务应为 done');
  assert.strictEqual(after.status, 200);
  // GET 方向（下载任务）同样要能观测到 pending
  const c3 = mkCore(m);
  let midDown = null;
  const m2 = createMetrics();
  const c4 = core.create(Object.assign(testCoreCfg(), {
    _onHttpStart: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      m2.beginTask(dir, { label: info.url, url: info.url, method: info.method });
      midDown = m2.snapshot().metrics.downTask;
    },
    _onHttp: (info) => {
      const dir = info.method === 'GET' ? 'down' : 'up';
      m2.endTask(dir, { state: 'done' });
    },
  }));
  await c4.memorySearch({ query: 'y' }); // 仍为 POST，downTask 不该被占用
  assert.strictEqual(midDown, null, 'POST 不应登记下行任务');
  assert.ok(c3, '保持 mkCore 可用');
});

t('多次请求累计（总览"累计上传/下载"依赖）', async () => {
  const m = createMetrics();
  const c = mkCore(m);
  const first = (await c.memorySearch({ query: 'a' }), m.snapshot().metrics.uploadBytes);
  await c.memorySearch({ query: 'b' });
  await c.memorySearch({ query: 'c' });
  const s = m.snapshot();
  assert.ok(s.metrics.uploadBytes > first, '累计应随请求增长');
  assert.strictEqual(s.metrics.reqTotal, 6, '3 次往返 × 2 方向');
  assert.ok(s.metrics.downloadAvgMs >= 0);
});

t('观察者缺省时不影响 core 正常调用（对既有调用方透明）', async () => {
  const c = core.create(testCoreCfg());   // 不传观察者
  const r = await c.memorySearch({ query: 'x' });
  assert.strictEqual(r.ok, true, '缺省应照常工作：' + JSON.stringify(r));
});

/* ---------- 跑 ---------- */
(async () => {
  console.log('\n[flow] 流量计量链路集成测试\n');
  await new Promise((r) => server.listen(PANEL_PORT, '127.0.0.1', r));
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
  }
  server.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
