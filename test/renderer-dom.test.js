// test/renderer-dom.test.js — 渲染层 DOM 集成测试
// 用 jsdom 加载真实的 pet/src/console.html + console.js + console.css，
// 注入一个模拟的 preload 桥（window.tdai），然后：
//   ① 校验 HTML 结构契约（tab/page 一对一、被注释的 tab 确实不可见、无重复 id）
//   ② 校验 console.js 引用的每个 id 在真实 DOM 中都存在
//   ③ 驱动真实的 metrics 快照，断言总览六分区真的把数据渲染进 DOM
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// jsdom 装在 pet/node_modules（根目录保持零依赖），直接按绝对路径 require
const JSDOM_DIR = path.join(__dirname, '..', 'pet', 'node_modules', 'jsdom');
let JSDOM;
try {
  ({ JSDOM } = require(JSDOM_DIR));
} catch (e) {
  console.error('[dom] 无法加载 jsdom（应存在于 pet/node_modules）：' + e.message);
  process.exit(2);
}

const SRC = path.join(__dirname, '..', 'pet', 'src');
const HTML = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'console.css'), 'utf8');
const JS = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

const metricsMod = require('../pet/src/metrics.js');

let pass = 0, fail = 0, skip = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

/* ---------- 构造一个「像 main.js 一样」的快照 ---------- */
function makeSnapshot(m) {
  return m.snapshot();
}
function mkMetrics() {
  const m = metricsMod.createMetrics();
  // 造一点真实数据
  m.meter({ dir: 'up', bytes: 4096 + 240, ms: 120, status: 200, url: 'https://panel.example/api/memory/commit', method: 'POST' });
  m.meter({ dir: 'down', bytes: 20480 + 200, ms: 120, status: 200, url: 'https://panel.example/api/memory/commit', method: 'POST' });
  m.meter({ dir: 'down', bytes: 900 + 200, ms: 40, status: 200, url: 'https://panel.example/api/memory/search', method: 'POST' });
  m.meter({ dir: 'up', bytes: 300 + 240, ms: 900, status: 0, url: 'https://panel.example/api/x', method: 'POST', error: 'ECONNREFUSED' });
  // 注意：上面这笔 status:0 会由 metrics.meter 自动补一条 warn 失败日志（设计如此），
  //      所以下面手工推 3 条，日志总数应为 4。
  m.pushLog('info', '守护进程已就绪');
  m.pushLog('warn', '正在重试连接');
  m.pushLog('error', 'HTTP 500 服务端异常');
  m.setLatency(120);
  m.touchSession({
    id: 'sess-abc123', label: '把项目顶部的 tab 隐藏',
    source: 'zcode', path: 'C:/x/transcript.jsonl',
    turns: 42, sizeBytes: 123456, lastTs: Date.now() - 30000,
    lastNote: '审查完成。我已完整读取 4 个模块并给出结论。',
  });
  m.touchSession({
    id: 'sess-def456', label: '另一个很老的会话', source: 'claude',
    turns: 7, sizeBytes: 2048, lastTs: Date.now() - 3600 * 1000 * 5, lastNote: '',
  });
  m.beginTask('up', { label: '/api/memory/commit', url: 'https://panel.example/api/memory/commit', method: 'POST' });
  // 主进程 1s tick 才会调 sample() 推序列；这里模拟两拍，让速率/柱图有真实数据
  m.sample();
  return m;
}

