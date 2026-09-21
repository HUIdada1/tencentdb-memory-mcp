/* 校验：所有 var(--x) 引用都必须在 theme.css 中有定义 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/Users/HUIDADA/Desktop/TD记忆守护-原型设计稿';

const theme = fs.readFileSync(path.join(ROOT, 'assets/theme.css'), 'utf8');
const defined = new Set();
for (const m of theme.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);

/* JS 运行时注入的变量（非 CSS 声明），白名单豁免 */
const JS_SET = new Set(['--rx', '--ry']);

/* 保留令牌：已定义但当前无引用，供后续页面复用，不算错误 */
const RESERVED = new Set(['--ok-deep', '--warn-deep', '--ok-softer', '--warn-softer', '--info-softer']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, out);
    else if (/\.(html|css|js)$/.test(e.name)) out.push(q);
  }
  return out;
}

const missing = new Map();
for (const f of walk(ROOT, [])) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
    const v = m[1];
    if (defined.has(v) || JS_SET.has(v)) continue;
    // 注释里的伪变量（如文档示例 oklch(from var(--x) …)）
    if (/var\(\s*--x\s*[,)]/.test(s) && v === '--x') continue;
    // 局部定义（比如某个组件自己声明的）
    const localRe = new RegExp('(^|[;{\\s])' + v + '\\s*:', 'm');
    if (localRe.test(s)) continue;
    if (!missing.has(v)) missing.set(v, []);
    missing.get(v).push(path.relative(ROOT, f));
  }
}

console.log('theme.css 定义变量数：' + defined.size);
console.log('JS 注入变量（豁免）：' + [...JS_SET].join(', '));
if (!missing.size) {
  console.log('✔ 无未定义变量引用');
} else {
  for (const [v, files] of missing) {
    console.log('✗ ' + v + '  → ' + [...new Set(files)].join(', '));
  }
}

/* 反向：定义了但全仓无人使用的变量 */
const unused = [];
const allText = walk(ROOT, []).map(f => fs.readFileSync(f, 'utf8')).join('\n');
for (const v of defined) {
  if (RESERVED.has(v)) continue;
  const uses = allText.split('var(' + v + ')').length - 1
             + allText.split('var( ' + v + ' ').length - 1;
  if (uses === 0) unused.push(v);
}
console.log('\n保留令牌（' + RESERVED.size + '）：' + [...RESERVED].join(', '));
console.log('意外未被引用的变量（' + unused.length + '）：' + (unused.join(', ') || '无'));
process.exitCode = (missing.size || unused.length) ? 1 : 0;
