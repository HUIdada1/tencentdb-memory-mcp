const path = require('path'), fs = require('fs');
const { JSDOM } = require('D:/私人项目/tencentdb-memory-mcp/pet/node_modules/jsdom');
const p = 'C:/Users/HUIDADA/Desktop/TD记忆守护-原型设计稿/index.html';
const html = fs.readFileSync(p, 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///index.html' });
const w = dom.window;
w.matchMedia = w.matchMedia || function (q) {
  return { matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
};

console.log('[A] readyState before script eval =', w.document.readyState);

// 打补丁：劫持 addEventListener 观察是否绑定 DOMContentLoaded
const origAdd = w.document.addEventListener.bind(w.document);
let dclBound = false;
w.document.addEventListener = function (type, ...rest) {
  if (type === 'DOMContentLoaded') dclBound = true;
  return origAdd(type, ...rest);
};

const src = fs.readFileSync(path.join(path.dirname(p), 'assets/proto.js'), 'utf8');
try {
  w.eval(src);
  console.log('[B] proto.js evaluated OK');
} catch (e) {
  console.log('[B] proto.js THREW:', e.message);
}

console.log('[C] readyState after  eval   =', w.document.readyState);
console.log('[D] DOMContentLoaded bound   =', dclBound);
console.log('[E] TDProto exported         =', typeof w.TDProto);

// 手动派发 DOMContentLoaded（jsdom 已过该阶段，模拟浏览器时序）
w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
console.log('[F] after synthetic DCL      =', w.document.documentElement.getAttribute('data-theme'));

const tb = w.document.querySelector('[data-theme-toggle]');
tb.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
console.log('[G] after toggle click       =', w.document.documentElement.getAttribute('data-theme'));