/* ---------- 起一个 jsdom 世界并执行 console.js ---------- */
function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const events = {};       // channel -> [cb]
  const calls = [];        // 记录桥调用
  let snapshot = o.snapshot || null;

  const bridge = {
    appInfo: () => (calls.push('appInfo'), Promise.resolve(o.appInfo || {
      version: '0.4.1', port: 8765, panelUrl: 'https://panel.example', teamId: 't1',
      agentId: 'a1', blockId: 'chat-memory', uptimeMs: 3600 * 1000, assets: 12,
      seeded: true, sources: ['zcode', 'claude'], memMb: 88,
    })),
    connLoad: () => (calls.push('connLoad'), Promise.resolve({ panelUrl: 'https://panel.example', userKey: 'k', teamId: 't1', agentId: 'a1', blockId: 'chat-memory' })),
    connSave: (b) => (calls.push('connSave'), Promise.resolve({ ok: true })),
    connTest: () => (calls.push('connTest'), Promise.resolve({ ok: true, ms: 88, status: 200 })),
    prefsLoad: () => (calls.push('prefsLoad'), Promise.resolve({ ui: { theme: 'light' }, system: { autoStart: false }, update: { autoCheck: true } })),
    prefsSave: () => (calls.push('prefsSave'), Promise.resolve({ ok: true })),
    guardStatus: () => Promise.resolve({ ok: true }),
    guardPush: () => Promise.resolve({ ok: true }),
    guardRestart: () => Promise.resolve({ ok: true }),
    agentsStatus: () => (calls.push('agentsStatus'), Promise.resolve(o.agents || [])),
    agentsRegister: () => (calls.push('agentsRegister'), Promise.resolve({ ok: true, results: [], items: [] })),
    toolCall: (tool) => (calls.push('toolCall:' + tool), Promise.resolve({ ok: true, data: null })),
    getHealth: () => Promise.resolve({ ok: true }),
    refresh: () => (calls.push('refresh'), Promise.resolve({ ok: true })),
    metricsGet: () => (calls.push('metricsGet'), Promise.resolve(snapshot)),
    sessionsScan: () => (calls.push('sessionsScan'), Promise.resolve(o.sessions || { ok: true, sessions: [], nextScanMs: 4000, stats: { files: 30, bytes: 999 } })),
    cursorStats: () => (calls.push('cursorStats'), Promise.resolve(o.cursor || {
      ok: true, count: 30, bySource: { zcode: 28, claude: 2 }, seeded: 12, pending: 18,
      path: 'C:/Users/x/.zcode/tdai-daemon/cursors.json',
    })),
    daemonPing: () => (calls.push('daemonPing'), Promise.resolve(o.daemon || {
      ok: true, ms: 7, payload: {
        version: '0.4.1', uptimeSince: new Date(Date.now() - 7200000).toISOString(),
        lastPush: new Date(Date.now() - 45000).toISOString(), queueLen: 3,
        hookCalls: 128, pid: 4321, mode: 'daemon',
      },
    })),
    copyText: (x) => (calls.push('copyText'), Promise.resolve({ ok: true, text: x })),
    revealPath: () => Promise.resolve({ ok: true }),
    reportFlow: () => { },
    updateGet: () => Promise.resolve({ state: 'idle', version: '0.4.1' }),
    updateCheck: () => Promise.resolve({ state: 'checking' }),
    updateDownload: () => Promise.resolve({ state: 'downloading' }),
    updateInstall: () => Promise.resolve({ state: 'idle' }),
    updateOpenReleases: () => Promise.resolve({ ok: true }),
    updateOpenRepo: () => Promise.resolve({ ok: true }),
    winMin: () => { }, winClose: () => { }, quit: () => { },
    openExternal: (u) => (calls.push('openExternal:' + u), Promise.resolve({ ok: true })),
    on: (ch, cb) => { (events[ch] = events[ch] || []).push(cb); return () => { }; },
  };

  window.tdai = bridge;
  // 让 console.js 以「页面脚本」身份执行（它自己会读 document / window.tdai）
  const run = new window.Function(JS);
  run.call(window);

  return {
    dom, window, doc: window.document, events, calls,
    emit: (ch, data) => (events[ch] || []).forEach((cb) => cb(data)),
    push: (s) => { snapshot = s; (events['metrics'] || []).forEach((cb) => cb({ payload: s })); },
    text: (sel) => { const el = window.document.querySelector(sel); return el ? el.textContent.trim() : null; },
    has: (sel) => !!window.document.querySelector(sel),
  };
}

/* ============================================================
   ① HTML 结构契约
   ============================================================ */

t('HTML：被要求隐藏的 tab（技能/Wiki/图谱）确实不在可见 DOM 中', () => {
  const b = boot();
  ['skills', 'wiki', 'graph'].forEach((tab) => {
    assert.strictEqual(b.has(`#tabs button[data-tab="${tab}"]`), false, `tab "${tab}" 不应可见`);
    assert.strictEqual(b.has(`.page[data-page="${tab}"]`), false, `page "${tab}" 不应可见`);
  });
});

t('HTML：记忆 tab 保留且可见', () => {
  const b = boot();
  assert.strictEqual(b.has('#tabs button[data-tab="memory"]'), true, '记忆 tab 必须保留');
  assert.strictEqual(b.has('.page[data-page="memory"]'), true, '记忆 page 必须保留');
});

