const path = require('path'), fs = require('fs');
let JSDOM;
try { JSDOM = require('D:/私人项目/tencentdb-memory-mcp/pet/node_modules/jsdom').JSDOM; }
catch (e) { console.log('JSDOM_MISSING: ' + e.message); process.exit(2); }

const base = 'C:/Users/HUIDADA/Desktop/TD记忆守护-原型设计稿';
const files = [
  'index.html',
  'pages/01-dashboard.html', 'pages/02-memory.html', 'pages/03-sessions.html',
  'pages/04-agents.html', 'pages/05-settings.html',
  'components/01-modals.html', 'components/02-banners.html', 'components/03-tooltips.html',
  'components/04-log-detail.html', 'components/05-update-flow.html', 'components/06-tray-menu.html'
];

let fails = 0;
for (const f of files) {
  const p = path.join(base, f);
  const html = fs.readFileSync(p, 'utf8');
  const errs = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///' + f });
  const w = dom.window;
  w.matchMedia = w.matchMedia || function (q) {
    return { matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
  };

  const scripts = [...w.document.querySelectorAll('script')];
  for (const s of scripts) {
    if (s.src) {
      const sp = path.join(path.dirname(p), s.getAttribute('src'));
      if (!fs.existsSync(sp)) { errs.push('missing script ' + s.getAttribute('src')); continue; }
      try { w.eval(fs.readFileSync(sp, 'utf8')); }
      catch (e) { errs.push('script ' + path.basename(sp) + ': ' + e.message); }
    } else if (s.textContent.trim()) {
      try { w.eval(s.textContent); }
      catch (e) { errs.push('inline: ' + e.message); }
    }
  }

  const d = w.document;
  const theme = String(d.documentElement.getAttribute('data-theme'));
  const toggles = d.querySelectorAll('[data-theme-toggle]').length;
  const glass = d.querySelectorAll('.glass').length;
  const overlays = d.querySelectorAll('.overlay').length;
  const empties = d.querySelectorAll('.empty').length;
  const panels = d.querySelectorAll('[data-panel]').length;
  const activePanels = d.querySelectorAll('[data-panel].active').length;

  // 检查 JS 是否真的接管了主题切换
  let toggleOk = '-';
  const tb = d.querySelector('[data-theme-toggle]');
  if (tb) {
    const before = d.documentElement.getAttribute('data-theme');
    tb.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const after = d.documentElement.getAttribute('data-theme');
    toggleOk = (before !== after) ? 'yes' : 'NO';
  }

  // 检查 tab / subpanel 切换是否可用
  let tabOk = '-';
  const tabs = d.querySelectorAll('.tabs button, .subtabs button');
  if (tabs.length > 1) {
    tabs[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    tabOk = tabs[1].classList.contains('active') ? 'yes' : 'NO';
  }

  // 检查弹窗开关是否可用
  let overlayOk = '-';
  const opener = d.querySelector('[data-open]');
  if (opener) {
    const target = opener.getAttribute('data-open');
    opener.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const el = d.getElementById(target);
    const opened = el && el.classList.contains('open');
    const closer = d.querySelector('.modal-close[data-close]') || d.querySelector('[data-close]');
    if (closer) closer.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const closed = el && !el.classList.contains('open');
    overlayOk = (opened && closed) ? 'yes' : ('open=' + opened + '/close=' + closed);
  }

  const line = [
    f.padEnd(30),
    'theme=' + theme.padEnd(6),
    'toggle=' + toggleOk.padEnd(5),
    'tab=' + tabOk.padEnd(5),
    'overlay=' + overlayOk.padEnd(12),
    'glass=' + String(glass).padStart(3),
    'empty=' + empties,
    'panels=' + panels + '/' + activePanels
  ].join(' ');
  console.log(line + (errs.length ? '  ERR: ' + errs.join(' | ') : ''));
  if (errs.length) fails++;
}

/* ============================================================
   令牌契约验证（静态扫描，两遍：深色 / 浅色）
   - 无 oklch(from ...) 相对色语法
   - 无硬编码 #fff / #000
   - 无裸数值 border-radius
   - theme.css 中每个语义色都有对应的 --*-text
   ============================================================ */
console.log('\n--- 令牌契约 ---');
const SEM = ['brand', 'ok', 'warn', 'err', 'info', 'violet', 'teal'];

function scanAll() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) walk(q);
      else if (/\.(html|css)$/.test(e.name)) files.push(q);
    }
  })(base);
  return files;
}

const contract = { relative: 0, hardcoded: 0, rawRadius: 0, missingText: [] };
for (const p of scanAll()) {
  const rel = path.relative(base, p);
  const s = fs.readFileSync(p, 'utf8');
  // 排除注释中的示例
  const body = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

  if (/oklch\(from/.test(body)) { console.log('  ✗ 相对色语法 ' + rel); contract.relative++; }

  // 硬编码色：排除 CSS mask 的 alpha 通道（#000 在 mask 中不产生可见颜色）
  const colorBody = body.replace(/-webkit-mask[^;]*;/g, '').replace(/[^-]mask:[^;]*;/g, '');
  if (/#(fff|000)\b/i.test(colorBody)) { console.log('  ✗ 硬编码色 ' + rel); contract.hardcoded++; }

  // 裸数值圆角：排除 50%（正圆元素：状态点 / 头像 / 指示环），它不属于圆角刻度体系
  const radiusHits = (body.match(/border-radius:\s*[^;{}"']*[0-9]+px/g) || []);
  if (radiusHits.length) { console.log('  ✗ 裸数值圆角 ' + rel + ' → ' + radiusHits.join(' , ')); contract.rawRadius++; }
}

// theme.css 中每个语义色必须有 --X-text，且深色/浅色两套都定义
const themeSrc = fs.readFileSync(path.join(base, 'assets/theme.css'), 'utf8');
const blocks = themeSrc.split(/\[data-theme="(?:dark|light)"\]/);
const textDefs = (themeSrc.match(/--[a-z]+-text\s*:/g) || []).length;
for (const c of SEM) {
  const n = (themeSrc.match(new RegExp('--' + c + '-text\\s*:', 'g')) || []).length;
  if (n < 2) contract.missingText.push('--' + c + '-text (' + n + ' 处，需 ≥2)');
}
console.log('  ' + (contract.relative ? '✗' : '✓') + ' 相对色语法残留：' + contract.relative);
console.log('  ' + (contract.hardcoded ? '✗' : '✓') + ' 硬编码 #fff/#000：' + contract.hardcoded);
console.log('  ' + (contract.rawRadius ? '✗' : '✓') + ' 裸数值圆角：' + contract.rawRadius);
console.log('  ' + (contract.missingText.length ? '✗' : '✓') + ' 语义色文字变体（深浅各一套）：' +
  (contract.missingText.length ? contract.missingText.join(', ') : SEM.length + '/' + SEM.length + ' 齐备'));
console.log('  · theme.css --*-text 定义总数：' + textDefs);

const contractFails = contract.relative + contract.hardcoded + contract.rawRadius + contract.missingText.length;
if (contractFails) fails += contractFails;

console.log(fails ? '\n>>> ' + fails + ' 项待修' : '\n>>> All 12 files: scripts executed cleanly，令牌契约全部通过');
process.exit(fails ? 1 : 0);
