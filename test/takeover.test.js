// 功能校验：过期守护进程接管逻辑（pet/src/guard.js）
//
// 背景（2026-09-22）：本机 :8100 长期被 v0.2.2 老守护占用，应用已升到 0.5.7，
// 但旧逻辑遇到 EADDRINUSE 一律「让位」，导致新版本永远不会自我纠正、
// 新接口（如 /api/backfill/inventory）静默不可用。
//
// 本测试覆盖两块：
//   1. 纯函数：gtVer 版本比较、findListenPid 端口占用解析、module.exports 契约
//   2. 静态检查：start() 的 EADDRINUSE 分支确实接了 tryTakeover，且护栏齐全
//
// 注意：不做真实 kill 操作 —— 跑测试时杀用户进程是不可接受的副作用。
// 真实接管链路（杀 → 抢端口 → 起新版）已在开发阶段手工验证通过。
'use strict';
const fs = require('fs');
const path = require('path');

const g = require('../pet/src/guard.js');
const SRC = path.resolve(__dirname, '..', 'pet', 'src');
const code = fs.readFileSync(path.join(SRC, 'guard.js'), 'utf8');
// 剥离注释后再做残留匹配，避免注释里的历史说明误报（踩过的坑）
const live = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const results = [];
function check(name, ok) { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); }

/* ---------- 1. gtVer 版本比较 ---------- */

const VER_CASES = [
  // [自身, 外部, 期望是否"自身更高"]
  ['0.5.7', '0.2.2', true],    // 本机真实场景
  ['0.2.2', '0.5.7', false],
  ['0.5.7', '0.5.7', false],   // 同版本 → 让位
  ['0.5.10', '0.5.9', true],   // 数值比较而非字典序
  ['0.5.9', '0.5.10', false],
  ['v0.6.0', '0.5.7', true],   // v 前缀
  ['1.0.0', '0.99.99', true],
  ['0.5.7', '0.5.7.1', false], // 段数不同
  ['0.5.7', '', true],
  ['', '0.2.2', false],
];
let verOk = 0;
for (const [a, b, exp] of VER_CASES) {
  if (g.gtVer(a, b) === exp) verOk++;
  else console.log(`     ↳ gtVer("${a}","${b}") = ${g.gtVer(a, b)}，期望 ${exp}`);
}
check(`gtVer 版本比较全部正确（${verOk}/${VER_CASES.length}）`, verOk === VER_CASES.length);

/* ---------- 2. findListenPid 端口解析 ---------- */
(async () => {
  // 高位空闲端口必须返回 0（不能误报）
  const idle = await g.findListenPid(59999);
  check('findListenPid 对空闲端口返回 0（不误报）', idle === 0);

  const cur = await g.findListenPid(g.port());
  check(`findListenPid 对 ${g.port()} 返回合法 PID 或 0（当前=${cur}）`, Number.isInteger(cur) && cur >= 0);

  /* ---------- 3. 导出的接管契约 ---------- */
  check('导出 gtVer（可测版本比较）', typeof g.gtVer === 'function');
  check('导出 findListenPid（可测端口定位）', typeof g.findListenPid === 'function');
  check('导出 tryTakeover（接管决策可独立调用）', typeof g.tryTakeover === 'function');
  check('tryTakeover 是异步函数', g.tryTakeover.constructor.name === 'AsyncFunction');

  /* ---------- 4. localStatus 暴露接管结果 ---------- */
  const st = g.localStatus();
  check('localStatus 暴露 takeover 字段（供控制台展示）', 'takeover' in st);
  check('localStatus 保留原有字段契约',
    ['running', 'external', 'port', 'startedAt', 'lastLoopAt', 'lastError', 'queueLen', 'version']
      .every((k) => k in st));

  /* ---------- 5. 静态检查：start() 的接管接线与护栏 ---------- */
  check('EADDRINUSE 分支调用 tryTakeover()',
    /EADDRINUSE[\s\S]{0,200}tryTakeover\(\)/.test(live));
  check('接管成功后才重新 startServer',
    /t\.took[\s\S]{0,200}startServer/.test(live));
  check('接管失败/无需接管时回落 external 让位',
    /else\s*\{\s*external\s*=\s*true/.test(live));
  check('护栏：探不到 /health 时不接管（避免误杀）',
    /非本工具进程占用，不接管/.test(live));
  check('护栏：外部版本不低于自身时让位',
    /不早于当前/.test(live));
  check('护栏：拒绝结束自身进程（防自杀）',
    /pid === process\.pid \|\| pid === process\.ppid/.test(live));
  check('接管后轮询等端口释放（避免立刻又 EADDRINUSE）',
    /for \(let i = 0; i < 12; i\+\+\)/.test(live));
  check('restart() 会清空上次接管记录', /external = false;\s*takeover = null;/.test(live));
  check('stop() 后不发采集请求（timer 清理存在）', /clearInterval\(timer\)/.test(live));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