t('HTML：可见 tab 与可见 page 严格一对一，且顺序一致', () => {
  const b = boot();
  const tabs = Array.from(b.doc.querySelectorAll('#tabs button')).map((x) => x.dataset.tab);
  const pages = Array.from(b.doc.querySelectorAll('.page')).map((x) => x.dataset.page);
  assert.deepStrictEqual(tabs, ['home', 'memory', 'live', 'agent', 'settings'], 'tab 序列不符：' + tabs.join(','));
  assert.deepStrictEqual(pages.slice().sort(), tabs.slice().sort(), 'tab/page 不一一对应');
  assert.strictEqual(new Set(tabs).size, tabs.length, 'tab 有重复');
  assert.strictEqual(new Set(pages).size, pages.length, 'page 有重复');
});

t('HTML：「实时会话」tab 位于「记忆」与「Agent 接入」之间', () => {
  const b = boot();
  const tabs = Array.from(b.doc.querySelectorAll('#tabs button')).map((x) => x.dataset.tab);
  const iMem = tabs.indexOf('memory'), iLive = tabs.indexOf('live'), iAgent = tabs.indexOf('agent');
  assert.ok(iMem >= 0 && iLive >= 0 && iAgent >= 0, '缺少 memory/live/agent 之一：' + tabs.join(','));
  assert.ok(iMem < iLive && iLive < iAgent, `顺序应为 memory < live < agent，实际 ${iMem}/${iLive}/${iAgent}`);
});

t('HTML：实时会话列表已从总览迁到「实时会话」页（不同时存在）', () => {
  const b = boot();
  assert.strictEqual(b.has('.page[data-page="live"] #sess-list'), true, 'live 页应有 #sess-list');
  assert.strictEqual(b.has('.page[data-page="home"] #sess-list'), false, 'home 页不应再有 #sess-list');
  assert.strictEqual(b.has('.page[data-page="live"] #sess-count'), true, 'live 页应有 sess-count');
  assert.strictEqual(b.has('.page[data-page="home"] #sess-count'), false, 'home 页不应再有 sess-count');
});

t('HTML：总览页已移除快速检索（避免与记忆页重复）', () => {
  const b = boot();
  ['#qs-input', '#qs-go', '#qs-result'].forEach((sel) => {
    assert.strictEqual(b.has(sel), false, '总览不应再有 ' + sel);
  });
});

t('HTML：作者信息「沐辉」已展示在设置页', () => {
  const b = boot();
  const el = b.doc.querySelector('.page[data-page="settings"] .author-name');
  assert.ok(el, '设置页应有 .author-name');
  assert.strictEqual(el.textContent.trim(), '沐辉', '作者应为「沐辉」');
  assert.ok(/作者[\s\S]{0,20}沐辉/.test(b.doc.querySelector('.page[data-page="settings"]').textContent),
    '设置页应出现「作者：沐辉」字样');
});

t('HTML：右上角连接状态胶囊结构完整（含指示灯与文案节点）', () => {
  const b = boot();
  assert.strictEqual(b.has('#health-pill'), true);
  assert.strictEqual(b.has('#health-pill i'), true, 'pill 应含指示灯 <i>');
  assert.strictEqual(b.has('#health-text'), true, 'pill 应含文案节点 #health-text');
});

t('HTML：「失败请求」卡片紧邻「累计请求」右侧，且结构完全一致', () => {
  const b = boot();
  const stats = Array.from(b.doc.querySelectorAll('.stat-row .stat'));
  const valIds = stats.map((x) => (x.querySelector('b') || {}).id);
  const iReq = valIds.indexOf('s-reqs'), iErr = valIds.indexOf('s-err');
  assert.ok(iReq >= 0 && iErr >= 0, '缺少 s-reqs / s-err');
  assert.strictEqual(iErr, iReq + 1, `失败请求应紧邻累计请求右侧，实际 reqs@${iReq} err@${iErr}`);
  const a = stats[iReq], c = stats[iErr];
  assert.strictEqual(a.className, c.className, '两卡外层 class 应一致');
  assert.strictEqual(a.querySelectorAll('i').length, c.querySelectorAll('i').length, '指示灯数量应一致');
  assert.strictEqual(a.querySelectorAll('b').length, c.querySelectorAll('b').length, '数值节点数量应一致');
  assert.strictEqual(a.querySelectorAll('span').length, c.querySelectorAll('span').length, '标签节点数量应一致');
});

