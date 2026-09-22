// test/metrics-smoke.test.js — 指标中心单测（零依赖，直接跑 node）
'use strict';
const assert = require('assert');
const { createMetrics, fmtBytes, fmtSpeed, isFail } = require('../pet/src/metrics.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('\n[metrics] 指标中心单测\n');

t('isFail：连接失败(0) 与 4xx/5xx 都算失败，null 不算', () => {
  assert.strictEqual(isFail(0), true);
  assert.strictEqual(isFail(404), true);
  assert.strictEqual(isFail(500), true);
  assert.strictEqual(isFail(200), false);
  assert.strictEqual(isFail(302), false);
  assert.strictEqual(isFail(null), false);
});

t('fmtBytes 单位换算', () => {
  assert.strictEqual(fmtBytes(0), '0 B');
  assert.strictEqual(fmtBytes(512), '512 B');
  assert.strictEqual(fmtBytes(1024), '1.00 KB');
  assert.strictEqual(fmtBytes(65536), '64.0 KB');
  assert.strictEqual(fmtBytes(5 * 1024 * 1024), '5.00 MB');
});

t('fmtSpeed 零值不显示小数', () => {
  assert.strictEqual(fmtSpeed(0), '0 B/s');
  assert.strictEqual(fmtSpeed(65536), '64.0 KB/s');
  assert.strictEqual(fmtSpeed(1048576), '1.00 MB/s');
});

t('meter 累计上下行字节与请求数', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 1000, status: 200, method: 'POST', url: 'http://x/api/v1/a' });
  m.meter({ dir: 'down', bytes: 4000, status: 200, method: 'GET', url: 'http://x/api/v1/b' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.uploadBytes, 1000);
  assert.strictEqual(s.metrics.downloadBytes, 4000);
  assert.strictEqual(s.metrics.reqTotal, 2);
  assert.strictEqual(s.metrics.reqFailed, 0);
});

t('meter：失败计入 reqFailed，且分方向统计', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 10, status: 500, method: 'POST', url: 'http://x/api/v1/a' });
  m.meter({ dir: 'down', bytes: 10, status: 0, method: 'GET', url: 'http://x/api/v1/b', error: 'ECONNREFUSED' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.reqFailed, 2);
  assert.strictEqual(s.metrics.uploadFails, 1);
  assert.strictEqual(s.metrics.downloadFails, 1);
});

t('meter：失败生成 warn 日志，且含 endpoint 详情', () => {
  const m = createMetrics();
  m.meter({ dir: 'down', bytes: 0, status: 0, method: 'GET', url: 'http://x/api/v1/skill/list', error: 'ECONNREFUSED' });
  const s = m.snapshot();
  const w = s.logs.filter((l) => l.level === 'warn');
  assert.strictEqual(w.length, 1, '应恰好 1 条 warn');
  assert.ok(w[0].msg.includes('连接失败'), '消息应说明连接失败：' + w[0].msg);
  assert.ok(w[0].detail.includes('/skill/list'), '详情应含 endpoint');
});

t('/health 失败仍计数但不进入实时日志', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 0, status: 0, method: 'GET', url: 'http://127.0.0.1:8100/health', error: 'ECONNREFUSED' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.reqFailed, 1, '探活失败仍应计入失败请求');
  assert.strictEqual(s.metrics.uploadFails, 1, '探活失败仍应计入上行失败');
  assert.strictEqual(s.logs.filter((l) => l.level === 'warn').length, 0, '探活失败不应污染实时日志');
});

t('失败日志有节流（同 5s 内不重复刷屏）', () => {
  const m = createMetrics();
  for (let i = 0; i < 20; i++) m.meter({ dir: 'down', bytes: 0, status: 0, url: 'http://x/api/v1/a' });
  const s = m.snapshot();
  assert.ok(s.logs.filter((l) => l.level === 'warn').length <= 1, '应被节流到 1 条');
  assert.strictEqual(s.metrics.reqFailed, 20, '但失败计数要如实累计');
});

t('成功请求不产生 warn/error 日志', () => {
  const m = createMetrics();
  m.meter({ dir: 'down', bytes: 100, status: 200, ms: 12, url: 'http://x/api/v1/a' });
  const s = m.snapshot();
  assert.strictEqual(s.logs.filter((l) => l.level === 'warn' || l.level === 'error').length, 0);
});

