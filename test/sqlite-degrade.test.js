// test/sqlite-degrade.test.js — 「会话权威源（node:sqlite）不可用」必须可见
//
// 背景（P0-1 修复）：
//   ZCode 新版会话写在 ~/.zcode/cli/db/db.sqlite（权威源），
//   旧版归档目录 agents/*/transcript.jsonl 已严重滞后。
//   pet/src/sessions.js 用内置 node:sqlite 读该库 —— 该模块需 Node ≥22.16。
//   早先拿不到模块时"安静降级"到文件扫描：列表照常有内容、界面毫无提示，
//   用户只会看到"最新会话停在几个月前"，误判程序坏了（真实用户反馈过）。
//   本测试钉死：降级必须产出可见警告（sqliteStatus + scanSessions.warnings）。
'use strict';
const path = require('path');
const Module = require('module');
const SESSIONS = path.join(__dirname, '..', 'pet', 'src', 'sessions.js');

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

// 在受控条件下加载 sessions.js：可让 require('node:sqlite') 失败
//
// ⚠️ 关键：sessions.js 的 sqliteMod() 是**惰性**的（首次调用 sqliteStatus/scanSessions
//    时才 require）。补丁若在 require() 返回后立刻还原，就拦不住那次惰性 require ——
//    测试会假通过"降级"断言却实际跑在正常路径上。故这里返回 release()，
//    由调用方在**用完模块之后**再还原。
function load(breakSqlite, opts) {
  const o = opts || {};
  delete require.cache[require.resolve(SESSIONS)];
  const orig = Module._load;
  if (breakSqlite) {
    Module._load = function (req) {
      if (req === 'node:sqlite') throw new Error('No such built-in module: node:sqlite');
      return orig.apply(this, arguments);
    };
  }
  // 模拟 Electron 形态：注入 process.versions.electron（sessions.js 据此分流文案）
  const savedElectron = process.versions.electron;
  if (o.electron) {
    Object.defineProperty(process.versions, 'electron', {
      value: o.electron, configurable: true, writable: true,
    });
  }
  const mod = require(SESSIONS);
  return {
    mod,
    release() {
      Module._load = orig;
      if (o.electron) {
        try { delete process.versions.electron; } catch (_) { }
        if (savedElectron) {
          Object.defineProperty(process.versions, 'electron', {
            value: savedElectron, configurable: true, writable: true,
          });
        }
      }
    },
  };
}

/* ---------- ① 正常路径：模块可用时不报降级 ---------- */
{
  const { mod: s, release } = load(false);
  const st = s.sqliteStatus();
  const hasBuildIn = (() => { try { require('node:sqlite'); return true; } catch (_) { return false; } })();
  if (hasBuildIn) {
    chk('① 模块可用时 degraded=false', st.degraded === false, JSON.stringify(st.kind));
    // kind 的两种合法值：'ok'（本机有会话库）/ 'no-db'（干净机器或 CI runner 上无会话库，
    // sessions.js 里 ok:true + degraded:false，属正常降档而非降级 —— v0.5.12 CI 实证 runner 即 no-db）
    chk('① 模块可用时 kind=ok|no-db（均非降级）',
      st.kind === 'ok' || st.kind === 'no-db', st.kind);
    const r = s.scanSessions({ limit: 3 });
    chk('① 正常路径不带 warnings', !r.warnings || r.warnings.length === 0,
      JSON.stringify(r.warnings || []));
  } else {
    chk('① 本机 Node <22.16（跳过正常路径断言，改判降级可见）', true);
  }
  release();
}

/* ---------- ② 降级路径：模块缺失必须可见 ---------- */
{
  const { mod: s, release } = load(true);
  const st = s.sqliteStatus();
  chk('② 模块缺失时 degraded=true', st.degraded === true, String(st.degraded));
  chk('② 模块缺失时 kind=no-module', st.kind === 'no-module', st.kind);
  chk('② 提示文案说明影响（"只看归档文件"）',
    /归档文件/.test(st.message || ''), st.message);
  chk('② 提供可执行的修复建议（含最低版本号）',
    (st.hint || '').includes('22.16.0'), st.hint);
  chk('② 报告最低版本常量 minNode=22.16.0', st.minNode === '22.16.0', String(st.minNode));
  chk('② 报告会话库路径（便于用户自查）',
    typeof st.path === 'string' && /db\.sqlite$/.test(st.path), String(st.path));

  const r = s.scanSessions({ limit: 5 });
  release();
  chk('② scanSessions 返回 warnings 数组', Array.isArray(r.warnings), typeof r.warnings);
  chk('② warnings 恰有一条 code=sqlite', (r.warnings || []).length === 1
    && r.warnings[0].code === 'sqlite', JSON.stringify(r.warnings));
  chk('② warning 携带 message/hint 供 UI 直接展示',
    !!(r.warnings[0] && r.warnings[0].message && r.warnings[0].hint));
  // 关键：降级不等于崩 —— 文件来源仍要出结果
  chk('② 降级后仍返回文件来源结果（不整体失败）', r.ok === true && r.files >= 0,
    'ok=' + r.ok + ' files=' + r.files);
  chk('② 降级后 sessions 仍是数组', Array.isArray(r.sessions));
}