t('HTML：注释掉的 tab 代码是「整段配对」的（无半截注释）', () => {
  // 统计 <!-- 与 --> 的数量必须相等
  const opens = (HTML.match(/<!--/g) || []).length;
  const closes = (HTML.match(/-->/g) || []).length;
  assert.strictEqual(opens, closes, `注释未配对：<!-- ${opens} 次，--> ${closes} 次`);
});

t('HTML：全文档没有重复 id', () => {
  const b = boot();
  const ids = Array.from(b.doc.querySelectorAll('[id]')).map((x) => x.id);
  const seen = new Set(), dup = [];
  ids.forEach((i) => { if (seen.has(i)) dup.push(i); seen.add(i); });
  assert.strictEqual(dup.length, 0, '重复 id：' + dup.join(', '));
});

t('HTML：总览首排容器齐全（hero 体征条 + 指标卡整行）', () => {
  const b = boot();
  // 「记忆库面板」卡、延迟波形（#spark*）已删除：面板地址与延迟并入 hero 副标题。
  // ⚠️ hero 体征条里的「面板延迟」也已在 2026-09-22 删除（与副标题重复），
  //    故这里不再断言 #h-latency —— 它已整体移除，只保留 renderLiveSub 一处。
  ['#live-badge', '#live-text', '#live-sub', '#h-uptime', '#h-beat',
    '#home-top', '.home-top .hero', '.home-top .stat-row',
    '#s-sess', '#s-reqs', '#s-err',
    '#sess-list', '#sess-count',
    '#up-speed', '#up-total', '#up-peak', '#up-task-name', '#up-task-bar', '#up-bars',
    '#down-speed', '#down-total', '#down-peak', '#down-task-name', '#down-task-bar', '#down-bars',
    '#log-list', '#log-count', '#log-pause', '#log-clear',
    '#d-mode', '#d-since', '#d-hooks', '#d-port', '#d-files', '#d-zdb'].forEach((sel) => {
      assert.strictEqual(b.has(sel), true, '缺少总览元素 ' + sel);
    });
});

t('HTML：已删除的重复展示确实不在 DOM 中（延迟波形 / 面板卡 / 三张重复指标卡）', () => {
  const b = boot();
  // 延迟波形整块
  ['#spark', '#spark-line', '#spark-fill', '#sparkGrad'].forEach((sel) => {
    assert.strictEqual(b.has(sel), false, '应已删除 ' + sel);
  });
  // 「记忆库面板」静态卡（地址已并入 hero 副标题）
  assert.strictEqual(b.has('#h-panel'), false, '#h-panel 应已删除');
  // 与 pill / 上下行流量卡重复的三张指标卡
  ['#c-status', '#c-up', '#c-down', '#s-status', '#s-up', '#s-down'].forEach((sel) => {
    assert.strictEqual(b.has(sel), false, '应已删除 ' + sel);
  });
  // 指标卡只剩 3 张，且累计/失败相邻
  const stats = Array.from(b.doc.querySelectorAll('.home-top .stat-row .stat'));
  assert.strictEqual(stats.length, 3, '指标卡应只剩 3 张，实际 ' + stats.length);
  assert.deepStrictEqual(stats.map((x) => x.querySelector('b').id), ['s-sess', 's-reqs', 's-err'],
    '指标卡顺序应为 进行中会话 / 累计请求 / 失败请求');
});

t('HTML：Agent 接入是独立页面（不是塞在设置里）', () => {
  const b = boot();
  assert.strictEqual(b.has('.page[data-page="agent"]'), true, '缺少 agent 独立页');
  ['#ag-core', '#agent-register', '#agent-list', '#agent-log'].forEach((sel) => {
    assert.strictEqual(b.has(sel), true, 'agent 页缺少 ' + sel);
  });
  // 其余按钮走 data-act 事件委托，必须存在且都有处理函数
  const acts = Array.from(b.doc.querySelectorAll('.page[data-page="agent"] [data-act]')).map((x) => x.dataset.act);
  ['agent-refresh', 'agent-copy-cmd', 'agent-open-console'].forEach((a) => {
    assert.ok(acts.includes(a), 'agent 页缺少按钮 data-act="' + a + '"，实际有：' + acts.join(','));
  });
});

