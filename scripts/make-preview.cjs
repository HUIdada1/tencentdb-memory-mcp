// scripts/make-preview.cjs — 生成控制台「总览」页的独立可交互预览
// 用真实 console.html / console.css / console.js，只把 preload 桥替换成演示数据桥，
// 便于在没有 Electron 二进制的环境下直接看界面与交互。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'pet', 'src');
const OUT_DIR = path.join(ROOT, '.preview');
const OUT = path.join(OUT_DIR, 'console-preview.html');

let html = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'console.css'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

// 同样用函数形式替换，避免 CSS 里出现 `$` 时被误转义
html = html.replace(/<link[^>]*console\.css[^>]*>/, () => '<style>\n' + css + '\n</style>');

// ★ 关键：console.html 的注释里也出现了 "console.js" 字样（隐藏 tab 的说明文字）。
//   若直接 replace，注释块里的那次也会被替换成内联 JS —— 同一段 JS 注入两次，
//   第二次的 `const $` 会抛 "Identifier '$' has already been declared"。
//   所以必须在「非注释区域」做替换。
// ★ 另一个坑：替换串里若直接含 `$$`（console.js 里就有 `const $$ = ...`），
//   String.replace 会把 `$$` 解释成转义的 `$`，导致代码被悄悄改坏。
//   必须用「函数形式」的替换，返回值不做 `$` 转义。
function replaceOutsideComments(src, re, repl) {
  const parts = src.split(/(<!--[\s\S]*?-->)/);
  return parts.map((p) => (p.startsWith('<!--') ? p : p.replace(re, () => repl))).join('');
}
html = replaceOutsideComments(html, /<script[^>]*console\.js[^>]*><\/script>/,
  '<script>\n(function(){\n' + js + '\n})();\n</script>');

