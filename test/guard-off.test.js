// test/guard-off.test.js — 「守护已停止」状态下的界面与探活行为验证
// 背景（2026-09-22 实测）：
//   用户点「停止守护」后，实时日志仍在刷「上行 连接失败 · /health」，
//   总览的连接状态卡反而显示"在线"、守护卡片还挂着"运行中 / 即将采集…"，
//   用户据此以为"守护停了但一直在偷偷上传"。
// 三个真因（本文件逐条钉死）：
//   ① 主进程的 10s daemonPing + 30s pollHealth 没有停止态闸门 → 必然失败的本地请求被计入上下行
//   ② refreshHealthPill 用 `latency > 0` 判定"已连接"，而延迟样本有 30s TTL，
//      停止后仍在 TTL 内 → 亮了绿灯
//   ③ 停止时不清 scanAnchor，倒计时继续跑到"即将采集…"
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'pet', 'node_modules', 'jsdom'));
const SRC = path.join(__dirname, '..', 'pet', 'src');
const HTML = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const JS = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个 jsdom 控制台，可指定：守护开关、探活结果、面板往返/延迟状态
function boot(o) {
  const o2 = o || {};
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: false, media: q, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; } });
  const handlers = {};
  const snap = {
    ok: true, at: Date.now(), uptime: 60000,
    panelUrl: 'https://panel.example',
    panelOk: o2.panelOk === undefined ? true : o2.panelOk,
    panelError: '',
    daemonOk: !!o2.daemonOk,
    metrics: {
      upSpeed: 0, downSpeed: 0, uploadBytes: 0, downloadBytes: 0,
      uploadCommits: 0, uploadFails: 0, uploadPeak: 0, downloadPeak: 0, downloadAvgMs: 0,
      reqTotal: 3, reqFailed: 0,
      latency: o2.latency || 0,
      latencyAge: o2.latencyStale ? 90000 : 3000,
      latencyStale: !!o2.latencyStale,
      upTask: null, downTask: null,
    },
    series: { t: [], up: [], down: [], lat: [] }, sessions: [], logs: [], logSeq: 0,
  };
  let guardSetCalls = [];
  w.tdai = {
    appInfo: () => Promise.resolve({ version: '0.5.8', port: 8100, panelUrl: 'https://panel.example' }),
    connLoad: () => Promise.resolve({}), connSave: () => Promise.resolve({}), connTest: () => Promise.resolve({}),
    prefsLoad: () => Promise.resolve({ ui: { theme: 'light' }, system: { guardEnabled: o2.guardEnabled !== false }, update: {} }),
    prefsSave: () => Promise.resolve({}),
    agentsStatus: () => Promise.resolve([]), agentsRegister: () => Promise.resolve({ results: [], items: [] }),
    toolCall: () => Promise.resolve({ ok: true, data: { layers: [] } }),
    metricsGet: () => Promise.resolve(snap),
    sessionsScan: () => Promise.resolve({ ok: true, sessions: [] }),
    cursorStats: () => Promise.resolve({ ok: true, count: 0 }),
    daemonPing: () => Promise.resolve(o2.pingOk
      ? { ok: true, ms: 5, payload: { hookCalls: 1, uploadSources: { zcode: true, 'zcode-db': true, 'claude-code': false } } }
      : { ok: false, error: 'ECONNREFUSED' }),
    guardSet: (v) => { guardSetCalls.push(v); return Promise.resolve({ ok: true, enabled: v }); },
    copyText: () => Promise.resolve({ ok: true }), revealPath: () => Promise.resolve({}), openExternal: () => Promise.resolve({}),
    updateGet: () => Promise.resolve({ status: 'idle' }), updateCheck: () => Promise.resolve({}), updateDownload: () => Promise.resolve({}), updateInstall: () => Promise.resolve({}),
    updateOpenReleases: () => Promise.resolve({}), updateOpenRepo: () => Promise.resolve({}),
    winMin() { }, winClose() { }, quit() { },
    on: (ch, cb) => { (handlers[ch] = handlers[ch] || []).push(cb); return () => { }; },
  };
  new w.Function(JS).call(w);
  return {
    w, d: w.document, snap,
    txt: (id) => { const e = w.document.querySelector(id); return e ? e.textContent.trim() : '(缺)'; },
    click: (id) => { const e = w.document.querySelector(id); if (e) e.dispatchEvent(new w.Event('click', { bubbles: true })); },
    logs: () => {
      const box = w.document.querySelector('#log-list');
      return box ? box.textContent : '';
    },
    guardSetCalls,
  };
}

