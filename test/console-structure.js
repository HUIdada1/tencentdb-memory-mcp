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
    // 分层计数：用真实面板返回形态（{block_id, counts, total}），
    // 保证测试覆盖的正是"曾经被当成原始 JSON 打出来"的那条分支
    if (tool === 'memory_layers') return Promise.resolve({
      ok: true,
      data: { block_id: 'chat_memory-team-zn0elw0289-agt-zoav7zxdz0', counts: { L0_messages: 816, L1: 392, L2: 12, L3: 1 }, total: 1221 },
      hint: 'L0=对话原文，L1~L3=抽取记忆',
    });
    if (tool === 'memory_search') return Promise.resolve({ ok: true, data: { list: [{ content: '排涝站数据库设计要点', score: 0.93 }] } });
    return Promise.resolve({ ok: true, data: { skill_count: 3, memory_count: 99 } });
  },
  metricsGet: () => Promise.resolve(snap),
  sessionsScan: () => Promise.resolve({ ok: true, sessions: [] }),
  cursorStats: () => Promise.resolve({ ok: true, count: 0 }),
  daemonPing: () => Promise.resolve({ ok: false }),
  backfillStart: (opts) => { calls.push({ tool: 'backfillStart', args: opts }); return Promise.resolve({ ok: true }); },
  backfillStatus: () => Promise.resolve({ ok: true, payload: { running: false, doneAt: '', files: 0, filesDone: 0, msgs: 0 } }),
  backfillInventory: () => Promise.resolve({
    ok: true,
    items: [
      { key: 'zcode:E:\\idea work\\AgentHub', name: 'AgentHub', source: 'zcode', dir: 'E:\\idea work\\AgentHub', items: 83, msgs: 6508, pending: 83, lastTs: Date.now() },
      { key: 'zcode-rollout:C:\\Users\\x\\.zcode\\cli\\rollout', name: 'rollout', source: 'zcode-rollout', dir: 'C:\\Users\\x\\.zcode\\cli\\rollout', items: 3, msgs: 18304, pending: 0, lastTs: Date.now() },
    ],
    total: { groups: 2, items: 86, pending: 83, msgs: 24812 },
  }),
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

  console.log('=== ⑨ 历史会话回传 ===');
  chk('memory 页有回传按钮', !!d.querySelector('.page[data-page="memory"] #bf-btn'));
  chk('memory 页有回传横幅位', !!d.querySelector('.page[data-page="memory"] #b-backfill'));
  chk('console.js 有 backfill-start 动作', /'backfill-start'\s*\(\)/.test(js));
  chk('console.js 有进度轮询', js.includes('pollBackfill') && js.includes('renderBackfill'));

  console.log('=== ⑩ 上传弹窗（按 agent 选择 / 全部上传） ===');
  const modal = d.querySelector('#upm-modal');
  chk('弹窗 DOM 存在', !!modal);
  chk('弹窗默认隐藏', !!(modal && modal.hasAttribute('hidden')));
  chk('弹窗有 agent 列表容器', !!d.querySelector('#upm-list'));
  chk('弹窗有「上传选中项」按钮', !!d.querySelector('#upm-go'));
  chk('弹窗有「上传全部记忆」按钮', !!d.querySelector('#upm-all'));
  chk('弹窗有全选/全不选/仅选未上传', !!d.querySelector('#upm-sel-all') && !!d.querySelector('#upm-sel-none') && !!d.querySelector('#upm-sel-pending'));
  chk('弹窗有进度条节点', !!d.querySelector('#upm-pfill') && !!d.querySelector('#upm-ptext'));
  chk('一键上传按钮已改为打开弹窗（不再直接开跑）', /'backfill-start'\s*\(\)\s*\{\s*openUpModal\(\)/.test(js.replace(/\s+/g, ' ')) || js.includes('openUpModal()'));

  // 注：弹窗列表与记忆分层的「渲染结果」断言放在下方异步回调里（这里还没加载完）。
  // 这里只断言静态结构（DOM 节点存在 + 渲染函数已定义）。
  chk('弹窗渲染函数已定义', js.includes('renderInventory') && js.includes('updateUpFooter'));
  chk('回传按 targets 过滤', js.includes('targets'));
  chk('记忆分层渲染函数已定义', js.includes('LAYER_META') && js.includes('mem-lrow'));

  // 交互：点击记忆 tab 应触发 memory_layers
  d.querySelector('#tabs button[data-tab="memory"]').dispatchEvent(new w.Event('click', { bubbles: true }));
  setTimeout(() => {
    const memCalls = calls.filter((c) => c.tool === 'memory_layers').length;
    chk('进入记忆页自动加载分层', memCalls >= 1, 'memory_layers 调用 ' + memCalls + ' 次');
    chk('记忆页渲染出内容', T('#mem-out').length > 0 && !T('#mem-out').includes('正在加载'), T('#mem-out').slice(0, 60));

    console.log('=== ⑪ 记忆分层计数渲染（曾是原始 JSON） ===');
    chk('不再出现「原始返回」', !T('#mem-out').includes('原始返回'), T('#mem-out').slice(0, 60));
    chk('渲染出 L0 分层名', T('#mem-out').includes('L0'), T('#mem-out').slice(0, 60));
    chk('渲染出 L1/L2/L3 分层名', T('#mem-out').includes('L1') && T('#mem-out').includes('L2') && T('#mem-out').includes('L3'));
    chk('显示总条数 1221', T('#mem-out').includes('1221'), T('#mem-out').slice(0, 60));
    chk('显示各层计数', T('#mem-out').includes('816') && T('#mem-out').includes('392'));
    chk('有分层行 DOM', N('#mem-out .mem-lrow') === 4, N('#mem-out .mem-lrow') + ' 行');

    // 交互：点「一键上传本地记忆」→ 弹窗打开并列出 agent
    const bfBtn = d.querySelector('.page[data-page="home"] [data-act="backfill-start"]');
    if (bfBtn) bfBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
    setTimeout(() => {
      chk('点击后弹窗显示', !modal.hasAttribute('hidden'));
      chk('弹窗已列出 agent 行', N('#upm-list .up-row') >= 2, N('#upm-list .up-row') + ' 行');
      chk('agent 行展示名称与待上传标记', T('#upm-list').includes('AgentHub') && T('#upm-list').includes('待上传'), T('#upm-list').slice(0, 50));
      chk('弹窗未自行启动回传（等用户确认）', calls.filter((c) => c.tool === 'backfillStart').length === 0);

      // 交互：全选后点「上传选中项」→ 带 targets 启动
      const sa = d.querySelector('#upm-sel-all');
      if (sa) sa.dispatchEvent(new w.Event('click', { bubbles: true }));
      const go = d.querySelector('#upm-go');
      if (go) go.dispatchEvent(new w.Event('click', { bubbles: true }));
      setTimeout(() => {
        const started = calls.filter((c) => c.tool === 'backfillStart');
        chk('全选后上传会带 targets 启动', started.length >= 1 && Array.isArray(started[0].args && started[0].args.targets) && started[0].args.targets.length === 2,
          started.length ? JSON.stringify((started[0].args || {}).targets) : '未启动');

        d.querySelector('#tabs button[data-tab="live"]').dispatchEvent(new w.Event('click', { bubbles: true }));
        setTimeout(() => {
          chk('live page 被激活', d.querySelector('.page[data-page="live"]').classList.contains('active'));
          chk('总览页失去激活', !d.querySelector('.page[data-page="home"]').classList.contains('active'));

          console.log('\n---------- 通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
          ok.forEach((x) => console.log('  ✓ ' + x));
          if (bad.length) { console.log(''); bad.forEach((x) => console.log('  ✗ ' + x)); }
          process.exit(bad.length ? 1 : 0);
        }, 120);
      }, 120);
    }, 400);
  }, 150);
}, 250);