/* ---------- 演示数据桥 ---------- */
const BRIDGE = `
<script>
(function () {
  'use strict';
  var now = Date.now();
  var snap = {
    ok: true, at: now, uptime: 7200000,
    panelUrl: 'https://docs.qq.com/panel',
    panelOk: true, panelError: '', panelOkAt: now, daemonOk: true, daemonOkAt: now,
    metrics: {
      upSpeed: 184 * 1024, downSpeed: 642 * 1024,
      uploadBytes: 38294512, downloadBytes: 128473920,
      uploadRequests: 412, downloadRequests: 1567,
      uploadCommits: 388, uploadFails: 4, downloadFails: 2,
      uploadPeak: 2.4 * 1024 * 1024, downloadPeak: 5.1 * 1024 * 1024,
      reqTotal: 1979, reqFailed: 6, downloadAvgMs: 142, latency: 88,
      currentUp: '/api/v1/memory/commit', currentDown: '/api/v1/memory/search',
      upTask: { label: '/api/v1/memory/commit', state: 'pending', dir: 'up', bytes: 0, ms: null, status: null },
      downTask: { label: '/api/v1/memory/search', state: 'done', dir: 'down', bytes: 9834, ms: 142, status: 200 }
    },
    series: { t: [], up: [], down: [], lat: [] },
    sessions: [
      { id: 'zcode:sess_9880', label: '把项目顶部的 tab 隐藏', source: 'zcode', state: 'thinking', turns: 911, lastTs: now - 8000,
        lastNote: '审查完成。我已完整读取 4 个模块的 Controller、ServiceImpl、Mapper 与配置，结论如下…' },
      { id: 'zcode:sess_2c29', label: '调研登录鉴权现状', source: 'zcode', state: 'idle', turns: 616, lastTs: now - 420000,
        lastNote: '调研完成。以下是汇总报告。当前小程序端与后台端的鉴权链路存在差异…' },
      { id: 'claude:sess_a71f', label: '整理记忆上传格式', source: 'claude-code', state: 'stale', turns: 42, lastTs: now - 7200000,
        lastNote: '已按 type/payload 结构重写解析器，并补上 lastNote 字段。' }
    ],
    logs: [
      { seq: 9, ts: '19:08:41', level: 'error', msg: '上行 HTTP 500 · /api/v1/memory/commit', detail: 'HTTP 500' },
      { seq: 8, ts: '19:08:39', level: 'ok', msg: '完成 上行 /api/v1/memory/commit · 128ms', detail: '' },
      { seq: 7, ts: '19:08:36', level: 'warn', msg: '下行 连接失败 · /api/v1/memory/search', detail: '' },
      { seq: 6, ts: '19:08:32', level: 'info', msg: '守护进程已就绪 · 本地服务 127.0.0.1:8765', detail: '' },
      { seq: 5, ts: '19:08:30', level: 'info', msg: '会话扫描完成 · 30 个文件', detail: '' }
    ],
    logSeq: 9
  };
  for (var i = 0; i < 40; i++) {
    var w = i / 40 * Math.PI * 2;
    snap.series.t.push(now - (40 - i) * 1000);
    snap.series.up.push(Math.round(120 * 1024 + Math.abs(Math.sin(w)) * 260 * 1024));
    snap.series.down.push(Math.round(300 * 1024 + Math.abs(Math.cos(w)) * 520 * 1024));
    snap.series.lat.push(Math.round(60 + Math.abs(Math.sin(w * 1.7)) * 90));
  }

  var handlers = {};
  function mk(v) { return function () { return Promise.resolve(v); }; }
  window.tdai = {
    appInfo: mk({ version: '0.4.1', port: 8765, panelUrl: 'https://docs.qq.com/panel', teamId: 'td-team',
      agentId: 'agent-01', blockId: 'chat-memory', assets: 30, memMb: 96 }),
    connLoad: mk({ panelUrl: 'https://docs.qq.com/panel', userKey: 'ak_x8f2c', teamId: 'td-team',
      agentId: 'agent-01', blockId: 'chat-memory' }),
    connTest: mk({ ok: true, ms: 88, status: 200 }), connSave: mk({ ok: true }),
    prefsLoad: mk({ ui: { theme: 'light' }, system: { autoStart: true }, update: { autoCheck: true } }),
    prefsSave: mk({ ok: true }),
    agentsStatus: mk([
      { id: 'claude-code', name: 'Claude Code', installed: true },
      { id: 'codebuddy', name: 'CodeBuddy', installed: true },
      { id: 'cursor', name: 'Cursor', installed: false }
    ]),
    agentsRegister: mk({ ok: true, results: [], items: [] }),
    toolCall: mk({ ok: true, data: { list: [
      { content: '排涝站数据库设计要点：采用分层建模…', score: 0.93 },
      { content: '记忆块 chat-memory 支持按 teamId 隔离', score: 0.88 }
    ] } }),
    metricsGet: mk(snap),
    sessionsScan: mk({ ok: true, files: 30, total: 30, sessions: snap.sessions }),
    cursorStats: mk({ ok: true, count: 30, bySource: { zcode: 28, claude: 2 }, seeded: 12, pending: 18 }),
    daemonPing: mk({ ok: true, ms: 7, payload: {
      version: '0.4.1', uptimeSince: new Date(now - 7200000).toISOString(),
      lastPush: new Date(now - 45000).toISOString(), queueLen: 3, hookCalls: 128 } }),
    copyText: mk({ ok: true }), revealPath: mk({ ok: true }), openExternal: mk({ ok: true }),
    reportFlow: function () { },
    updateGet: mk({ state: 'idle', version: '0.4.1' }), updateCheck: mk({ state: 'idle' }),
    updateDownload: mk({ state: 'idle' }), updateInstall: mk({ state: 'idle' }),
    updateOpenReleases: mk({ ok: true }), updateOpenRepo: mk({ ok: true }),
    winMin: function () { }, winClose: function () { }, quit: function () { },
    on: function (ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); return function () { }; }
  };

  // 让预览页的指标"活"起来：每秒微调速率，模拟心跳
  var tick = 0;
  setInterval(function () {
    tick++;
    var m = snap.metrics;
    m.upSpeed = Math.round((120 + Math.abs(Math.sin(tick / 5)) * 300) * 1024);
    m.downSpeed = Math.round((280 + Math.abs(Math.cos(tick / 7)) * 620) * 1024);
    m.uploadBytes += m.upSpeed;
    m.downloadBytes += m.downSpeed;
    m.reqTotal += 2;
    m.latency = Math.round(70 + Math.abs(Math.sin(tick / 3)) * 60);
    snap.series.up.push(m.upSpeed); snap.series.down.push(m.downSpeed); snap.series.lat.push(m.latency);
    if (snap.series.up.length > 60) { snap.series.up.shift(); snap.series.down.shift(); snap.series.lat.shift(); }
    // 心跳推进 at，让运行时长本地推算持续增长
    snap.at = Date.now();
    snap.uptime += 1000;
    (handlers['metrics'] || []).forEach(function (cb) { cb({ payload: snap }); });
  }, 1000);
})();
</script>
`;

html = html.replace('</head>', BRIDGE + '</head>');
html = html.replace('</body>',
  '<div style="position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff3cd;color:#664d03;'
  + 'border-top:1px solid #ffe69c;padding:4px 10px;font:12px/1.5 system-ui;text-align:center">'
  + '预览模式：布局与交互为真实代码，数据为演示造数（未连接真实记忆库）</div></body>');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('[preview] 已生成 ' + path.relative(ROOT, OUT) + '  (' + (html.length / 1024).toFixed(1) + ' KB)');