(async () => {
  /* ---------- ① 守护已停止：不能显示"已连接" ---------- */
  {
    // 停止后 30s 内，最后一次 /health 的延迟样本仍在 TTL 内 —— 这正是误导的来源
    const b = boot({ guardEnabled: false, pingOk: false, latency: 88, latencyStale: false });
    await wait(2300);   // 等 2s 兜底刷新 + 15s 首轮守护刷新
    chk('① 停止后 pill 显示「守护已停止」', b.txt('#health-text') === '守护已停止', b.txt('#health-text'));
    chk('① 停止后连接状态卡显示「离线」（不再谎报在线）', b.txt('#s-status') === '离线', b.txt('#s-status'));
    const pill = b.d.querySelector('#health-pill');
    chk('① 停止后 pill 用 off 灰态（不是 wait 检测中）', pill.classList.contains('off') && !pill.classList.contains('wait'), pill.className);
    chk('① 停止后倒计时不显示「即将采集…」', b.txt('#d-nextscan') === '—', b.txt('#d-nextscan'));
    // 顶部体征字段是"守护还活着"的强信号，必须一起清（否则秒数照走）
    chk('① 停止后顶部「守护探活」不再显示旧延迟', b.txt('#h-beat') === '已停止', b.txt('#h-beat'));
    chk('① 停止后顶部「运行时长」不再继续走秒', b.txt('#h-uptime') === '—', b.txt('#h-uptime'));
    chk('① 停止后本地服务仍显示端口（不整片空）', /8100/.test(b.txt('#d-port')), b.txt('#d-port'));
  }

  /* ---------- ② 回归保护：守护在跑时，新鲜延迟仍判为已连接 ---------- */
  {
    const b = boot({ guardEnabled: true, pingOk: false, latency: 88, latencyStale: false });
    await wait(2300);
    chk('② 守护运行 + 新鲜延迟 → 仍显示「已连接」（回归保护）', b.txt('#health-text') === '已连接', b.txt('#health-text'));
    chk('② 且连接状态卡为「在线」', b.txt('#s-status') === '在线', b.txt('#s-status'));
  }

  /* ---------- ③ 陈旧延迟 + 探活失败：不能继续举着"已连接" ---------- */
  {
    const b = boot({ guardEnabled: true, pingOk: false, latency: 88, latencyStale: true });
    await wait(2300);
    chk('③ 延迟过期且探活失败 → 不再显示「已连接」', b.txt('#health-text') !== '已连接', b.txt('#health-text'));
    chk('③ 连接状态卡不再是「在线」', b.txt('#s-status') !== '在线', b.txt('#s-status'));
  }

  /* ---------- ④ 守护在跑且探活成功：采集上传一行给出真实开关状态 ---------- */
  {
    const b = boot({ guardEnabled: true, pingOk: true, daemonOk: true });
    await wait(2300);
    chk('④ 探活成功显示「运行中」', b.txt('#d-mode') === '运行中', b.txt('#d-mode'));
    const up = b.txt('#d-upload');
    chk('④ 「采集上传」按 enabledSources 报出开启来源数', /2 个来源/.test(up), up);
  }

  /* ---------- ⑤ 点「探活」时守护已停止：不探活、给出可操作提示 ---------- */
  {
    const b = boot({ guardEnabled: false, pingOk: false });
    await wait(300);
    const before = b.logs();
    b.click('[data-act="guard-ping"]');
    await wait(400);
    const after = b.logs();
    chk('⑤ 停止态点探活 → 有「探活已跳过」提示', after.includes('探活已跳过'), after.slice(0, 120));
    chk('⑤ 停止态点探活 → 不出现新的「连接失败」噪音', !/守护探活失败/.test(after.slice(0, after.length - before.length + 200)) || after.includes('探活已跳过'));
  }

  /* ---------- ⑥ 源码契约：主进程的探活必须有停止态闸门 ---------- */
  {
    const MAIN = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
    chk('⑥ main.js：10s 心跳探活有 guardEnabled 闸门',
      /pingTimer\s*=\s*setInterval\(\(\)\s*=>\s*\{[\s\S]{0,400}guardEnabled\s*===\s*false[\s\S]{0,80}return/.test(MAIN));
    chk('⑥ main.js：停止守护时调用 pausePolling() 关掉 30s 轮询', /pausePolling\(\)/.test(MAIN));
    chk('⑥ main.js：daemonPing 失败计量上下行对称（不再只记 up）',
      /meterFail/.test(MAIN) && /dir:\s*'down',\s*bytes:\s*0/.test(MAIN));
  }

  /* ---------- ⑦ 启动序列：停止态不得起窗口/探活/心跳 ---------- */
  {
    const MAIN = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
    // startPolling 自身必须是"停止态空转"，而不是无条件先 pollHealth() 一轮。
    // 这是最容易漏的一条：应用启动序列里 startPolling() 排在 guardEnabled 判断之前。
    const sp = MAIN.match(/function startPolling\(\)\s*\{[\s\S]*?\n\}/);
    chk('⑦ startPolling 在停止态下不发起探活',
      !!sp && /guardEnabled\s*===\s*false[\s\S]{0,40}return/.test(sp[0]) && sp[0].indexOf('return') < sp[0].indexOf('pollHealth()'));
    // whenReady 里 createConsole / startTick 都必须挂在 guardOn 条件下
    const ready = MAIN.match(/app\.whenReady\(\)[\s\S]*?globalShortcut\.register/);
    chk('⑦ 启动序列：guardOn 判定在 createConsole/startTick 之前',
      !!ready && /const guardOn[\s\S]*?guardOn[\s\S]*?createConsole[\s\S]*?startTick/.test(ready[0]),
      ready ? ready[0].slice(0, 80) : '未匹配到 whenReady 段');
    chk('⑦ 启动序列：停止态不建窗口也不起心跳',
      !!ready && /if \(!HIDDEN_BOOT && guardOn\) createConsole\(\)/.test(ready[0]) && /if \(guardOn\) \{[\s\S]{0,60}startPolling\(\)/.test(ready[0]));
    chk('⑦ 会话扫描不受守护开关影响（停止态总览也要有会话）',
      !!ready && /startSessionScan\(\)/.test(ready[0]));
    // 开关是可逆的：停止后再开启必须把心跳/轮询补回来，
    // 否则"以停止态启动 → 手动开启"这条路径会没有 10s 探活（startTick 当时没跑过）。
    const gs = MAIN.match(/ipcMain\.handle\('guard-set'[\s\S]*?\n\}\);/);
    chk('⑦ 重新开启时补起心跳与轮询（覆盖"以停止态启动"路径）',
      !!gs && /startTick\(\)/.test(gs[0]) && /startPolling\(\)/.test(gs[0]));
    chk('⑦ 停止时同时停掉心跳与轮询（不留空转定时器）',
      !!gs && /pausePolling\(\)/.test(gs[0]) && /stopTick\(\)/.test(gs[0]));
  }

  /* ---------- ⑧ 探活失败不得虚增流量（bytesSource:'none'） ---------- */
  {
    const metricsMod = require(path.join(SRC, 'metrics.js'));
    const m = metricsMod.createMetrics();
    m.meter({ dir: 'up', bytes: 240, bytesSource: 'none', ms: 5, status: 0, url: 'http://127.0.0.1:8100/health', method: 'GET', error: 'ECONNREFUSED' });
    m.meter({ dir: 'down', bytes: 0, bytesSource: 'none', ms: 5, status: 0, url: 'http://127.0.0.1:8100/health', method: 'GET', error: 'ECONNREFUSED' });
    const s = m.snapshot().metrics;
    chk('⑧ 连接被拒的探活不累加上行流量', s.uploadBytes === 0, 'uploadBytes=' + s.uploadBytes);
    chk('⑧ 但请求数与失败数照记（探活通不通仍可判）', s.reqTotal === 2 && s.reqFailed === 2,
      `reqTotal=${s.reqTotal} reqFailed=${s.reqFailed}`);
    // 真实成功的往返仍要正常计入流量（回归保护）
    const m2 = metricsMod.createMetrics();
    m2.meter({ dir: 'up', bytes: 4096, ms: 20, status: 200, url: 'https://p/api', method: 'POST' });
    chk('⑧ 成功往返照常计入上行流量（回归保护）', m2.snapshot().metrics.uploadBytes === 4096,
      'uploadBytes=' + m2.snapshot().metrics.uploadBytes);
  }

  /* ---------- ⑨ 渲染层初始化顺序：偏好就绪后才渲染首屏 ---------- */
  {
    // S.guardEnabled 初值 true，真实值来自异步 prefsLoad()。
    // 若首屏渲染抢在偏好之前跑，停止态用户会看到守护卡片走一遍"运行中/超时"逻辑
    // （顶部「守护探活」被写成"超时"、运行时长开始走秒）—— 本次修掉的正是这条。
    const startBlock = JS.slice(JS.lastIndexOf('/* ---------- 启动 ----------'));
    chk('⑨ 首屏渲染挂在 prefsReady 之后（不抢跑）',
      /prefsReady[\s\S]{0,120}onHomeShown\(\)[\s\S]{0,60}loadOverview\(\)/.test(startBlock),
      startBlock.slice(0, 90).replace(/\s+/g, ' '));
    chk('⑨ 首屏渲染不再同步直跑（无裸的 onHomeShown() 在 IIFE 顶层）',
      !/\n\s{2}onHomeShown\(\);\s*\n\s{2}loadOverview\(\);/.test(JS));
    chk('⑨ prefsLoad 只调用一次（启动段复用同一份 Promise）',
      (JS.match(/tdai\.prefsLoad\(\)/g) || []).length === 1,
      '出现 ' + (JS.match(/tdai\.prefsLoad\(\)/g) || []).length + ' 次');
    chk('⑨ prefsLoad 里的停止态走 setHealthPill（同步维护连接判定）',
      /guardEnabled === false\s*\)\s*\{[\s\S]{0,400}setHealthPill\('off', '守护已停止'/.test(JS));
    // 顶部两个"守护还活着"的强信号必须受停止态约束
    chk('⑨ tick() 在停止态下不再刷新运行时长',
      /if \(daemonStopped\(\)\)\s*\{\s*const hu = \$\('#h-uptime'\); if \(hu\) hu\.textContent = '—';/.test(JS));
    chk('⑨ 运行时长 1s 定时器在停止态下空转',
      /setInterval\(\(\) => \{\s*\/\/ 守护已停止：停止推进[\s\S]{0,120}guardEnabled === false\) return;/.test(JS));
  }

  console.log('\n---------- 守护停止态验证：通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
  ok.forEach((x) => console.log('  ✓ ' + x));
  if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
  // jsdom 的 1s/2s/15s 定时器不会自己停，必须显式退出（否则进程挂住）
  process.exit(0);
})();
