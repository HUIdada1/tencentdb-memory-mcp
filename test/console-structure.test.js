// test/console-structure.test.js — 渲染层结构 + 交互验证（jsdom 实跑真实 console.html/js）
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
    if (tool === 'memory_layers') {
      // 传 layer → 该层明细，真实面板返回 {layer, items, total, limit, offset}（支持服务端分页）
      if (args && args.layer) {
        const off = Number(args.offset) || 0;
        const lim = Number(args.limit) || 10;
        const all = [
          // L1 明细真实字段：title/body/created_at，注意**没有 score**
          { id: 'm_' + off + '_1', title: 'work_task', body: '第 ' + (off + 1) + ' 条：Xiaomi MiMo 接入用量统计调研当前进展，待确认 message 表 data 字段。', tags: [], refs: [], created_at: '2026-09-22T02:27:52.416Z' },
          { id: 'm_' + off + '_2', title: 'work_method', body: '第 ' + (off + 2) + ' 条：解析 app.asar 文件树定位主进程 bundle，反查 SESSION_DIR 定义。', tags: ['调研'], refs: ['r1'], created_at: '2026-09-22T02:27:52.411Z' },
        ];
        return Promise.resolve({
          ok: true,
          data: { layer: args.layer, items: all.slice(0, Math.max(0, lim - off + off)), total: 405, limit: lim, offset: off },
          hint: 'L0=对话原文，L1~L3=抽取记忆',
        });
      }
      return Promise.resolve({
        ok: true,
        data: { block_id: 'chat_memory-team-zn0elw0289-agt-zoav7zxdz0', counts: { L0_messages: 816, L1: 392, L2: 12, L3: 1 }, total: 1221 },
        hint: 'L0=对话原文，L1~L3=抽取记忆',
      });
    }
    // 检索：真实返回 {items:[{id,role,title,body,tags,refs,score,created_at}], total}
    // 造 17 条以便验证"每页 10 条 → 2 页"的客户端分页
    if (tool === 'memory_search') {
      const items = Array.from({ length: 17 }, (_, i) => ({
        id: 'msg-' + i, role: i % 2 ? 'assistant' : 'user', title: i % 2 ? 'assistant' : 'user',
        body: '第 ' + (i + 1) + ' 条检索结果正文（排涝站数据库设计要点）。',
        tags: [i % 2 ? 'assistant' : 'user'], refs: [], score: 0.85 - i * 0.01, created_at: '2026-09-21T17:37:15.404Z',
      }));
      return Promise.resolve({ ok: true, data: { items, total: items.length } });
    }
    return Promise.resolve({ ok: true, data: { skill_count: 3, memory_count: 99 } });
  },
  metricsGet: () => Promise.resolve(snap),
  sessionsScan: () => Promise.resolve({ ok: true, sessions: [] }),
  cursorStats: () => Promise.resolve({ ok: true, count: 0 }),
  daemonPing: () => Promise.resolve({ ok: false }),
  backfillStart: (opts) => { calls.push({ tool: 'backfillStart', args: opts }); return Promise.resolve({ ok: true }); },
  backfillStatus: () => Promise.resolve({ ok: true, payload: { running: false, doneAt: '', files: 0, filesDone: 0, msgs: 0 } }),
  // 上传清单夹具：用**通用占位路径**，不要写真实项目/机器路径（开源仓库里不带任何本地痕迹）
  backfillInventory: () => Promise.resolve({
    ok: true,
    items: [
      { key: 'zcode:~/projects/demo-app', name: 'demo-app', source: 'zcode', dir: '~/projects/demo-app', items: 83, msgs: 6508, pending: 83, lastTs: Date.now() },
      { key: 'claude-code:~/projects/api-server', name: 'api-server', source: 'claude-code', dir: '~/projects/api-server', items: 3, msgs: 18304, pending: 0, lastTs: Date.now() },
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
    chk('分层行可下钻（带 data-layer）', N('#mem-out .mem-lrow[data-layer]') === 4, N('#mem-out .mem-lrow[data-layer]') + ' 行');
    // 概览不分页
    chk('概览不分页（pager 隐藏）', !d.querySelector('#mem-pager').classList.contains('show'));

    /* ===== ⑫ 记忆卡片结构化 + 分页（本期新增）===== */
    console.log('=== ⑫ 记忆筛选卡片结构化 + 分页 ===');

    // 静态结构：旧的 5/10/20 选择器必须已移除，固定每页 10 条
    chk('已移除 5/10/20 条数选择器', !d.querySelector('#mem-topk'));
    chk('常量每页 10 条', js.includes('MEM_PER_PAGE = 10'));

    // 下钻 L1 明细（服务端分页）
    const l1row = Array.from(d.querySelectorAll('.mem-lrow')).find((e) => e.dataset.layer === 'L1');
    if (l1row) l1row.dispatchEvent(new w.Event('click', { bubbles: true }));
    setTimeout(() => {
      const outTxt = T('#mem-out');
      chk('明细卡片渲染出标题', outTxt.includes('work_task'), outTxt.slice(0, 60));
      chk('明细卡片正文是摘要而非原始 JSON', !outTxt.includes('"id"') && !outTxt.includes('"body"'), outTxt.slice(0, 60));
      chk('明细卡片时间已格式化（YYYY-MM-DD HH:mm）', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(outTxt));
      chk('明细卡片渲染标签胶囊', N('#mem-out .mem-tag') >= 1, N('#mem-out .mem-tag') + ' 个');
      chk('无 score 的行不渲染分值', N('#mem-out .mem-score') === 0, N('#mem-out .mem-score') + ' 个');

      // 服务端分页：total=405 → 41 页，控件显示且请求带 limit/offset
      const layerCall = calls.filter((c) => c.tool === 'memory_layers' && c.args && c.args.layer).pop();
      chk('分层明细请求带 limit=10 offset=0', !!layerCall && layerCall.args.limit === 10 && layerCall.args.offset === 0,
        layerCall ? JSON.stringify(layerCall.args) : '无请求');
      chk('分页控件显示', d.querySelector('#mem-pager').classList.contains('show'));
      chk('分页信息显示 1/41 与总数 405', T('.pg-info').includes('41') && T('.pg-info').includes('405'), T('.pg-info'));

      // 翻页 → offset 应变成 10
      const nextBtn = d.querySelector('[data-pg="next"]');
      if (nextBtn) nextBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
      setTimeout(() => {
        const c2 = calls.filter((c) => c.tool === 'memory_layers' && c.args && c.args.layer).pop();
        chk('翻页后请求 offset=10（服务端分页生效）', !!c2 && c2.args.offset === 10, c2 ? JSON.stringify(c2.args) : '无请求');
        chk('翻页后页码变为 2', T('.pg-info').includes('2'), T('.pg-info'));

        /* ===== ⑬ 搜索 / 分层模式切换 + 客户端分页 ===== */
        console.log('=== ⑬ 搜索/分层切换 + 检索客户端分页 ===');
        chk('有模式切换控件', N('[data-memmode]') === 2, N('[data-memmode]') + ' 个');
        chk('有层选择器', !!d.querySelector('#mem-layer'));

        const sTab = d.querySelector('[data-memmode="search"]');
        if (sTab) sTab.dispatchEvent(new w.Event('click', { bubbles: true }));
        setTimeout(() => {
          chk('切到检索模式：tab 高亮', d.querySelector('[data-memmode="search"]').classList.contains('active'));
          chk('检索模式：隐藏关键词输入框的类被移除', !d.querySelector('#mem-q').classList.contains('hide'));

          // 无输入 → 不应请求
          const beforeCnt = calls.filter((c) => c.tool === 'memory_search').length;
          const sBtn = d.querySelector('[data-act="memory-search"]');
          if (sBtn) sBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
          setTimeout(() => {
            chk('空关键词不发起检索', calls.filter((c) => c.tool === 'memory_search').length === beforeCnt);

            // 输入关键词并检索：17 条 → 客户端分页为 2 页，每页 10
            d.querySelector('#mem-q').value = '记忆';
            if (sBtn) sBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
            setTimeout(() => {
              chk('检索结果每页固定 10 条', N('#mem-out .mem-item') === 10, N('#mem-out .mem-item') + ' 条');
              chk('检索结果渲染分值', N('#mem-out .mem-score') === 10, N('#mem-out .mem-score') + ' 个');
              chk('检索结果渲染 role 色标', N('#mem-out .mem-role') === 10, N('#mem-out .mem-role') + ' 个');
              chk('检索正文非原始 JSON', !T('#mem-out').includes('"id"'));
              const sc = calls.filter((c) => c.tool === 'memory_search').pop();
              chk('检索一次拉满 top_k=20', !!sc && sc.args.top_k === 20, sc ? JSON.stringify(sc.args) : '无请求');
              // 回归：从 L1 明细切到检索时，layer 不能被静默带过去（实跑抓到过）
              chk('切模式后 layer 已重置（不残留 L1）', !!sc && !sc.args.layer, sc ? JSON.stringify(sc.args) : '无请求');
              chk('检索分页显示 2 页', T('.pg-info').includes('2') && T('.pg-info').includes('17'), T('.pg-info'));

              // 客户端翻页：不应重复请求面板
              const beforePage = calls.filter((c) => c.tool === 'memory_search').length;
              const n2 = d.querySelector('[data-pg="next"]');
              if (n2) n2.dispatchEvent(new w.Event('click', { bubbles: true }));
              setTimeout(() => {
                chk('检索翻页不重复请求面板（客户端切片）',
                  calls.filter((c) => c.tool === 'memory_search').length === beforePage);
                chk('第 2 页剩 7 条', N('#mem-out .mem-item') === 7, N('#mem-out .mem-item') + ' 条');
                chk('末页时下一页禁用', d.querySelector('[data-pg="next"]').disabled);

                // 回到弹窗测试（切回总览页）
                d.querySelector('#tabs button[data-tab="home"]').dispatchEvent(new w.Event('click', { bubbles: true }));
                const bfBtn = d.querySelector('.page[data-page="home"] [data-act="backfill-start"]');
                if (bfBtn) bfBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
                setTimeout(() => {
                  chk('点击后弹窗显示', !modal.hasAttribute('hidden'));
                  chk('弹窗已列出 agent 行', N('#upm-list .up-row') >= 2, N('#upm-list .up-row') + ' 行');
                  chk('agent 行展示名称与待上传标记', T('#upm-list').includes('demo-app') && T('#upm-list').includes('待上传'), T('#upm-list').slice(0, 50));
                  chk('弹窗未自行启动回传（等用户确认）', calls.filter((c) => c.tool === 'backfillStart').length === 0);

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
              }, 120);
            }, 150);
          }, 120);
        }, 120);
      }, 150);
    }, 150);
  }, 150);
}, 250);