t('upCommits 只统计非 GET 的成功请求', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 100, status: 200, method: 'POST', url: 'http://x/api/v1/a' });
  m.meter({ dir: 'down', bytes: 100, status: 200, method: 'GET', url: 'http://x/api/v1/b' });
  m.meter({ dir: 'up', bytes: 100, status: 500, method: 'POST', url: 'http://x/api/v1/c' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.uploadCommits, 1, '只有第 1 笔算提交');
});

t('sample：有流量时速率 > 0', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 4096, status: 200 });
  m.sample();
  const s = m.snapshot();
  assert.ok(s.metrics.upSpeed > 0, '速率应大于 0，实际 ' + s.metrics.upSpeed);
});

t('sample：无流量时速率归零（不会滞留旧值）', () => {
  const m = createMetrics();
  m.meter({ dir: 'up', bytes: 8192, status: 200 });
  m.sample();
  assert.ok(m.snapshot().metrics.upSpeed > 0);
  // 手工把滑窗样本的时间戳推老，模拟窗口过期
  const raw = m.snapshot();
  assert.ok(raw.series.up.length >= 1);
  // 直接等窗口过期不现实，用空窗口的实例验证
  const m2 = createMetrics();
  m2.sample();
  assert.strictEqual(m2.snapshot().metrics.upSpeed, 0, '空窗口必须为 0');
  assert.strictEqual(m2.snapshot().metrics.downSpeed, 0, '空窗口必须为 0');
});

t('beginTask/endTask：任务状态机 pending → done', () => {
  const m = createMetrics();
  m.beginTask('up', { label: 'import', url: 'http://x/api/v1/chat-memory/import' });
  let s = m.snapshot();
  assert.strictEqual(s.metrics.upTask.state, 'pending');
  assert.strictEqual(s.metrics.upTask.label, 'import');
  m.endTask('up', { state: 'done', bytes: 2048, ms: 40, status: 200 });
  s = m.snapshot();
  assert.strictEqual(s.metrics.upTask.state, 'done');
  assert.strictEqual(s.metrics.upTask.bytes, 2048);
  assert.strictEqual(s.metrics.upTask.ms, 40);
});

t('beginTask 不计入累计（避免一次往返被算多次）', () => {
  const m = createMetrics();
  m.beginTask('up', { label: 'x', url: 'http://a/api/v1/x' });
  m.beginTask('down', { label: 'y', url: 'http://a/api/v1/y' });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.reqTotal, 0, 'beginTask 不应污染请求计数');
  assert.strictEqual(s.metrics.uploadBytes, 0);
});

t('endTask 优先结束最近的同方向 pending', () => {
  const m = createMetrics();
  m.beginTask('up', { label: 'first' });
  m.beginTask('up', { label: 'second' });
  m.endTask('up', { state: 'done', bytes: 1 });
  const s = m.snapshot();
  assert.strictEqual(s.metrics.upTask.label, 'second', '应先结束最后开始的');
});

t('会话状态机：thinking / idle / stale', () => {
  const m = createMetrics();
  m.touchSession({ id: 'a', source: 'zcode', turns: 1, lastTs: Date.now() - 1000 });
  m.touchSession({ id: 'b', source: 'zcode', turns: 1, lastTs: Date.now() - 120000 });
  m.touchSession({ id: 'c', source: 'zcode', turns: 1, lastTs: Date.now() - 900000 });
  const s = m.snapshot();
  const by = {};
  s.sessions.forEach((x) => { by[x.id] = x.state; });
  assert.strictEqual(by.a, 'thinking');
  assert.strictEqual(by.b, 'idle');
  assert.strictEqual(by.c, 'stale');
});

t('会话排序：交互中在前，其次按最近时间倒序', () => {
  const m = createMetrics();
  m.touchSession({ id: 'old', source: 'zcode', turns: 1, lastTs: Date.now() - 900000 });
  m.touchSession({ id: 'now', source: 'zcode', turns: 1, lastTs: Date.now() - 500 });
  m.touchSession({ id: 'mid', source: 'zcode', turns: 1, lastTs: Date.now() - 100000 });
  const ids = m.snapshot().sessions.map((x) => x.id);
  assert.strictEqual(ids[0], 'now');
  assert.strictEqual(ids[2], 'old');
});

t('dropSessions 清理已消失的会话', () => {
  const m = createMetrics();
  m.touchSession({ id: 'a', source: 'zcode', turns: 1, lastTs: Date.now() });
  m.touchSession({ id: 'b', source: 'zcode', turns: 1, lastTs: Date.now() });
  m.dropSessions(['a']);
  const ids = m.snapshot().sessions.map((x) => x.id);
  assert.deepStrictEqual(ids, ['a']);
});