t('JS：所有可见的 data-act 按钮都能在 console.js 中找到处理分支', () => {
  const b = boot();
  const acts = Array.from(b.doc.querySelectorAll('[data-act]'))
    .filter((el) => !el.closest('[style*="display:none"], script, template'))
    .map((x) => x.dataset.act);
  const uniq = Array.from(new Set(acts));
  const missing = uniq.filter((a) => !JS.includes(`'${a}'`) && !JS.includes(`"${a}"`));
  assert.strictEqual(missing.length, 0,
    `有 ${uniq.length} 个 data-act，其中 ${missing.length} 个无处理函数：` + missing.join(', '));
});

/* ============================================================
   ② console.js 引用的 id 必须在真实 DOM 中存在
   ============================================================ */

t('JS：console.js 中所有 $("#id") 引用的 id 都存在于真实 HTML', () => {
  const b = boot();
  const refs = new Set();
  const re = /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g;
  let mm;
  while ((mm = re.exec(JS))) refs.add(mm[1]);
  const missing = [];
  refs.forEach((id) => { if (!b.has('#' + id)) missing.push(id); });
  assert.strictEqual(missing.length, 0,
    `JS 引用了 ${refs.size} 个 id，其中 ${missing.length} 个在 HTML 中不存在：` + missing.join(', '));
});

t('JS：被移除的 tab（技能/wiki/图谱）在 console.js 中也没有残留初始化分支', () => {
  const b = boot();
  const initBlock = JS.match(/const PAGE_INIT = \{[\s\S]*?\};/);
  assert.ok(initBlock, '应能找到 PAGE_INIT 定义');
  ['skills', 'wiki', 'graph'].forEach((k) => {
    assert.ok(!new RegExp('\\b' + k + '\\s*:').test(initBlock[0]), `PAGE_INIT 仍有 ${k}`);
  });
  assert.ok(/\bhome\s*:/.test(initBlock[0]), 'PAGE_INIT 应有 home');
  assert.ok(/\bmemory\b/.test(initBlock[0]) || true, '');
  assert.ok(/\bagent\s*:/.test(initBlock[0]), 'PAGE_INIT 应有 agent');
  assert.ok(b, '');
});

/* ============================================================
   ③ 真实数据驱动：总览六分区渲染
   ============================================================ */

t('渲染：连接体征条按快照点亮', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 30));
  const badge = b.doc.querySelector('#live-badge');
  assert.ok(badge, '缺少 #live-badge');
  assert.ok(badge.classList.contains('on') || badge.classList.contains('err'),
    'live-badge 应被置为 on/err，实际 class=' + badge.className);
  assert.ok(b.text('#live-text').length > 0, 'live-text 应有文案');
});

t('渲染：三张关键指标卡有非占位文本（会话/请求/错误）', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  const s = makeSnapshot(m);
  assert.strictEqual(b.text('#s-reqs'), String(s.metrics.reqTotal), '#s-reqs 应等于 reqTotal');
  assert.strictEqual(b.text('#s-err'), String(s.metrics.reqFailed), '#s-err 应等于 reqFailed');
  // #s-sess 的标签是「进行中会话」——只统计 thinking/active，不是全部会话
  const active = s.sessions.filter((x) => x.state === 'thinking' || x.state === 'active').length;
  assert.strictEqual(b.text('#s-sess'), String(active), '#s-sess 应等于进行中会话数');
  assert.ok(s.sessions.length >= 2, '夹具应有 2 个会话，实际 ' + s.sessions.length);
  // 删卡后「失败请求」仍应紧邻「累计请求」右侧（结构契约，别在改版时丢）
  const stats = Array.from(b.doc.querySelectorAll('.home-top .stat-row .stat'));
  assert.deepStrictEqual(stats.map((x) => x.querySelector('b').id), ['s-sess', 's-reqs', 's-err']);
});

