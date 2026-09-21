// 功能校验：控制台 UI 静态一致性（pet/src/console.html / console.js / preload.js / main.js）
// 覆盖：DOM 选择器存在性、tab 与页面一一对应、IPC 通道两端一致、tdai.* API 存在、宠物与 AI 人格已清除。
// 纯文本静态检查（不需要 electron 运行时），发版流水线可直接跑。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'pet', 'src');
const html = fs.readFileSync(path.join(SRC, 'console.html'), 'utf8');
const js = fs.readFileSync(path.join(SRC, 'console.js'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'console.css'), 'utf8');
const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'pet', 'package.json'), 'utf8'));

const results = [];
function check(name, ok) { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); }
const uniq = (a) => Array.from(new Set(a));
const matchAll = (text, re) => { const out = []; let m; while ((m = re.exec(text))) out.push(m); return out; };

/* ---------- DOM 选择器 ---------- */
const htmlIds = uniq(matchAll(html, /\bid="([^"]+)"/g).map((m) => m[1]));
const jsIds = uniq(matchAll(js, /\$\('#([\w-]+)'\)/g).map((m) => m[1]));
const missingIds = jsIds.filter((id) => !htmlIds.includes(id));
check(`console.js 引用的 ${jsIds.length} 个 DOM id 全部存在` + (missingIds.length ? `（缺：${missingIds.join(', ')}）` : ''), missingIds.length === 0);

/* ---------- 顶栏 tab 与页面 ---------- */
const tabNames = uniq(matchAll(html, /data-tab="([\w-]+)"/g).map((m) => m[1]));
const pageNames = uniq(matchAll(html, /data-page="([\w-]+)"/g).map((m) => m[1]));
check('顶栏 tab 与页面一一对应：' + tabNames.join(' / '), tabNames.length > 0 && tabNames.every((t) => pageNames.includes(t)) && pageNames.every((p) => tabNames.includes(p)));
check('设置已并入顶栏 tab（不再有独立「更新」tab）', tabNames.includes('settings') && !tabNames.includes('update'));

/* ---------- 设置内二级 tab 与子面板 ---------- */
const subTabs = uniq(matchAll(html, /data-sub="([\w-]+)"[^>]*class="active"|data-sub="([\w-]+)"/g).map((m) => m[1] || m[2]));
const subPanels = uniq(matchAll(html, /data-sub="([\w-]+)"[^>]*>\s*$/gm).map((m) => m[1]));
const subButtonNames = uniq(matchAll(html.match(/<div class="subtabs"[\s\S]*?<\/div>/)[0], /data-sub="([\w-]+)"/g).map((m) => m[1]));
const subPanelNames = uniq(matchAll(html, /<div class="subpanel[^"]*" data-sub="([\w-]+)"/g).map((m) => m[1]));
check('设置分类 tab：' + subButtonNames.join(' / '), subButtonNames.length === 4);
check('每个分类都有对应子面板', subButtonNames.every((s) => subPanelNames.includes(s)) && subPanelNames.length === subButtonNames.length);

/* ---------- 问号提示 ---------- */
const qCount = matchAll(html, /<span class="q">\?<span class="tip">/g).length;
const connFields = ['set-url', 'set-key', 'set-team', 'set-agent', 'set-task', 'set-block'];
check(`记忆库连接 ${connFields.length} 个字段均有问号解释（全页共 ${qCount} 处）`, connFields.every((id) => new RegExp(`id="${id}"`).test(html)) && qCount >= connFields.length);

/* ---------- IPC 通道两端一致 ---------- */
const handled = uniq(matchAll(mainJs, /ipcMain\.handle\('([\w:-]+)'/g).map((m) => m[1]));
const invoked = uniq(matchAll(preload, /ipcRenderer\.invoke\('([\w:-]+)'/g).map((m) => m[1]));
const notHandled = invoked.filter((c) => !handled.includes(c));
check(`preload 的 ${invoked.length} 个 IPC 通道都有主进程 handler` + (notHandled.length ? `（缺：${notHandled.join(', ')}）` : ''), notHandled.length === 0);

/* ---------- tdai.* API 两端一致 ---------- */
const exposedBlock = preload.slice(preload.indexOf('exposeInMainWorld'));
const exposed = uniq(matchAll(exposedBlock, /^\s{2}(\w+):/gm).map((m) => m[1]));
const used = uniq(matchAll(js, /\btdai\.(\w+)\(/g).map((m) => m[1]));
const notExposed = used.filter((n) => !exposed.includes(n));
check(`console.js 用到的 ${used.length} 个 tdai API 都已在 preload 暴露` + (notExposed.length ? `（缺：${notExposed.join(', ')}）` : ''), notExposed.length === 0);

/* ---------- 宠物 / AI 人格 已清除 ---------- */
const allText = html + js + css + mainJs + preload;
const banned = ['宠物', 'AI 人格', '人格', 'clickThrough', 'alwaysOnTop', 'set-opacity', 'set-ai-', 'petWin', 'pet.html', 'pet.js', "ai: {", 'aurora'];
const hits = banned.filter((w) => allText.includes(w));
check('宠物 / AI 人格 / 装饰性极光背景 已全部移除' + (hits.length ? `（残留：${hits.join(', ')}）` : ''), hits.length === 0);
check('打包配置不再包含宠物模块（files 仅 src）', JSON.stringify(pkg.build.files) === JSON.stringify(['src']));
check('resources 打平了 core / mcp / daemon 供一键接入使用', ['core', 'mcp', 'daemon'].every((d) => pkg.build.extraResources.some((r) => r.to === d)));
check('升级路径 appId 未变（老用户可平滑升级）', pkg.build.appId === 'com.tdai.pet');

/* ---------- 无数据占位统一为 "-" ---------- */
const placeholders = matchAll(html, /<b id="(?:s|up)-[\w-]+">([^<]*)<\/b>|<div class="[kv]" id="(?:k|a)-[\w-]+">([^<]*)<\/div>/g).map((m) => m[1] || m[2]);
check(`数据展示位（${placeholders.length} 处）初始占位统一为 "-"`, placeholders.length > 0 && placeholders.every((t) => t.trim() === '-'));

const failed = results.filter((r) => !r[1]);
console.log(failed.length ? `\nUI 静态校验失败 ${failed.length} 项` : `\nUI 静态校验全部通过（${results.length} 项）`);
process.exit(failed.length ? 1 : 0);
