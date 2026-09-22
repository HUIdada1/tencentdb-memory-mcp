// test/console-behavior.test.js — 渲染层行为验证（jsdom 实跑真实 console.html/js）
// 覆盖：右上角连接状态 pill 的四种判定、总览「连接状态」卡联动、
//       运行时长在无推送时仍自动刷新（不依赖切换页面）。
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'pet', 'node_modules', 'jsdom'));
const SRC = path.join(__dirname, '..', 'pet', 'src');
const html = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

function boot(snap, appInfo) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: false, media: q, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; } });
  const handlers = {};
  w.tdai = {
    appInfo: () => Promise.resolve(appInfo || {}),
    connLoad: () => Promise.resolve({}), connSave: () => Promise.resolve({}), connTest: () => Promise.resolve({}),
    prefsLoad: () => Promise.resolve({ ui: { theme: 'light' }, system: {}, update: {} }), prefsSave: () => Promise.resolve({}),
    agentsStatus: () => Promise.resolve([]), agentsRegister: () => Promise.resolve({ results: [], items: [] }),
    toolCall: () => Promise.resolve({ ok: true, data: { layers: [{ name: 'L1', count: 5 }] } }),
    metricsGet: () => Promise.resolve(snap),
    sessionsScan: () => Promise.resolve({ ok: true, sessions: [] }), cursorStats: () => Promise.resolve({ ok: true, count: 0 }),
    daemonPing: () => Promise.resolve({ ok: true, ms: 5, payload: { hookCalls: 1 } }),
    copyText: () => Promise.resolve({ ok: true }), revealPath: () => Promise.resolve({}), openExternal: () => Promise.resolve({}),
    updateGet: () => Promise.resolve({ status: 'idle' }), updateCheck: () => Promise.resolve({}), updateDownload: () => Promise.resolve({}), updateInstall: () => Promise.resolve({}),
    updateOpenReleases: () => Promise.resolve({}), updateOpenRepo: () => Promise.resolve({}),
    winMin() { }, winClose() { }, quit() { },
    on: (ch, cb) => { (handlers[ch] = handlers[ch] || []).push(cb); return () => { }; },
  };
  new w.Function(js).call(w);
  return { w, d: w.document, push: (s) => (handlers['metrics'] || []).forEach((cb) => cb({ payload: s })) };
}