/* ---------- ②b 运行时识别：Electron 内嵌 Node ≠ 用户系统 Node ----------
 * 真实用户反馈（2026-09-22）：
 *   桌面版提示「当前 Node 20.18.3 不支持内置 node:sqlite（需 ≥22.16.0）…升级 Node」，
 *   但用户机器上装的是 Node 22 —— 直接懵了（"是识别有错误吗？"）。
 *   根因：桌面版跑在 Electron 里，用的是 **Electron 内嵌的 Node**（Electron 33 → Node 20.18.3），
 *   与用户系统 Node 完全无关。旧文案把两者混为一谈，且给了完全无效的修复建议。
 * 本组钉死：Electron 形态下文案必须（a）注明是应用内置运行时、（b）明说与系统 Node 无关、
 * （c）修复建议指向升级应用自身，而不是让用户去升系统 Node。
 */
{
  const { mod: s, release } = load(true, { electron: '33.4.11' });
  const st = s.sqliteStatus();
  release();
  chk('②b Electron 形态仍判为降级', st.degraded === true && st.kind === 'no-module', st.kind);
  chk('②b 报告 isElectron 与运行时标签',
    st.isElectron === true && /Electron 33\.4\.11/.test(st.runtime || ''), st.runtime);
  chk('②b 文案点明是「应用内置运行时」（不再让用户以为自己 Node 有问题）',
    /应用内置运行时不支持/.test(st.message || ''), st.message);
  chk('②b 文案明说与系统安装的 Node 版本无关',
    /与您系统安装的 Node 版本无关/.test(st.message || ''), st.message);
  chk('②b 修复建议指向升级应用自身（而非升级系统 Node）',
    /升级「TD 记忆守护」/.test(st.hint || ''), st.hint);
  chk('②b 修复建议不再出现"升级 Node 到 ≥"这种误导话术',
    !/升级 Node 到/.test(st.hint || ''), st.hint);
  // 反向保护：非 Electron（纯 Node）形态仍须保留原有的"升级 Node"建议，别改坏
  const n2 = load(true);
  const st2 = n2.mod.sqliteStatus();
  n2.release();
  chk('②b 纯 Node 形态保留"升级 Node"建议（两种形态文案分流）',
    /升级 Node 到 ≥22\.16\.0/.test(st2.hint || ''), st2.hint);
  chk('②b 纯 Node 形态不带 Electron 标签',
    st2.isElectron === false && /^Node /.test(st2.runtime || ''), st2.runtime);
}

/* ---------- ③ 渲染层确实消费了 warnings ---------- */
{
  const fs = require('fs');
  const SRC = path.join(__dirname, '..', 'pet', 'src');
  const JS = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
  const MAIN = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

  chk('③ HTML 存在警告容器 #sess-warn', /id="sess-warn"/.test(HTML));
  chk('③ 警告容器复用既有 .banner.warn 样式（不新造类）',
    /id="sess-warn"[^>]*class="banner warn"/.test(HTML));
  chk('③ console.js 有 renderSessionWarnings 渲染函数',
    /function renderSessionWarnings\(/.test(JS));
  chk('③ renderSessionWarnings 只在 code=sqlite 时显示',
    /find\(\(x\) => x && x\.code === 'sqlite'\)/.test(JS));
  chk('③ 无警告时清空文案并撤下 show 类（不残留旧警告）',
    /box\.className = 'banner warn';\s*box\.textContent = '';\s*return;/.test(JS));
  chk('③ 手动刷新路径调用 renderSessionWarnings',
    /renderSessionWarnings\(r\.warnings\);\s*renderSessions\(r\.sessions\)/.test(JS));
  chk('③ 每秒快照路径也调用 renderSessionWarnings（不点刷新也能看到）',
    /renderSessionWarnings\(snap\.warnings\);\s*renderSessions\(snap\.sessions\)/.test(JS));
  chk('③ 主进程 sessions-scan 回传 warnings',
    /sessions: lastSessionScan\.sessions,\s*warnings: lastSessionScan\.warnings \|\| \[\]/.test(MAIN));
  chk('③ 主进程 metrics 快照带上 warnings',
    /daemonOkAt,\s*\/\/[\s\S]{0,200}warnings: lastSessionScan\.warnings \|\| \[\]/.test(MAIN)
    || /warnings: lastSessionScan\.warnings \|\| \[\],\s*\}\);\s*\}/.test(MAIN));
}

