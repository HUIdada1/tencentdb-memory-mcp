// test/preview-verify.test.js — 校验生成的预览页能真实渲染（不联网、不需 Electron）
'use strict';
const fs = require('fs');
const path = require('path');

const JSDOM_DIR = path.join(__dirname, '..', 'pet', 'node_modules', 'jsdom');
let JSDOM;
try { ({ JSDOM } = require(JSDOM_DIR)); }
catch (e) { console.error('[preview] jsdom 不可用：' + e.message); process.exit(2); }

const FILE = path.join(__dirname, '..', '.preview', 'console-preview.html');
if (!fs.existsSync(FILE)) {
  console.error('[preview] 找不到 ' + FILE + '，请先跑 node scripts/make-preview.cjs');
  process.exit(2);
}

const html = fs.readFileSync(FILE, 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.matchMedia = w.matchMedia || ((q) => ({
  matches: false, media: q, onchange: null,
  addListener() { }, removeListener() { }, addEventListener() { },
  removeEventListener() { }, dispatchEvent() { return false; },
}));

const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e && e.message)));

setTimeout(() => {
  const d = w.document;
  const txt = (s) => { const e = d.querySelector(s); return e ? e.textContent.trim() : '<缺失>'; };
  const n = (s) => d.querySelectorAll(s).length;

  const checks = [
    ['连接状态有文案', txt('#live-text') !== '<缺失>' && txt('#live-text').length > 0],
    ['延迟已填充', /ms/.test(txt('#h-latency'))],
    // 副标题是唯一的实时链路读数（面板地址 / 延迟 / 上下行速率）
    ['副标题含实时链路读数', /面板延迟 .+ · 链路 .+↑ .+↓/.test(txt('#live-sub')), txt('#live-sub')],
    // 已删除的重复展示：延迟波形 / 面板卡 / 三张重复指标卡
    ['无延迟波形残留', n('#spark-line') === 0],
    ['无「记忆库面板」卡', txt('#h-panel') === '<缺失>'],
    ['无重复的上下行速度卡', txt('#s-up') === '<缺失>' && txt('#s-down') === '<缺失>'],
    ['无重复的连接状态卡', txt('#s-status') === '<缺失>'],
    ['指标卡只剩 3 张', n('.home-top .stat-row .stat') === 3, String(n('.home-top .stat-row .stat'))],
    ['首排与指标卡同排（已分半）', (d.querySelector('#home-split') || {}).className && d.querySelector('#home-split').classList.contains('split')],
    ['请求数已填充', /^\d+$/.test(txt('#s-reqs'))],
    ['会话列表有行', n('#sess-list .sess-row') >= 3],
    ['会话摘要已渲染', d.querySelector('#sess-list').textContent.includes('审查完成')],
    ['上行卡累计已填充', /B|KB|MB/.test(txt('#up-total'))],
    ['上行任务名已填充', txt('#up-task-name') !== '暂无上传任务'],
    ['下行卡峰值已填充', /B|KB|MB/.test(txt('#down-peak'))],
    ['日志有 5 条', n('#log-list .log-row') === 5],
    ['日志时间戳存在', /\d{1,2}:\d{2}:\d{2}/.test(d.querySelector('#log-list .log-t').textContent)],
    ['日志级别有区分', new Set(Array.from(d.querySelectorAll('#log-list .log-lv')).map((x) => x.className)).size >= 3],
    ['守护模式为运行中', txt('#d-mode') === '运行中'],
    ['游标文件数已填充', /30/.test(txt('#d-files'))],
    ['端口已填充', /127\.0\.0\.1:\d+/.test(txt('#d-port'))],
    ['上行柱图有柱', n('#up-bars i') > 0],
    ['下行柱图有柱', n('#down-bars i') > 0],
    ['可见 tab 为 5 个（含实时会话）', Array.from(d.querySelectorAll('#tabs button')).map((b) => b.dataset.tab).join(',') === 'home,memory,live,agent,settings'],
    ['隐藏 tab 不可见', !d.querySelector('#tabs button[data-tab="skills"]')],
    ['总览已无快速检索', !d.querySelector('#qs-input')],
    ['设置页有作者信息', (d.querySelector('.page[data-page="settings"] .author-name') || {}).textContent === '沐辉'],
    ['无页面级 JS 错误', errors.length === 0],
  ];

  console.log('\n[preview] 预览页渲染校验（jsdom 实跑真实 console.html/js）\n');
  let bad = 0;
  for (const [name, ok] of checks) {
    if (ok) console.log('  \u2713 ' + name);
    else { bad++; console.log('  \u2717 ' + name); }
  }
  if (errors.length) console.log('\n  页面错误：\n    ' + errors.join('\n    '));
  console.log('\n结果：' + (checks.length - bad) + ' 通过 / ' + bad + ' 失败\n');
  process.exit(bad ? 1 : 0);
}, 2600);   // 预览桥每秒推一次快照；延迟波形需 ≥2 个采样点，故多等两拍