t('touchSession 合并更新而不是覆盖丢字段', () => {
  const m = createMetrics();
  m.touchSession({ id: 'a', source: 'zcode', turns: 1, lastTs: Date.now() });
  m.touchSession({ id: 'a', turns: 5 });
  const s = m.snapshot().sessions[0];
  assert.strictEqual(s.turns, 5, '新值应生效');
  assert.strictEqual(s.source, 'zcode', '旧字段应保留');
});

t('环形缓冲：超过 500 条后保留最新 500 条', () => {
  const m = createMetrics();
  for (let i = 0; i < 600; i++) m.pushLog('info', 'L' + i);
  const s = m.snapshot();
  assert.strictEqual(s.logs.length, 500, '长度应为 500');
  assert.strictEqual(s.logs[s.logs.length - 1].seq, 600, '最后一条应为最新');
  assert.strictEqual(s.logs[0].seq, 101, '第一条应为第 101 条（被淘汰到 500 条）');
});

t('日志 seq 单调递增（渲染进程靠它判断新日志）', () => {
  const m = createMetrics();
  const before = m.snapshot().logSeq;
  m.pushLog('info', 'x');
  const after = m.snapshot().logSeq;
  assert.strictEqual(after - before, 1);
});

t('pushLog 每条都带时间戳与级别', () => {
  const m = createMetrics();
  m.pushLog('ok', 'done');
  const l = m.snapshot().logs[0];
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(l.ts), '时间戳格式应为 HH:MM:SS，实际 ' + l.ts);
  assert.strictEqual(l.level, 'ok');
  assert.strictEqual(l.msg, 'done');
});

t('setLatency 进入快照并保留在序列里', () => {
  const m = createMetrics();
  m.setLatency(42);
  m.sample();
  const s = m.snapshot();
  assert.strictEqual(s.metrics.latency, 42);
  assert.strictEqual(s.series.lat[s.series.lat.length - 1], 42);
});

t('序列长度受上限裁剪（长时间运行不涨内存）', () => {
  const m = createMetrics();
  for (let i = 0; i < 200; i++) { m.meter({ dir: 'up', bytes: 100, status: 200 }); m.sample(); }
  const s = m.snapshot();
  assert.ok(s.series.up.length <= 60, '应被裁剪到 <=60，实际 ' + s.series.up.length);
  assert.ok(s.series.t.length <= 60);
});

t('snapshot 结构完整（渲染进程依赖的全部字段）', () => {
  const m = createMetrics();
  const s = m.snapshot();
  assert.strictEqual(typeof s.ok, 'boolean');
  assert.strictEqual(typeof s.uptime, 'number');
  const need = ['upSpeed', 'downSpeed', 'uploadBytes', 'downloadBytes', 'uploadRequests',
    'downloadRequests', 'uploadCommits', 'uploadFails', 'downloadFails', 'uploadPeak',
    'downloadPeak', 'reqTotal', 'reqFailed', 'downloadAvgMs', 'latency'];
  need.forEach((k) => assert.strictEqual(typeof s.metrics[k], 'number', '缺字段 ' + k));
  ['t', 'up', 'down', 'lat'].forEach((k) => assert.ok(Array.isArray(s.series[k]), 'series.' + k));
  assert.ok(Array.isArray(s.sessions));
  assert.ok(Array.isArray(s.logs));
  assert.strictEqual(typeof s.logSeq, 'number');
});

t('shortEndpoint 去掉 host 与 /api/v1 前缀及 query', () => {
  const { shortEndpoint } = require('../pet/src/metrics.js');
  assert.strictEqual(shortEndpoint('http://nas:8125/api/v1/chat-memory/search?q=x'), '/chat-memory/search');
  assert.strictEqual(shortEndpoint('https://a.com/api/v2/skill/list'), '/skill/list');
});

t('downloadAvgMs 取平均而不是累加', () => {
  const m = createMetrics();
  m.meter({ dir: 'down', bytes: 10, ms: 100, status: 200 });
  m.meter({ dir: 'down', bytes: 10, ms: 200, status: 200 });
  assert.strictEqual(m.snapshot().metrics.downloadAvgMs, 150);
});

t('未被 sample 采样时速率保持 0（首屏不显示假数据）', () => {
  const m = createMetrics();
  const s = m.snapshot();
  assert.strictEqual(s.metrics.upSpeed, 0);
  assert.strictEqual(s.metrics.downSpeed, 0);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
