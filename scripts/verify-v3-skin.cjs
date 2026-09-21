/* ============================================================
   验证 v3 换肤在真实 console.html + console.js + console.css 上的落地
   —— 断言"行为生效"，而不是"元素存在"（后者会漏掉静默失效）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'pet', 'src');
const JSDOM = require(path.join(ROOT, 'pet', 'node_modules', 'jsdom')).JSDOM;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.log('  \u2717 ' + name + ' \u2192 ' + (e && e.message)); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const html = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'console.css'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');

const noop = () => {};
const okAsync = async () => ({});
const dom = new JSDOM(html.replace('<link rel="stylesheet" href="console.css">', '<style>' + css + '</style>'),
  { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }));
// tdai 用 Proxy 兜底：任何未显式 stub 的 API 都返回一个 resolved Promise，
// 避免 console.js 的启动链路因缺少某个方法而中断（中断会让后面的绑定不执行）。
const anyAsync = () => Promise.resolve();
window.tdai = new Proxy({
  prefsLoad: async () => ({ ui: { theme: 'dark' }, system: {}, update: {} }),
}, {
  get(target, k) {
    if (k in target) return target[k];
    return (...args) => Promise.resolve({});
  },
});

console.log('\n[v3 换肤] 渲染层实跑验证\n');

t('环境层：.ambient + .grain 已注入 body', () => {
  assert(doc.querySelector('body > .ambient'), '.ambient 缺失');
  assert(doc.querySelector('.ambient .blob-c'), '.blob-c 缺失（三色光晕的第三色）');
  assert(doc.querySelector('body > .grain'), '.grain 缺失');
});

t('CSS：青碧令牌已定义（--brand hue 197）', () => {
  assert(/--brand:\s*oklch\(0\.552 0\.098 197\)/.test(css), '--brand 不是青碧 197');
  assert(/--brand-text:/.test(css), '--brand-text 缺失（双主题前景色）');
});

t('CSS：语义色相已重排避免撞色', () => {
  assert(/--ok:\s*oklch\(0\.545 0\.098 145\)/.test(css), 'ok 未改为 145');
  assert(/--info:\s*oklch\(0\.535 0\.098 262\)/.test(css), 'info 未改为 262');
  assert(/--teal:\s*oklch\(0\.545 0\.078 215\)/.test(css), 'teal 未改为 215');
});

t('CSS：圆角刻度 6 档 + pill 齐备', () => {
  ['--r-xs', '--r-s', '--r-m', '--r-l', '--r-xl', '--r-2xl', '--r-pill']
    .forEach((s) => assert(new RegExp(s.replace(/-/g, '\\-') + ':\\s*\\d').test(css), '缺 ' + s));
  ['4px', '6px', '8px', '12px', '16px', '20px']
    .forEach((v) => assert(css.includes(v), '缺刻度值 ' + v));
});

t('CSS：无 oklch(from ...) 相对色语法', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/oklch\(\s*from/.test(code), '仍存在相对色语法');
});

t('CSS：无裸 border-radius 数值', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = code.match(/border-radius:\s*[0-9.]+px(?!\s*(?:\/\*|$))/g) || [];
  assert(bad.length === 0, '存在裸圆角：' + bad.join(', '));
});

t('CSS：--font-num 已定义（防静默字体回退）', () => {
  assert(/--font-num:\s*var\(--font-sans\)/.test(css), '--font-num 未定义');
});

t('CSS：八态关键选择器齐备', () => {
  [':hover', ':active', ':focus-visible', '[disabled]', '[data-loading="true"]', '[aria-invalid="true"]']
    .forEach((s) => assert(css.includes(s), '缺状态 ' + s));
});

t('CSS：点击点波纹用 --rx / --ry 且带兜底', () => {
  assert(/var\(--rx,\s*50%\)/.test(css), '波纹未使用 --rx 兜底值');
  assert(/var\(--ry,\s*50%\)/.test(css), '波纹未使用 --ry 兜底值');
});

t('SVG：仪表盘与波形已改为 CSS 令牌（不再硬编码 hex）', () => {
  ['stroke="var(--brand)"', 'stroke="var(--teal)"', 'url(#sparkGrad)']
    .forEach((s) => assert(html.includes(s), '未替换：' + s));
  assert(!/stroke="#[0-9A-Fa-f]{6}"/.test(html), '仍有硬编码 hex stroke');
});

t('JS：波纹绑定已写入 --rx / --ry', () => {
  assert(/setProperty\('--rx'/.test(js), '未写 --rx');
  assert(/setProperty\('--ry'/.test(js), '未写 --ry');
  assert(/pointerdown/.test(js), '未监听 pointerdown');
});

t('JS：主题切换会替换按钮图标', () => {
  assert(/IC_SUN/.test(js) && /IC_MOON/.test(js), '图标常量缺失');
  assert(/b\.innerHTML\s*=\s*t === 'dark'/.test(js), 'applyTheme 未换图标');
});

t('行为：派发 pointerdown 后 --rx/--ry 真的被写入按钮', () => {
  // 先执行 console.js 完成绑定
  window.Function(js).call(window);
  const btn = doc.querySelector('#btn-theme');
  assert(btn, '#btn-theme 不存在');
  btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });
  const ev = new window.Event('pointerdown', { bubbles: true });
  ev.clientX = 25; ev.clientY = 10;
  btn.dispatchEvent(ev);
  const rx = btn.style.getPropertyValue('--rx');
  const ry = btn.style.getPropertyValue('--ry');
  assert(rx === '25.00%', '--rx 应为 25.00%，实际 "' + rx + '"');
  assert(ry === '25.00%', '--ry 应为 25.00%，实际 "' + ry + '"');
});

console.log('\n---------- v3 换肤：通过 ' + pass + ' / 失败 ' + fail + ' ----------\n');
process.exit(fail ? 1 : 0);
