// 更新说明（release notes）链路守卫。
//
// 背景：应用「更新中心」的 #up-notes 依赖 updater 状态里的 notes 字段。
// 历史上这条链在三处断过，每次都表现为「检测到新版本但看不到更新内容」：
//   ① 发布流水线没生成 build/release-notes.md → latest.yml 无 releaseNotes
//   ② electron-publish 的 createRelease() 不写 body → Release 页面空白
//   ③ checkPortable() 只从 latest.yml 取 version、不取 releaseNotes → 便携版恒空
// 本测试把 ①③ 两侧的产出与解析锁死（② 是第三方行为，见 release.yml 的回填步骤）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

console.log('---------- 更新说明链路验证 ----------');

/* ---------- ① 发布脚本能从 CHANGELOG 提取版本段落 ---------- */
const genScript = path.join(ROOT, 'scripts', 'make-release-notes.cjs');
ok('scripts/make-release-notes.cjs 存在', fs.existsSync(genScript));

const petVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'pet', 'package.json'), 'utf8')).version;
let generated = '';
try {
  generated = execFileSync(process.execPath, [genScript, petVer], { encoding: 'utf8', cwd: ROOT });
  ok('脚本对当前版本执行成功', true);
} catch (e) {
  ok('脚本对当前版本执行成功', false, String(e.message).split('\n')[0]);
}

const notesFile = path.join(ROOT, 'build', 'release-notes.md');
ok('生成 build/release-notes.md', fs.existsSync(notesFile));
if (fs.existsSync(notesFile)) {
  const body = fs.readFileSync(notesFile, 'utf8');
  ok('说明内容非空', body.trim().length > 0, `${body.length} 字节`);
  // 必须是该版本的正文，不能把别的版本段落或 CHANGELOG 头部混进来
  ok('未混入 CHANGELOG 文件头', !body.includes('格式遵循'));
  ok('未混入其他版本标题', !/^##\s*\[/m.test(body));
  ok('含标准的变更分类小节', /^###\s+(Fixed|Added|Changed|Removed|Deprecated|Security)/m.test(body));
}

/* ---------- ② electron-builder 会去找这个文件名 ---------- */
// getReleaseInfo() 在 buildResources 下的候选名，release-notes.md 是最终兜底
const buildRes = path.join(ROOT, 'build');
ok('build/ 即 buildResources 目录', fs.existsSync(buildRes) && fs.existsSync(path.join(buildRes, 'icon.ico')));

/* ---------- ③ 便携版解析 latest.yml 的 releaseNotes ---------- */
const updaterSrc = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'updater.js'), 'utf8');
ok('checkPortable 会读取 releaseNotes', /readYmlNotes\s*\(/.test(updaterSrc));
ok('available 状态带上了 notes', /setState\(\s*'available'\s*,\s*\{[^}]*notes:/.test(updaterSrc));

// 复刻 readYmlNotes 的解析逻辑，验证对 electron-builder 产出的两种 YAML 形态都能读
function readYmlNotes(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^releaseNotes:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline && inline !== '|' && inline !== '>' && !/^[|>][-+]?\d*$/.test(inline)) {
      return inline.replace(/^['"]|['"]$/g, '');
    }
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') { block.push(''); continue; }
      if (!/^\s/.test(line)) break;
      block.push(line.replace(/^\s{2}/, ''));
    }
    return block.join('\n');
  }
  return '';
}

const YML_BLOCK = [
  'version: 0.5.18',
  'files:',
  '  - url: TDMemoryGuard-Setup-0.5.18.exe',
  '    sha512: abc',
  'releaseNotes: |',
  '  ### Fixed',
  '  - 修复 ZCode 插件开关失效',
  '',
  '  ### Added',
  '  - 新增自愈',
  'releaseDate: 2026-09-23T00:00:00.000Z',
].join('\n');

const yBlock = readYmlNotes(YML_BLOCK);
ok('块标量（|）能解析出正文', yBlock.includes('修复 ZCode 插件开关失效') && yBlock.includes('新增自愈'), JSON.stringify(yBlock.slice(0, 50)));
ok('块标量在下一个顶层键处停止', !yBlock.includes('releaseDate') && !yBlock.includes('T00:00:00'));

const yInline = readYmlNotes('version: 0.5.18\nreleaseNotes: 修复了若干问题\nreleaseDate: 2026-09-23');
ok('单行字符串能解析', yInline === '修复了若干问题', JSON.stringify(yInline));

const yFolded = readYmlNotes('releaseNotes: >\n  折叠段落第一行\n  第二行\nversion: 1.0.0');
ok('折叠标量（>）能解析', yFolded.includes('折叠段落第一行') && yFolded.includes('第二行'), JSON.stringify(yFolded));

ok('无 releaseNotes 时返回空串', readYmlNotes('version: 0.5.18\nfiles: []') === '');

/* ---------- ④ 主进程会把它透传给渲染层 ---------- */
// preload 用通用的 on(channel, cb) 订阅（不逐个写通道名），所以两侧分开断言：
// 发送方在主进程 updater.js 用 'update:state'，订阅方由 preload 的 on() 兜住。
const preloadSrc = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'preload.js'), 'utf8');
ok('preload 提供通用事件订阅 on(channel, cb)', /on:\s*\(channel,\s*cb\)/.test(preloadSrc));
ok('主进程通过 update:state 广播状态', /webContents\.send\(\s*'update:state'/.test(updaterSrc));
const consoleSrc = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'console.js'), 'utf8');
ok('渲染层订阅 update:state', /tdai\.on\(\s*'update:state'/.test(consoleSrc));
ok('渲染层把 notes 写进 #up-notes', /\$\('#up-notes'\)/.test(consoleSrc) && /s\.notes/.test(consoleSrc));
const consoleHtml = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'console.html'), 'utf8');
ok('console.html 存在 #up-notes 容器', /id="up-notes"/.test(consoleHtml));

/* ---------- ⑤ 安装版路径仍保留 notes ---------- */
ok('update-available 事件解析 info.releaseNotes',
  /'update-available'[\s\S]{0,200}?toNotes\(info\.releaseNotes\)/.test(updaterSrc));

console.log(`\n---------- 更新说明链路：通过 ${pass} / 失败 ${fail} ----------`);
process.exit(fail ? 1 : 0);
