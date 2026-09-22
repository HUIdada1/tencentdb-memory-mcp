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
const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
const htmlIds = uniq(matchAll(htmlNoComment, /\bid="([^"]+)"/g).map((m) => m[1]));
const jsIds = uniq(matchAll(js, /\$\('#([\w-]+)'\)/g).map((m) => m[1]));
const missingIds = jsIds.filter((id) => !htmlIds.includes(id));
check(`console.js 引用的 ${jsIds.length} 个 DOM id 全部存在于「可见」HTML` + (missingIds.length ? `（缺：${missingIds.join(', ')}）` : ''), missingIds.length === 0);

/* ---------- 顶栏 tab 与页面 ----------
 * 注意：必须先把 HTML 注释剥掉，否则被整段注释隐藏的 tab（技能/wiki/图谱）
 * 仍会被正则匹配到，导致「已隐藏」这件事永远验不出来 —— 这是个真实踩过的坑。
 */
const htmlLive = html.replace(/<!--[\s\S]*?-->/g, '');
const tabNames = uniq(matchAll(htmlLive, /data-tab="([\w-]+)"/g).map((m) => m[1]));
const pageNames = uniq(matchAll(htmlLive, /data-page="([\w-]+)"/g).map((m) => m[1]));
check('顶栏 tab 与页面一一对应：' + tabNames.join(' / '), tabNames.length > 0 && tabNames.every((t) => pageNames.includes(t)) && pageNames.every((p) => tabNames.includes(p)));
// 明确顺序契约：实时会话必须夹在「记忆」与「Agent 接入」之间
check('tab 顺序为 home / memory / live / agent / settings',
  tabNames.join(',') === 'home,memory,live,agent,settings');
// 明确：技能 / wiki / 图谱 必须已不可见；记忆必须可见
const HIDDEN_TABS = ['skills', 'wiki', 'graph'];
const stillVisible = HIDDEN_TABS.filter((t) => tabNames.includes(t) || pageNames.includes(t));
check('技能 / Wiki / 图谱 三个 tab 已隐藏（注释）' + (stillVisible.length ? `（仍可见：${stillVisible.join(', ')}）` : ''), stillVisible.length === 0);
check('记忆 tab 保留可用', tabNames.includes('memory') && pageNames.includes('memory'));
check('实时会话为独立 tab', tabNames.includes('live') && pageNames.includes('live'));
check('Agent 接入为独立 tab', tabNames.includes('agent') && pageNames.includes('agent'));
check('总览页已移除快速检索', !htmlLive.includes('id="qs-input"'));
check('设置页展示作者「沐辉」', /作者[\s\S]{0,30}沐辉/.test(htmlLive));
check('设置已并入顶栏 tab（不再有独立「更新」tab）', tabNames.includes('settings') && !tabNames.includes('update'));