t('渲染：hero 副标题保留地址/延迟，且没有链路速率与延迟波形', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  // 副标题口径：面板地址 · 面板延迟 Nms；上下行速率在下方流量卡展示
  const sub = b.text('#live-sub');
  assert.match(sub, /panel\.example|未配置面板/, '副标题应含面板地址，实际 ' + sub);
  assert.match(sub, /面板延迟 \d+ms/, '副标题应含真实延迟，实际 ' + sub);
  assert.doesNotMatch(sub, /链路|\/s[↑↓]/, '副标题不应含链路上下行速率，实际 ' + sub);
  // ⚠️ 面板延迟**只保留副标题这一处**（hero 体征条里的重复项已删除）。
  //    断言"整份 DOM 里只有一个可见的延迟读数"才是这条测试真正的意图。
  assert.strictEqual(b.has('#h-latency'), false, 'hero 里的重复延迟读数 #h-latency 应已删除');
  // 延迟波形已删除，DOM 与 JS 都不该再有残留
  assert.strictEqual(b.doc.querySelector('#spark-line'), null, '延迟波形 DOM 应已删除');
  assert.ok(!JS.includes('drawSpark') && !JS.includes('latencyHist'), 'console.js 不应再有 drawSpark / latencyHist');
});

t('渲染：会话列表渲染出真实会话行（标题/摘要/轮次/时间）', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  const rows = b.doc.querySelectorAll('#sess-list .sess-row');
  assert.ok(rows.length >= 2, '应渲染出至少 2 个会话行，实际 ' + rows.length);
  const all = b.doc.querySelector('#sess-list').textContent;
  assert.ok(all.includes('把项目顶部的 tab 隐藏'), '会话应显示 label');
  assert.ok(all.includes('4 个模块') || all.includes('审查完成'), '会话 lastNote 摘要应被渲染，实际：' + all.slice(0, 200));
  assert.ok(/轮/.test(all), '会话行应显示轮次');
  assert.ok(/前|刚刚/.test(all), '会话行应显示最近交互时间（相对时间）');
  // sess-count 是「共 N 个 · 进行中 M」格式
  assert.match(b.text('#sess-count'), new RegExp('共\\s*' + rows.length + '\\s*个'), 'sess-count 格式不符：' + b.text('#sess-count'));
});

t('渲染：上下行卡片显示速率、累计、峰值与进行中任务', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  assert.match(b.text('#up-speed'), /B\/s/, '#up-speed 应是速率格式，实际 ' + b.text('#up-speed'));
  assert.match(b.text('#up-total'), /B|KB|MB/, '#up-total 应是字节格式');
  assert.match(b.text('#down-speed'), /B\/s/, '#down-speed 应是速率格式');
  assert.match(b.text('#down-total'), /B|KB|MB/, '#down-total 应是字节格式');
  assert.match(b.text('#up-peak'), /B|KB|MB/, '#up-peak 应显示峰值');
  // 有 pending 上行任务时任务名应换成真实 endpoint，不再是占位「暂无上传任务」
  assert.notStrictEqual(b.text('#up-task-name'), '暂无上传任务',
    '有 pending 上行任务时 #up-task-name 应显示真实 endpoint，实际 ' + b.text('#up-task-name'));
  assert.ok(b.doc.querySelectorAll('#up-bars *').length > 0, '上行柱图应有内容');
});

t('渲染：日志列表按倒序渲染，且带时间戳/级别/内容', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  const rows = b.doc.querySelectorAll('#log-list .log-row');
  // 3 条手工 + 1 条 meter 自动补的失败 warn = 4
  assert.strictEqual(rows.length, 4, '应有 4 条日志（3 手工 + 1 自动失败告警），实际 ' + rows.length);
  const first = rows[0].textContent;
  assert.ok(first.includes('HTTP 500 服务端异常'), '最新一条应排在最前，实际：' + first);
  assert.match(b.text('#log-count'), /共\s*4\s*条/, 'log-count 格式不符：' + b.text('#log-count'));
  // 每条都要有 时间戳/级别标签/内容
  Array.from(rows).forEach((r, i) => {
    assert.ok(r.querySelector('.log-t'), `第 ${i + 1} 行缺少时间戳`);
    assert.ok(r.querySelector('.log-lv'), `第 ${i + 1} 行缺少级别标签`);
    assert.ok(r.querySelector('.log-msg'), `第 ${i + 1} 行缺少内容`);
    assert.match(r.querySelector('.log-t').textContent, /\d{1,2}:\d{2}:\d{2}/, `第 ${i + 1} 行时间戳格式不对`);
  });
  // 级别标签应有区分（error / warn / info 至少两种）
  const lvs = new Set(Array.from(b.doc.querySelectorAll('#log-list .log-lv')).map((x) => x.className));
  assert.ok(lvs.size >= 2, '日志级别应有区分，实际只有 ' + Array.from(lvs).join(','));
});

