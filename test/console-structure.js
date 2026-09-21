// test/console-structure.js — 渲染层结构 + 交互验证（jsdom 实跑真实 console.html/js）
// 覆盖本轮的 8 项调整：记忆页自动加载、连接状态 pill、运行时长定时器、
//   作者信息、卡片位置与样式一致性、快速检索移除、实时会话 tab 迁移。
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'pet', 'node_modules', 'jsdom'));
const SRC = path.join(__dirname, '..', 'pet', 'src');
const html = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.matchMedia = (q) => ({ matches: false, media: q, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; } });

const calls = [];
let snap = null;
w.tdai = {
  appInfo: () => Promise.resolve({ version: '0.4.1', port: 8100, exePath: 'x', cfgPath: 'y', panelUrl: 'https://panel.example' }),
  connLoad: () => Promise.resolve({ panelUrl: 'https://panel.example' }), connSave: () => Promise.resolve({}), connTest: () => Promise.resolve({ nas: true, auth: true }),
  prefsLoad: () => Promise.resolve({ ui: { theme: 'light' }, system: {}, update: {} }), prefsSave: () => Promise.resolve({}),
  agentsStatus: () => Promise.resolve([]), agentsRegister: () => Promise.resolve({ results: [], items: [] }),
  toolCall: (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'memory_layers') return Promise.resolve({ ok: true, data: { layers: [{ name: 'L1', count: 12 }, { name: 'L2', count: 34 }] } });
    if (tool === 'memory_search') return Promise.resolve({ ok: true, data: { list: [{ content: '排涝站数据库设计要点', score: 0.93 }] } });
    return Promise.resolve({ ok: true, data: { skill_count: 3, memory_count: 99 } });
  },
  metricsGet: () => Promise.resolve(snap),
  sessionsScan: () => Promise.resolve({ ok: true, sessions: [] }),
  cursorStats: () => Promise.resolve({ ok: true, count: 0 }),
  daemonPing: () => Promise.resolve({ ok: false }),
  copyText: () => Promise.resolve({ ok: true }), revealPath: () => Promise.resolve({}),
  openExternal: () => Promise.resolve({}),
  updateGet: () => Promise.resolve({ status: 'idle' }), updateCheck: () => Promise.resolve({}), updateDownload: () => Promise.resolve({}), updateInstall: () => Promise.resolve({}),
  updateOpenReleases: () => Promise.resolve({}), updateOpenRepo: () => Promise.resolve({}),
  winMin() { }, winClose() { }, quit() { },
  on: () => () => { },
};
new w.Function(js).call(w);

const ok = [];
const bad = [];
const chk = (name, cond, extra) => { (cond ? ok : bad).push(name + (extra ? ' → ' + extra : '')); };

setTimeout(() => {
  const d = w.document;
  const T = (s) => { const e = d.querySelector(s); return e ? e.textContent.trim() : '<缺失>'; };
  const N = (s) => d.querySelectorAll(s).length;

  console.log('=== ① 记忆页 ===');
  chk('memory page 存在', !!d.querySelector('.page[data-page="memory"]'));
  chk('mem-out 有初始提示', T('#mem-out').length > 0, T('#mem-out').slice(0, 40));
  chk('PAGE_INIT 含 memory', /memory:\s*\(\)/.test(js));

  console.log('=== ② 连接状态 ===');
  chk('health-pill 含 i 与 b#health-text', !!d.querySelector('#health-pill i') && !!d.querySelector('#health-text'));
  chk('console.js 引用 health-pill', js.includes('health-pill'));
  chk('console.js 引用 refreshHealthPill', js.includes('refreshHealthPill'));

  console.log('=== ③ 运行时长 ===');
  chk('有独立 uptime 定时器', /h-uptime[\s\S]{0,200}?setInterval|setInterval[\s\S]{0,300}?h-uptime/.test(js) || /S\.snap\.uptime \+ \(Date\.now\(\) - S\.snap\.at\)/.test(js));

  console.log('=== ④ 作者信息 ===');
  chk('HTML 含 沐辉', html.includes('沐辉'));
  chk('有 author-name 样式位', !!d.querySelector('.author-name'), T('.author-name'));

  console.log('=== ⑤⑥ 卡片位置与一致性 ===');
  const stats = Array.from(d.querySelectorAll('.stat-row .stat')).map((x) => ({
    id: x.id, label: x.querySelector('span').textContent, val: x.querySelector('b').id,
  }));
  const iReq = stats.findIndex((s) => s.val === 's-reqs');
  const iErr = stats.findIndex((s) => s.val === 's-err');
  chk('失败请求紧邻累计请求右侧', iErr === iReq + 1, `reqs@${iReq} err@${iErr}`);
  chk('两者 class 结构一致', d.querySelector('#c-reqs').className === d.querySelector('#c-err').className,
    `"${d.querySelector('#c-reqs').className}" vs "${d.querySelector('#c-err').className}"`);

  console.log('=== ⑦ 快速检索已移除 ===');
  chk('无 #qs-input', !d.querySelector('#qs-input'));
  chk('无 #qs-go', !d.querySelector('#qs-go'));
  chk('无 #qs-result', !d.querySelector('#qs-result'));
  chk('console.js 无 quickSearch', !js.includes('quickSearch'));
  chk('console.js 无 qs-', !js.includes("'#qs"), 'qs 引用: ' + (js.match(/#qs[\w-]*/g) || []).join(','));

  console.log('=== ⑧ 实时会话 tab ===');
  const tabs = Array.from(d.querySelectorAll('#tabs button')).map((b) => b.dataset.tab);
  chk('tab 序列含 live', tabs.join(',') === 'home,memory,live,agent,settings', tabs.join(','));
  const iMem = tabs.indexOf('memory'), iLive = tabs.indexOf('live'), iAg = tabs.indexOf('agent');
  chk('live 位于 memory 与 agent 之间', iMem < iLive && iLive < iAg);
  chk('live page 存在', !!d.querySelector('.page[data-page="live"]'));
  chk('live page 有 sess-list', !!d.querySelector('.page[data-page="live"] #sess-list'));
  chk('home 不再有 sess-list', !d.querySelector('.page[data-page="home"] #sess-list'));

  // 交互：点击记忆 tab 应触发 memory_layers
  d.querySelector('#tabs button[data-tab="memory"]').dispatchEvent(new w.Event('click', { bubbles: true }));
  setTimeout(() => {
    const memCalls = calls.filter((c) => c.tool === 'memory_layers').length;
    chk('进入记忆页自动加载分层', memCalls >= 1, 'memory_layers 调用 ' + memCalls + ' 次');
    chk('记忆页渲染出内容', T('#mem-out').length > 0 && !T('#mem-out').includes('正在加载'), T('#mem-out').slice(0, 60));

    d.querySelector('#tabs button[data-tab="live"]').dispatchEvent(new w.Event('click', { bubbles: true }));
    setTimeout(() => {
      chk('live page 被激活', d.querySelector('.page[data-page="live"]').classList.contains('active'));
      chk('总览页失去激活', !d.querySelector('.page[data-page="home"]').classList.contains('active'));

      console.log('\n---------- 通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
      ok.forEach((x) => console.log('  ✓ ' + x));
      if (bad.length) { console.log(''); bad.forEach((x) => console.log('  ✗ ' + x)); }
      process.exit(bad.length ? 1 : 0);
    }, 120);
  }, 150);
}, 250);