function mkSnap(o) {
  return Object.assign({
    ok: true, at: Date.now(), uptime: 3600000,
    panelUrl: 'https://panel.example', panelOk: true, panelError: '', daemonOk: true,
    metrics: { upSpeed: 1024, downSpeed: 2048, uploadBytes: 100, downloadBytes: 200, reqTotal: 10, reqFailed: 0, latency: 88, upTask: null, downTask: null },
    series: { t: [], up: [], down: [], lat: [] }, sessions: [], logs: [], logSeq: 0,
  }, o || {});
}

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 场景 A：面板已连接（有延迟）→ pill 应为「已连接」且点亮 on ----
  {
    const s = mkSnap({ metrics: { upSpeed: 1024, downSpeed: 2048, reqTotal: 10, reqFailed: 0, latency: 88, upTask: null, downTask: null } });
    const b = boot(s, { version: '0.4.1', port: 8100, panelUrl: 'https://panel.example' });
    await wait(80);
    b.push(s);
    await wait(2200);
    chk('A 已连接时 pill 文案为「已连接」', b.d.querySelector('#health-text').textContent.trim() === '已连接', b.d.querySelector('#health-text').textContent.trim());
    chk('A 已连接时 pill 有 on 类', b.d.querySelector('#health-pill').classList.contains('on'), b.d.querySelector('#health-pill').className);
    // 「连接状态」指标卡已删除：连接状态唯一可见处是右上角 pill + hero 的 live-text，
    // 这里断言 hero 文案确实承载了状态，避免删卡后"状态无处可看"。
    chk('A hero 状态文案为「实时连接正常」', b.d.querySelector('#live-text').textContent.trim() === '实时连接正常', b.d.querySelector('#live-text').textContent.trim());
    // 首排两态：已连接 → 分半（hero 与指标卡同排）
    const split = b.d.querySelector('#home-split');
    chk('A 已连接时首排为分半版式', split.classList.contains('split') && !split.classList.contains('nosplit'), split.className);
  }

  // ---- 场景 B：面板不可达（panelOk:false）→ pill 应为「连接失败」且点亮 err ----
  {
    const s = mkSnap({ panelOk: false, panelError: '面板不可达（连接失败或超时）', metrics: { upSpeed: 0, downSpeed: 0, reqTotal: 4, reqFailed: 4, latency: 0, upTask: null, downTask: null } });
    const b = boot(s, { version: '0.4.1', port: 8100, panelUrl: 'https://panel.example' });
    await wait(80);
    b.push(s);
    await wait(2200);
    chk('B 不可达时 pill 文案为「连接失败」', b.d.querySelector('#health-text').textContent.trim() === '连接失败', b.d.querySelector('#health-text').textContent.trim());
    chk('B 不可达时 pill 有 err 类', b.d.querySelector('#health-pill').classList.contains('err'), b.d.querySelector('#health-pill').className);
    chk('B hero 状态文案为「面板连接已中断」', b.d.querySelector('#live-text').textContent.trim() === '面板连接已中断', b.d.querySelector('#live-text').textContent.trim());
    // 断开 → 首排退回整行版式（hero 只剩状态文案，分半会空出一大片）
    const split = b.d.querySelector('#home-split');
    chk('B 不可达时首排退回整行版式', split.classList.contains('nosplit') && !split.classList.contains('split'), split.className);
  }

  // ---- 场景 C：未配置面板 → pill 应为「未配置」 ----
  {
    const s = mkSnap({ panelUrl: '', panelOk: null, daemonOk: true, metrics: { upSpeed: 0, downSpeed: 0, reqTotal: 0, reqFailed: 0, latency: 0, upTask: null, downTask: null } });
    const b = boot(s, { version: '0.4.1', port: 8100 });
    await wait(80);
    b.push(s);
    await wait(2200);
    chk('C 未配置时 pill 文案为「未配置」', b.d.querySelector('#health-text').textContent.trim() === '未配置', b.d.querySelector('#health-text').textContent.trim());
  }

  // ---- 场景 D：守护在线但尚无延迟 → 判定为已连接 ----
  {
    const s = mkSnap({ panelOk: null, daemonOk: true, metrics: { upSpeed: 0, downSpeed: 0, reqTotal: 0, reqFailed: 0, latency: 0, upTask: null, downTask: null } });
    const b = boot(s, { version: '0.4.1', port: 8100, panelUrl: 'https://panel.example' });
    await wait(80);
    b.push(s);
    await wait(2200);
    chk('D 守护在线时判为已连接', b.d.querySelector('#health-text').textContent.trim() === '已连接', b.d.querySelector('#health-text').textContent.trim());
  }

  // ---- 场景 E：运行时长在两次推送之间自动增长（不依赖切换页面） ----
  {
    const s = mkSnap({ uptime: 3600000 });
    const b = boot(s, { version: '0.4.1', port: 8100, panelUrl: 'https://panel.example' });
    await wait(80);
    b.push(s);
    await wait(120);
    const t1 = b.d.querySelector('#h-uptime').textContent.trim();
    // 关键：不再推送任何快照，只等本地定时器推进
    await wait(2600);
    const t2 = b.d.querySelector('#h-uptime').textContent.trim();
    chk('E 无推送也能自动刷新运行时长', t1 !== t2, `"${t1}" → "${t2}"`);
    chk('E 运行时长为 时:分:秒 格式（秒在走）', /^\d+:\d{2}:\d{2}$/.test(t2), t2);
  }

  console.log('\n---------- 行为验证：通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
  ok.forEach((x) => console.log('  ✓ ' + x));
  if (bad.length) { console.log(''); bad.forEach((x) => console.log('  ✗ ' + x)); }
  process.exit(bad.length ? 1 : 0);
})();