/* ---------- 设置内二级 tab 与子面板 ---------- */
const subTabs = uniq(matchAll(html, /data-sub="([\w-]+)"[^>]*class="active"|data-sub="([\w-]+)"/g).map((m) => m[1] || m[2]));
const subPanels = uniq(matchAll(html, /data-sub="([\w-]+)"[^>]*>\s*$/gm).map((m) => m[1]));
const subButtonNames = uniq(matchAll(html.match(/<div class="subtabs"[\s\S]*?<\/div>/)[0], /data-sub="([\w-]+)"/g).map((m) => m[1]));
const subPanelNames = uniq(matchAll(html, /<div class="subpanel[^"]*" data-sub="([\w-]+)"/g).map((m) => m[1]));
check('设置分类 tab：' + subButtonNames.join(' / '), subButtonNames.join(',') === 'conn,update,general');
check('每个分类都有对应子面板', subButtonNames.every((s) => subPanelNames.includes(s)) && subPanelNames.length === subButtonNames.length);
// 设置里不再有重复的「Agent 接入」子面板 —— 它只作为顶栏独立 tab 存在
check('设置内已无 agents 子面板（避免与顶栏 tab 重复）',
  !subButtonNames.includes('agents') && !subPanelNames.includes('agents'));
check('设置内无 agents 面板的残留节点',
  !/id="agents-(list|log|register|reload)"|id="b-agents"|id="open-web-console"/.test(html));
// 检查"活代码"而不是注释：先剥掉 // 行注释与 /* */ 块注释，
// 否则解释性注释里提到旧 id 会误报（我就在注释里写了历史说明）。
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('设置内无 agents 面板的残留绑定',
  !/#agents-(list|log|register|reload)|'#open-web-console'/.test(jsCode));
// 顶栏 Agent 接入功能必须完整保留（不能因为删除设置项而受影响）
check('顶栏 Agent 接入 tab 与处理链完整',
  /data-tab="agent"/.test(html) && /data-page="agent"/.test(html) &&
  /id="agent-register"/.test(html) && /id="agent-list"/.test(html) && /id="b-agent"/.test(html) &&
  /agent-refresh/.test(js) && /agent-copy-cmd/.test(js) && /agent-open-console/.test(js) &&
  /function loadAgents\(/.test(js) && /renderAgentItems\(/.test(js));
check('顶栏 Agent 页仍会在进入时加载状态',
  /agent:\s*\(\)\s*=>\s*\{[^}]*loadAgents\(\)/.test(js));

/* ---------- Agent 页：列对齐 + 明细渲染 + 说明折叠（本期修复） ----------
 * 这三条钉的是"同列必须对齐"的回归 —— 早先用 flex+space-between，
 * 徽章/开关的 x 坐标跟着名字宽度浮动，各客户端 detail 长短不一时整列参差不齐。 */
check('Agent 行用三列网格（不再靠 space-between 对齐）',
  /\.agent-row\{[^}]*display:grid[^}]*grid-template-columns/.test(css.replace(/\s+/g, ' ')) &&
  !/\.agent-row\{[^}]*justify-content:space-between/.test(css.replace(/\s+/g, ' ')));
check('徽章与开关在网格里各自定位（左中 / 右端）',
  /\.agent-badge\{[^}]*justify-self:center/.test(css.replace(/\s+/g, ' ')) &&
  /\.agent-toggle\{[^}]*justify-self:end/.test(css.replace(/\s+/g, ' ')));
check('名字副行单行省略（防长路径撑高行高、破坏基线）',
  /\.agent-row \.ar-name span\{[^}]*text-overflow:ellipsis/.test(css.replace(/\s+/g, ' ')));
check('接入明细用三列网格渲染（替代原始拼接文本）',
  js.includes('renderAgentResults') &&
  /\.ar-res\{[^}]*display:grid[^}]*grid-template-columns/.test(css.replace(/\s+/g, ' ')) &&
  // 旧写法：`[${x.action}] ${x.target} — ${x.detail}` 直接塞进 log.textContent
  !/\$\{x\.action\}\] \$\{x\.target\}/.test(js));
check('明细不再把开发者路径原样摊给用户（/mcp/servers/tdai 已不出现在明细渲染里）',
  !/textContent = results\.map/.test(js) && js.includes('skipReason'));
check('纯噪音的「跳过」行被过滤（未安装 / 本来就没接入）',
  /SKIP_NOISE/.test(js) && /renderAgentResults[\s\S]{0,400}SKIP_NOISE\.test/.test(js));
check('「三步接入」可折叠，且已接入时默认收起',
  /id="ag-guide"/.test(html) && /id="ag-steps"/.test(html) &&
  html.includes('data-act="agent-guide"') &&
  /'agent-guide'/.test(js) && /function setGuide\(/.test(js) &&
  /S\.guideOpen == null\) setGuide\(installed === 0\)/.test(js));
check('折叠状态有对应 CSS（收起时隐藏步骤并收紧标题间距）',
  /\.steps\.hide\{display:none\}/.test(css.replace(/\s+/g, '')) &&
  /#ag-guide\.collapsed h3/.test(css));

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

/* ---------- 无数据占位统一（- 或 —） ----------
 * 只检查「纯占位」形态的展示位：形如 - / — / 0 / 0 B / 0 B/s / 0 ms / 0 / 0 / 未配置。
 * 有实际语义的初始文案（如「暂无上传任务」）不在此列。
 */
const placeholders = matchAll(html, /<b id="(?:s|up|down|h|d)-[\w-]+">([^<]*)<\/b>/g).map((m) => m[1]);
const PLACEHOLDER_RE = /^(?:[-—]|0(?:\.\d+)?(?: [KMGT]?B(?:\/s)?| ms| 个)?(?:\s*\/\s*0)?|未配置)$/;
const badPh = placeholders.filter((t) => !PLACEHOLDER_RE.test(t.trim()));
check(`数据展示位（${placeholders.length} 处）初始占位统一为 "-" / "—" / "0…"` + (badPh.length ? `（不合格：${badPh.join(' | ')}）` : ''), placeholders.length > 0 && badPh.length === 0);

const failed = results.filter((r) => !r[1]);
console.log(failed.length ? `\nUI 静态校验失败 ${failed.length} 项` : `\nUI 静态校验全部通过（${results.length} 项）`);
process.exit(failed.length ? 1 : 0);