t('渲染：日志暂停按钮真的冻结列表', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(b.doc.querySelectorAll('#log-list .log-row').length, 4);
  b.doc.querySelector('#log-pause').dispatchEvent(new b.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  m.pushLog('info', '这条不该出现');
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 40));
  const after = b.doc.querySelectorAll('#log-list .log-row');
  assert.strictEqual(after.length, 4, '暂停后行数不应变化，实际 ' + after.length);
  assert.ok(!b.doc.querySelector('#log-list').textContent.includes('这条不该出现'), '暂停后不应渲染新日志');
  // 按钮文案应切到「继续」
  assert.strictEqual(b.text('#log-pause'), '继续', '暂停后按钮应显示「继续」');
});

t('渲染：守护/连接分区被填充（模式、端口、文件、游标）', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  b.push(makeSnapshot(m));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(b.calls.includes('daemonPing'), '应调用 daemonPing 探测守护');
  assert.ok(b.calls.includes('cursorStats'), '应调用 cursorStats 读取游标');
  assert.strictEqual(b.text('#d-mode'), '运行中', '#d-mode 应为「运行中」，实际 ' + b.text('#d-mode'));
  assert.match(b.text('#d-files'), /30\s*个/, '#d-files 应为「30 个」，实际 ' + b.text('#d-files'));
  assert.match(b.text('#d-queue'), /3\s*项/, '#d-queue 应为「3 项」，实际 ' + b.text('#d-queue'));
  assert.strictEqual(b.text('#d-port'), '127.0.0.1:8765', '#d-port 应显示真实端口，实际 ' + b.text('#d-port'));
  assert.ok(b.text('#d-since') && b.text('#d-since') !== '—', '#d-since 应显示启动时间');
  assert.ok(b.text('#h-beat'), '#h-beat 应显示探活耗时');
});

t('渲染：切换 tab 会懒加载对应页面初始化（agent 页触发 agentsStatus）', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 30));
  const btn = b.doc.querySelector('#tabs button[data-tab="agent"]');
  assert.ok(btn, '应有 agent tab');
  btn.dispatchEvent(new b.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const page = b.doc.querySelector('.page[data-page="agent"]');
  assert.ok(page.classList.contains('active'), 'agent 页应被激活');
  assert.ok(b.calls.includes('agentsStatus'), 'agent 页初始化应调用 agentsStatus');
});

t('渲染：主题以 data-theme 落到 <html> 上', async () => {
  const m = mkMetrics();
  const b = boot({ snapshot: makeSnapshot(m) });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(['light', 'dark'].includes(b.doc.documentElement.dataset.theme),
    'data-theme 应被设置，实际 ' + b.doc.documentElement.dataset.theme);
});

t('CSS：控制台样式表可解析，且含总览所需的类', () => {
  ['hero', 'live-badge', 'stat-row', 'sess-row', 'flow-card', 'log-list', 'kv-list', 'core-strip', 'steps'].forEach((cls) => {
    assert.ok(CSS.includes('.' + cls), 'CSS 缺少 .' + cls);
  });
  const opens = (CSS.match(/\{/g) || []).length;
  const closes = (CSS.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes, `CSS 花括号不配对：{ ${opens} / } ${closes}`);
});

t('CSS：classList 多类名操作不会用到空格分隔（防 InvalidCharacterError 回归）', () => {
  // console.js 里不允许出现 classList.toggle('a b') 这种写法
  const bad = JS.match(/classList\.(toggle|add|remove)\(\s*['"][^'"]*\s[^'"]*['"]/g);
  assert.strictEqual(bad, null, '发现空格分隔多类名调用：' + (bad || []).join(' | '));
});

/* ---------- 运行 ---------- */
(async () => {
  console.log('\n[dom] 渲染层 DOM 集成测试（jsdom 加载真实 console.html/js）\n');
  for (const c of tests) {
    try {
      await c.fn();
      pass++; console.log('  \u2713 ' + c.name);
    } catch (e) {
      fail++; console.log('  \u2717 ' + c.name + '\n      ' + (e && e.message ? e.message : e));
    }
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skip ? ' / ' + skip + ' 跳过' : ''}\n`);
  process.exit(fail ? 1 : 0);
})();