/* ---------- ④ 降级事实必须能上报给用户：engines 声明 ---------- */
{
  const fs = require('fs');
  const petPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pet', 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  chk('④ pet/package.json 声明 engines.node >=22.16.0',
    petPkg.engines && petPkg.engines.node === '>=22.16.0',
    JSON.stringify(petPkg.engines));
  chk('④ 根 package.json 声明 engines.node >=16.0.0',
    rootPkg.engines && rootPkg.engines.node === '>=16.0.0',
    JSON.stringify(rootPkg.engines));
  chk('④ pet/package.json 不再标 UNLICENSED（已改为 MIT）',
    petPkg.license === 'MIT', String(petPkg.license));
  // README 不能再说"统一 ≥16/≥18"这种与 sqlite 门槛矛盾的口径
  const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  chk('④ README 按形态分列 Node 要求（提及 22.16.0）',
    README.includes('22.16.0'), 'README 未提 22.16.0');
  chk('④ README 不再残留"推荐 Node ≥18"旧口径',
    !/推荐 Node ≥18/.test(README));
}

/* ---------- ⑤ 打包形态闸门：Electron 主版本必须 ≥34（真实故障的根治） ----------
 * 承接 ②b 的那个故障。②b 只保证"降级可见"，但用户要的是**别再降级**。
 * 根因是发布出去的应用打包时用的是 Electron 33（内嵌 Node 20.18.3，无 node:sqlite）。
 * ⚠️ 这个坑特别阴：开发机 `node -v` 是 22.x，很容易让"打包用的 Electron 是 33"滑过去。
 * 本组把三件事钉死：
 *   (a) pet/package.json 的 electron 依赖主版本 ≥ 34；
 *   (b) 运行时闸门 runtimeGate() 能在 Electron 过老时明确报错（不静默）；
 *   (c) 版本比较必须是**数值**比较（'9.0.0' 与 '22.16.0' 的字符串比较是反的）。
 */
{
  const fs = require('fs');
  const petPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pet', 'package.json'), 'utf8'));
  const dep = (petPkg.devDependencies || {}).electron || '';
  const depMajor = parseInt(String(dep).replace(/^[^\d]*/, '').split('.')[0], 10) || 0;
  chk('⑤ pet/package.json 的 electron 依赖主版本 ≥34（内嵌 Node 才带 node:sqlite）',
    depMajor >= 34, dep);

  // 用受控的 process.versions.electron 驱动 runtimeGate 的四条分支
  const { mod: s, release } = load(true, { electron: '33.4.11' });
  const g33 = s.runtimeGate();
  chk('⑤ Electron 33 → 闸门判定 electron-too-old', g33.kind === 'electron-too-old' && g33.ok === false, g33.kind);
  chk('⑤ 过老时的文案点明"内嵌 Node 不含 node:sqlite"与影响面',
    /不含 node:sqlite/.test(g33.message) && /重新用 Electron/.test(g33.message), g33.message);
  chk('⑤ 过老时给出所需版本号（needed=34）', g33.needed === '34', String(g33.needed));
  release();

  const { mod: s34, release: rel34 } = load(false, { electron: '34.0.0' });
  const g34 = s34.runtimeGate();
  rel34();
  chk('⑤ Electron 34 → 闸门放行（ok=true，不再是 electron-too-old）',
    g34.ok === true && g34.kind === 'ok', g34.kind + '/' + g34.message);

  // 版本比较必须数值化：字符串比较下 '9.0.0' > '22.16.0' 成立（经典误判）
  chk('⑤ verNum 是数值比较（9.0.0 不高于 22.16.0）',
    s.verNum('9.0.0') < s.verNum('22.16.0'),
    s.verNum('9.0.0') + ' vs ' + s.verNum('22.16.0'));
  chk('⑤ verNum 容忍 v 前缀与缺段',
    s.verNum('v34.0.0') === s.verNum('34') && s.verNum('v34') === s.verNum('34.0'),
    s.verNum('v34') + '/' + s.verNum('34.0'));
  chk('⑤ 导出的 ELECTRON_MIN 与 pet 依赖门槛同源（避免两处漂移）',
    s.ELECTRON_MIN === 34 && String(s.ELECTRON_MIN_LABEL) === '34',
    s.ELECTRON_MIN + '/' + s.ELECTRON_MIN_LABEL);

  // 纯 Node 形态闸门：本机 Node 22 应放行
  const { mod: sNode, release: relNode } = load(false);
  const gNode = sNode.runtimeGate();
  relNode();
  chk('⑤ 纯 Node 形态闸门按 node:sqlite 门槛判定（本机 Node22 放行或明确报 node-too-old）',
    gNode.ok === true || gNode.kind === 'node-too-old', gNode.kind);
  chk('⑤ 闸门结果恒带 kind/ok/actual/needed/message 五要素（UI 可直接消费）',
    typeof gNode.kind === 'string' && typeof gNode.ok === 'boolean'
    && typeof gNode.actual === 'string' && typeof gNode.needed === 'string'
    && typeof gNode.message === 'string',
    JSON.stringify(gNode).slice(0, 140));
}

console.log('\n---------- 会话权威源降级可见性验证：通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
ok.forEach((x) => console.log('  ✓ ' + x));
if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
process.exit(0);
