// test/clients-consistency.test.js — 客户端清单单一真源与两端一致性
//
// 背景（P0-3 修复）：
//   Agent 接入有两套实现 —— 桌面端 pet/src/register.js（注册目标=应用 exe）
//   与源码端 register-all.cjs（注册目标=node + 源码目录）。注册目标不同是刻意设计，
//   但"认识哪些客户端 / 配置文件在哪 / 用什么格式写"必须同源，否则一边加了客户端
//   另一边没加，用户会遇到"桌面端说已接入、命令行说未接入"。
//   现在统一从 core/clients.js 取，本文件钉死这一点。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

const clients = require(path.join(ROOT, 'core', 'clients.js'));
const REG_JS = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'register.js'), 'utf8');
const REG_ALL = fs.readFileSync(path.join(ROOT, 'register-all.cjs'), 'utf8');
// 剥掉注释再匹配（注释里的历史说明会造成误报）
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
const REG_ALL_BARE = strip(REG_ALL);
const REG_JS_BARE = strip(REG_JS);

/* ---------- ① 唯一真源：CLIENTS 只在 core/clients.js 定义 ---------- */
{
  chk('① core/clients.js 导出 CLIENTS 数组',
    Array.isArray(clients.CLIENTS) && clients.CLIENTS.length > 0,
    'len=' + (clients.CLIENTS || []).length);
  chk('① register.js 不再自己定义 CLIENTS 数组（改从 core 引入）',
    !/^const CLIENTS = \[/m.test(REG_JS_BARE), '仍在本地定义');
  chk('① register-all.cjs 不再自己定义 CLIENTS 数组',
    !/^const CLIENTS = \[/m.test(REG_ALL_BARE), '仍在本地定义');
  chk('① register.js 从 core/clients 引入',
    /require\([\s\S]{0,80}core['"\\,\s]*clients\.js['"]\)/.test(REG_JS), '');
  chk('① register-all.cjs 从 core/clients.js 引入',
    /require\(['"]\.\/core\/clients\.js['"]\)/.test(REG_ALL), '');
}

/* ---------- ② 每个客户端定义完整 ---------- */
{
  const need = ['key', 'name', 'kind', 'probe', 'file'];
  for (const c of clients.CLIENTS) {
    const miss = need.filter((k) => c[k] == null);
    chk(`② 「${c.key}」字段完整`, miss.length === 0, miss.join(','));
  }
  const kinds = clients.CLIENTS.map((c) => c.kind);
  chk('② kind 只用已实现的分支（json/json-nested/toml/yaml/opencode/dsh-patch）',
    kinds.every((k) => ['json', 'json-nested', 'toml', 'yaml', 'opencode', 'dsh-patch'].includes(k)),
    kinds.join(','));
  // 除 dsh-patch/toml/yaml 外都必须有 pointer（JSON 写入需要它定位条目）
  for (const c of clients.CLIENTS) {
    if (['json', 'json-nested', 'opencode'].includes(c.kind)) {
      chk(`② 「${c.key}」JSON 类客户端声明了 pointer`, !!c.pointer, String(c.pointer));
    }
  }
  chk('② toml 类客户端声明 tomlSection', !!clients.byKey('codex').tomlSection,
    String(clients.byKey('codex').tomlSection));
  chk('② yaml 类客户端声明 yamlTop + yamlLeaf',
    !!clients.byKey('hermes').yamlTop && !!clients.byKey('hermes').yamlLeaf,
    `${clients.byKey('hermes').yamlTop}.${clients.byKey('hermes').yamlLeaf}`);
  chk('② dsh-patch 客户端声明 patchMark', !!clients.byKey('deepseek-harness').patchMark,
    String(clients.byKey('deepseek-harness').patchMark));
}

/* ---------- ③ key 唯一 + 已知客户端都在 ---------- */
{
  const keys = clients.clientKeys();
  chk('③ key 无重复', new Set(keys).size === keys.length, keys.join(','));
  for (const k of ['zcode', 'claude-code', 'cursor', 'codex', 'trae', 'deepseek-harness',
                   'codebuddy', 'workbuddy', 'opencode', 'hermes', 'openclaw', 'pi']) {
    chk(`③ 清单含 ${k}`, keys.includes(k), keys.join(','));
  }
  chk('③ 客户端共 12 个（P2-1 扩充后）', keys.length === 12, 'len=' + keys.length);
  chk('③ clientKeys() 与 CLIENTS 顺序一致',
    JSON.stringify(clients.clientKeys()) === JSON.stringify(clients.CLIENTS.map((c) => c.key)));
  chk('③ byKey 未知 key 返回 null（不抛）', clients.byKey('__nope__') === null);
  chk('③ nameOf 未知 key 原样返回（界面不出现 undefined）',
    clients.nameOf('__nope__') === '__nope__');
}

/* ---------- ③b CLIENT_PATHS 与 daemon 内联清单逐字一致（路径漂移防线） ---------- */
{
  // CLIENT_PATHS 是"相对 home 的路径段"的规范化声明，daemon 内联副本必须与之一致。
  // 这条能拦住"core 改了路径、daemon 没改"这类最隐蔽的漂移。
  const DAEMON_RAW = fs.readFileSync(path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'utf8');
  const seg = (p) => p.split('/');
  for (const p of clients.CLIENT_PATHS) {
    const ps = seg(p.probe);
    const fs2 = seg(p.file);
    // daemon 里应出现形如 'x', 'y' 的相邻分段（path.join 形式）
    const joinRe = (parts) => new RegExp(
      parts.map((s) => `['"]${s.replace(/\./g, '\\.')}['"]`).join('[\\s,]+'));
    chk(`③b daemon 内联「${p.key}」probe 分段与 CLIENT_PATHS 一致`,
      joinRe(ps).test(DAEMON_RAW), p.probe);
    chk(`③b daemon 内联「${p.key}」file 分段与 CLIENT_PATHS 一致`,
      joinRe(fs2).test(DAEMON_RAW), p.file);
  }
  chk('③b CLIENT_PATHS 条数 = CLIENTS 条数',
    clients.CLIENT_PATHS.length === clients.CLIENTS.length,
    `${clients.CLIENT_PATHS.length} vs ${clients.CLIENTS.length}`);
  chk('③b CLIENT_PATHS 的 name/kind 与 CLIENTS 同序',
    clients.CLIENT_PATHS.every((p, i) => p.name === clients.CLIENTS[i].name && p.kind === clients.CLIENTS[i].kind),
    '');
}

/* ---------- ④ 两端都不再硬编码客户端路径字面量 ---------- */
{
  // 若某天有人把路径写回主流程，这里会立刻报出来
  const banned = [
    ['.zcode/cli/config.json 字面量', /['"]\.zcode['"]\s*,\s*['"]cli['"]|\.zcode\/cli\/config\.json/],
    ['.cursor/mcp.json 字面量', /\.cursor['"]\s*,\s*['"]mcp\.json/],
    ['.trae/mcp.json 字面量', /\.trae['"]\s*,\s*['"]mcp\.json/],
  ];
  for (const [label, re] of banned) {
    chk(`④ register.js 无 ${label}`, !re.test(REG_JS_BARE), '');
    chk(`④ register-all.cjs 无 ${label}`, !re.test(REG_ALL_BARE), '');
  }
  // toml 段名与 dsh 标记必须走清单字段，不能另写字符串
  chk('④ register.js 的 toml 段名走 cls.tomlSection',
    /cls\.tomlSection/.test(REG_JS_BARE), '');
  chk('④ register.js 的 dsh 标记走 cls.patchMark',
    /cls\.patchMark/.test(REG_JS_BARE), '');
  chk('④ register-all.cjs 的 toml 段名走 cls.tomlSection',
    /cls\.tomlSection/.test(REG_ALL_BARE), '');
  chk('④ register-all.cjs 的 dsh 标记走 cls.patchMark',
    /cls\.patchMark/.test(REG_ALL_BARE), '');
}

/* ---------- ⑤ pointer 解析在两端行为一致（真跑一遍） ---------- */
{
  // 用隔离 HOME 实跑 register-all.cjs 的等价写入逻辑，验证 json-nested 正确落位
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-clients-'));
  const p0 = path.join(home, '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(p0), { recursive: true });
  fs.writeFileSync(p0, '{}');
  const c = JSON.parse(fs.readFileSync(p0, 'utf8'));
  const ptr = clients.byKey('zcode').pointer;
  const parts = ptr.split('/').filter(Boolean);
  const leaf = parts.pop();
  let parent = c;
  for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
  parent[leaf] = { probe: 1 };
  chk('⑤ ZCode pointer 落到 mcp.servers.tdai（不是顶层 mcpServers）',
    !!(c.mcp && c.mcp.servers && c.mcp.servers.tdai) && !c.mcpServers,
    JSON.stringify(c));
  // probe/file 能产出绝对路径且指向同一 home
  const pr = clients.byKey('zcode').probe(home);
  const fl = clients.byKey('zcode').file(home);
  chk('⑤ probe/file 均为该 home 下的绝对路径',
    path.isAbsolute(pr) && path.isAbsolute(fl) && pr.startsWith(home) && fl.startsWith(home),
    pr + ' | ' + fl);
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑥ hook 判据清单同源 ---------- */
{
  chk('⑥ HOOK_MARK = tdai-hook.cmd', clients.HOOK_MARK === 'tdai-hook.cmd', clients.HOOK_MARK);
  chk('⑥ legacy 标记含 tdai-daemon.js / .cjs',
    clients.HOOK_LEGACY_MARKS.includes('tdai-daemon.js')
    && clients.HOOK_LEGACY_MARKS.includes('tdai-daemon.cjs'),
    clients.HOOK_LEGACY_MARKS.join(','));
  chk('⑥ register.js 不再本地定义 HOOK_MARK',
    !/^const HOOK_MARK =/m.test(REG_JS_BARE), '');
  // hook 目标也应在清单里声明（两端共用）。
  // 两类 scope 的"目标位置"表达方式不同，断言也要分开（别再用统一的 h.file 判据）：
  //   global    → h.file(home) 给出用户级配置文件
  //   workspace → h.eventsPath 给出**工作区根下**的分段（需运行时才知道工作区）
  {
    const h = clients.byKey('claude-code').hook;
    chk('⑥ 「claude-code」是用户级 hook 且给出配置文件', !!(h && h.scope !== 'workspace' && typeof h.file === 'function'), String(h));
  }
  {
    const h = clients.byKey('zcode').hook;
    chk('⑥ 「zcode」是工作区级 hook 且给出 eventsPath',
      !!(h && h.scope === 'workspace' && Array.isArray(h.eventsPath) && h.eventsPath.length > 0), String(h));
    chk('⑥ 「zcode」的 hook 不能再有 file()（避免误当用户级写）', !(h && typeof h.file === 'function'), '');
  }
  chk('⑥ hookConfigFile 能按 scope 解析出两种目标',
    clients.hookConfigFile(clients.byKey('claude-code'), '/h', '/ws') === path.join('/h', '.claude', 'settings.json')
    && clients.hookConfigFile(clients.byKey('zcode'), '/h', '/ws') === path.join('/ws', '.zcode', 'config.json'),
    String(clients.hookConfigFile(clients.byKey('zcode'), '/h', '/ws')));
  chk('⑥ hookEventList 对 ZCode 生成 events 容器、对 CC 直挂',
    (() => {
      const a = {}; clients.hookEventList(a, clients.byKey('zcode').hook, true);
      const b = {}; clients.hookEventList(b, clients.byKey('claude-code').hook, true);
      return !!(a.hooks && a.hooks.events && a.hooks.events.UserPromptSubmit)
        && !!(b.hooks && b.hooks.UserPromptSubmit) && !b.hooks.events;
    })(), '');
}

/* ---------- ⑦ 指令文件清单：写入面 = 检测面 ---------- */
{
  chk('⑦ INSTR_TARGETS 恰好两项', clients.INSTR_TARGETS.length === 2,
    JSON.stringify(clients.INSTR_TARGETS));
  chk('⑦ INSTR_TARGETS = [.zcode/AGENTS.md, .claude/CLAUDE.md]（不含从未写入的 .claude/AGENTS.md）',
    clients.INSTR_TARGETS.some(([d, n]) => d === '.zcode' && n === 'AGENTS.md')
    && clients.INSTR_TARGETS.some(([d, n]) => d === '.claude' && n === 'CLAUDE.md')
    && !clients.INSTR_TARGETS.some(([d, n]) => d === '.claude' && n === 'AGENTS.md'),
    JSON.stringify(clients.INSTR_TARGETS));
  chk('⑦ INSTR_MARK = tdai-memory:begin', clients.INSTR_MARK === 'tdai-memory:begin', clients.INSTR_MARK);
  chk('⑦ 指令块正文含 begin/end 配对标记',
    clients.INSTR.includes('tdai-memory:begin') && clients.INSTR.includes('tdai-memory:end'));
  chk('⑦ register.js 不再本地定义 INSTR_TARGETS',
    !/^const INSTR_TARGETS =/m.test(REG_JS_BARE), '');
  chk('⑦ register-all.cjs 走 INSTR_TARGETS 循环（不再硬编码两份路径）',
    /for \(const \[dir, name\] of INSTR_TARGETS\)/.test(REG_ALL_BARE), '');
}

/* ---------- ⑧ 两端注册目标刻意不同（这是设计，不是漂移） ---------- */
{
  chk('⑧ register.js 用应用 exe（ELECTRON_RUN_AS_NODE）作为注册命令',
    /ELECTRON_RUN_AS_NODE/.test(REG_JS_BARE), '');
  chk('⑧ register-all.cjs 用 node + 源码路径作为注册命令',
    /const mcpStdio = \{ type: 'stdio', command: NODE, args: \[MCP\] \}/.test(REG_ALL_BARE), '');
}

/* ---------- ⑨ 守护进程是单文件自包含（不能 require），但字面量必须与清单一致 ---------- */
{
  const DAEMON = strip(fs.readFileSync(path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'utf8'));
  chk('⑨ daemon 保持单文件自包含（不 require core/clients）',
    !/require\([\s\S]{0,60}clients\.js/.test(DAEMON), '出现了对 core/clients 的 require');
  // 既然不能 require，就只能内联 —— 那就钉死内联值与清单一致
  const markM = DAEMON.match(/const HOOK_MARK = '([^']+)'/);
  chk('⑨ daemon 的 HOOK_MARK 与清单一致',
    markM && markM[1] === clients.HOOK_MARK, markM ? markM[1] : '未找到');
  const legM = DAEMON.match(/const HOOK_LEGACY_MARKS = \[([^\]]+)\]/);
  const legList = legM ? legM[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  chk('⑨ daemon 的 HOOK_LEGACY_MARKS 与清单一致',
    JSON.stringify(legList) === JSON.stringify(clients.HOOK_LEGACY_MARKS),
    JSON.stringify(legList));
  // hook 配置路径：daemon 里内联的必须与清单指向同一位置。
  // daemon 用 path.join(home, ...) 构造，所以不能拿固定字符串去 includes —— 改为
  // 从 daemon 源码里提取 ".zcode', 'cli', 'config.json" 这类分段字面量做比对。
  const segOf = (abs) => abs.split(/[\\/]/).filter(Boolean).slice(1);  // 去掉盘符/home 首段
  // 用户级 hook（Claude Code）：路径来自 hook.file()
  {
    const k = 'claude-code';
    const segs = segOf(clients.byKey(k).hook.file('/probe'));
    const pattern = new RegExp(segs.map((s) => `['"]${s.replace(/\./g, '\\.')}['"]`).join('[\\s,]+'));
    chk(`⑨ daemon 内联的 ${k} hook 路径分段与清单一致`,
      pattern.test(DAEMON), segs.join('/'));
  }
  // 工作区级 hook（ZCode）：hook.file 不存在，路径来自 hook.eventsPath。
  // daemon 无法枚举工作区，所以它不该内联这条路径作为 hookFile，而应标记 hookWorkspace。
  {
    const zc = clients.byKey('zcode');
    chk('⑨ ZCode 的 hook 是工作区级（scope=workspace）',
      zc.hook.scope === 'workspace', String(zc.hook.scope));
    chk('⑨ ZCode 的 hook 带 events 容器（hooks.events.UserPromptSubmit）',
      zc.hook.eventsContainer === 'events', String(zc.hook.eventsContainer));
    chk('⑨ ZCode 的用户级配置被标记为「禁止出现 hooks」',
      zc.hook.forbiddenAtUserConfig === true, String(zc.hook.forbiddenAtUserConfig));
    // eventsPath 的分段必须在 daemon 的提示文案里出现（保证两边描述同一个位置）
    const segs = zc.hook.eventsPath;
    const pattern = new RegExp(segs.map((s) => s.replace(/\./g, '\\.')).join('[\\\\/]+'));
    chk('⑨ daemon 内联的 ZCode hook 位置说明与清单一致',
      pattern.test(DAEMON), segs.join('/'));
    chk('⑨ daemon 标记了 ZCode 的 hookWorkspace',
      DAEMON.includes('hookWorkspace'), '');
    // 事件层级名也要出现在 daemon 的检测实现里
    chk('⑨ daemon 的 hook 检测支持 events 层级',
      DAEMON.includes('hooksArrOf') && DAEMON.includes('container'), '');
  }
  // toml 段名与 dsh 标记
  chk('⑨ daemon 用的 toml 段名与清单一致',
    DAEMON.includes(clients.byKey('codex').tomlSection),
    clients.byKey('codex').tomlSection);
  chk('⑨ daemon 用的 dsh 标记与清单一致',
    DAEMON.includes(clients.byKey('deepseek-harness').patchMark),
    clients.byKey('deepseek-harness').patchMark);
  // 六个客户端的显示名都要在 daemon 的 agentStatus 里出现（否则网页端会漏报某个客户端）
  for (const c of clients.CLIENTS) {
    chk(`⑨ daemon agentStatus 覆盖客户端「${c.name}」`,
      DAEMON.includes(`'${c.name}'`) || DAEMON.includes(`"${c.name}"`), '');
  }
  // 反查：daemon 的内联清单不能被漏改（运行时断言条目数 = 6 客户端 + 1 指令文件）
  const HOMEDIR = os.homedir();   // 用真实 home 只为拿到条目形状，不依赖其中内容
  const dmod = require(path.join(ROOT, 'daemon', 'tdai-daemon.js'));
  const st = dmod.agentStatus();
  chk('⑨ daemon agentStatus 运行时条目数 = 客户端数 + 1（指令文件）',
    st.length === clients.CLIENTS.length + 1,
    'len=' + st.length + ' 期望=' + (clients.CLIENTS.length + 1));
  const names = st.map((x) => x.name);
  for (const c of clients.CLIENTS) {
    chk(`⑨ daemon agentStatus 运行时含「${c.name}」`, names.includes(c.name), names.join(','));
  }
  chk('⑨ daemon agentStatus 运行时含「全局指令文件」', names.includes('全局指令文件'), names.join(','));
  chk('⑨ daemon agentStatus 的 status 只用 installed/absent/missing',
    st.every((x) => ['installed', 'absent', 'missing'].includes(x.status)),
    st.map((x) => x.status).join(','));
}

/* ---------- ⑩ 面板响应判定：daemon 内联副本 = core 真源 ----------
 * daemon 因 SEA 自包含不能 require core/panel-codes.js，只能内联一份。
 * 内联副本最容易"改了 core 忘了 daemon"（实测就是这么漂移的：core 支持
 * 字符串业务码，daemon 那版只看数字 code → 提示退化成"面板返回 HTTP 400"）。
 * 这里用同一批响应体喂两边，逐字段比对结论，把漂移钉死。
 */
{
  const panel = require(path.join(ROOT, 'core', 'panel-codes.js'));
  const dmod10 = require(path.join(ROOT, 'daemon', 'tdai-daemon.js'));

  // 覆盖"业务码出现的三种位置"：数字 code / 字符串 code / message / error
  const CASES = [
    { name: '成功', r: { status: 200, json: { code: 0, message: 'ok', data: {} } } },
    { name: '数字code鉴权失败', r: { status: 401, json: { code: 401, message: 'INVALID_USER_KEY' } } },
    { name: '字符串code-缺实例', r: { status: 400, json: { code: 'MISSING_INSTANCE_ID', message: 'missing' } } },
    { name: '字符串code-坏实例', r: { status: 400, json: { code: 'INVALID_INSTANCE', message: 'invalid' } } },
    { name: '字符串code-非法层', r: { status: 400, json: { code: 'INVALID_LAYER', message: 'bad layer' } } },
    { name: 'message常量', r: { status: 400, json: { code: 400, message: 'MISSING_BLOCK_ID' } } },
    { name: 'error字段', r: { status: 400, json: { code: 400, error: 'INVALID_TEAM_ID' } } },
    { name: '纯文本404', r: { status: 404, raw: 'Not Found' } },
    { name: '5xx', r: { status: 503, raw: '<html>oops</html>' } },
    { name: '不可达(status 0)', r: { status: 0 } },
    { name: '未知4xx', r: { status: 418, json: { code: 418, message: 'teapot' } } },
    { name: '未知业务码', r: { status: 400, json: { code: 400, message: 'SOMETHING_NEW' } } },
  ];
  // daemon 侧入口：classifyPanel 不导出，故经 mkApi 的响应包装等价路径验证。
  // 这里用 daemon 导出的 panelClassify 若存在，否则退回正则契约断言。
  const dCls = typeof dmod10.classifyPanel === 'function' ? dmod10.classifyPanel : null;
  if (dCls) {
    for (const c of CASES) {
      const a = panel.classify(c.r);
      const b = dCls(c.r);
      chk(`⑩ 【同源】${c.name}：core 与 daemon 的 key/kind 一致`,
        a.key === (b.key || '') && a.kind === b.kind,
        `core={key:"${a.key}",kind:"${a.kind}"} daemon={key:"${b.key || ''}",kind:"${b.kind}"}`);
    }
  } else {
    // 未导出时退化为"源码同源"断言：三处取码位置必须都出现在 daemon 内联块里
    const D = strip(fs.readFileSync(path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'utf8'));
    chk('⑩ daemon 内联 classify 读取字符串形态 code',
      /typeof json\.code === 'string'/.test(D), '');
    chk('⑩ daemon 内联 classify 同时读 message 与 error',
      /json\.message \|\| json\.msg \|\| json\.error/.test(D) && /json\.error/.test(D), '');
    chk('⑩ daemon 的 PANEL_HINTS 键集合 = core 的 PANEL_HINTS 键集合',
      JSON.stringify(Object.keys(dmod10.PANEL_HINTS || {}).sort())
      === JSON.stringify(Object.keys(panel.PANEL_HINTS).sort()),
      JSON.stringify(Object.keys(dmod10.PANEL_HINTS || {}).sort()));
    chk('⑩ daemon 的 PANEL_CODE_CLASS 键集合 = core 的 PANEL_CODE_CLASS 键集合',
      JSON.stringify(Object.keys(dmod10.PANEL_CODE_CLASS || {}).sort())
      === JSON.stringify(Object.keys(panel.PANEL_CODE_CLASS).sort()),
      JSON.stringify(Object.keys(dmod10.PANEL_CODE_CLASS || {}).sort()));
  }
  // 无论走哪条分支，提示文案表与分类表都必须一致（这是给用户看的唯一出口）
  chk('⑩ API 前缀 core 与 daemon 一致（/api/v1，不是 /v3）',
    panel.API_PREFIX === '/api/v1'
    && strip(fs.readFileSync(path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'utf8')).includes("PANEL_API_PREFIX = '/api/v1'"),
    panel.API_PREFIX);
}

/* ---------- ⑪ ZCode 会话库来源：降级必须可见（真实故障，2026-09-22） ----------
 * 故障现象：线上记忆库的 L0 对话原文停在某个时刻，之后新对话**不再自动上传**，
 *   而控制台左上角照样显示"实时连接正常"、没有任何异常提示 —— 完全静默。
 * 根因：桌面版守护进程跑在 Electron 内嵌 Node 里（tdai-hook.cmd 用
 *   `ELECTRON_RUN_AS_NODE=1 TD记忆守护.exe …`），Electron 33 → 内嵌 Node 20.18.3
 *   → **没有 node:sqlite**。zcode-db 这个虚拟来源的 zdbQuery() 静默 return []，
 *   于是也永远列不出会话、游标永不推进。
 *   ⚠️ 与用户系统装的 Node 版本**无关**（用户系统是 Node 22）—— 这正是最迷惑的地方。
 * 本组钉死：该来源的可用性必须能被 /health 读到，UI 才能把失败摆到台面上。
 */
{
  const dstr = fs.readFileSync(path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'utf8');
  const dmod = (() => { try { return require(path.join(ROOT, 'daemon', 'tdai-daemon.js')); } catch (_) { return null; } })();
  chk('⑪ daemon 导出 zdbStatus（供 /health 与测试消费）',
    !!(dmod && typeof dmod.zdbStatus === 'function'), typeof (dmod && dmod.zdbStatus));
  if (dmod && typeof dmod.zdbStatus === 'function') {
    const z = dmod.zdbStatus();
    chk('⑪ zdbStatus 返回 ok/reason/runtime 三要素',
      typeof z.ok === 'boolean' && typeof z.reason === 'string' && typeof z.runtime === 'string',
      JSON.stringify(z).slice(0, 120));
    chk('⑪ zdbStatus 报告运行时标签（区分 Electron 内嵌 Node 与系统 Node）',
      /^(Node|Electron) /.test(z.runtime), z.runtime);
    chk('⑪ zdbStatus 带 isElectron 标记', typeof z.isElectron === 'boolean', String(z.isElectron));
    chk('⑪ zdbStatus 报告会话库路径（便于自查）',
      typeof z.dbPath === 'string' && /db\.sqlite$/.test(z.dbPath), String(z.dbPath));
  }
  // 内联副本一致性：最低 Node 版本常量必须与 pet/src/sessions.js 相同
  const sessSrc = fs.readFileSync(path.join(ROOT, 'pet', 'src', 'sessions.js'), 'utf8');
  const minDaemon = (dstr.match(/ZDB_MIN_NODE\s*=\s*'([^']+)'/) || [])[1];
  const minPet = (sessSrc.match(/SQLITE_MIN_NODE\s*=\s*'([^']+)'/) || [])[1];
  chk('⑪ daemon 与 pet 的最低 Node 版本常量一致',
    minDaemon && minPet && minDaemon === minPet, `daemon=${minDaemon} pet=${minPet}`);
  // /health 必须把 zdb 暴露出去 —— 否则界面拿不到失败原因，又是静默。
  // ⚠️ 这里不能用"jsonRes(...) 到 zdb 之间不超过 N 字符"这种跨度正则：
  //    /health 的 jsonRes 块是多行对象字面量，跨行匹配要靠 [\s\S]，
  //    而"限制跨度"的懒惰量词在改过字段顺序后会静默 false（假红）。
  //    改成两个独立断言：① 该块内出现 zdb 字段；② zdb 的值确实是 zdbStatus() 调用。
  const dBare = strip(dstr);
  chk('⑪ /health 响应里带上 zdb 字段',
    /zdb:\s*zdbStatus\(\)/.test(dBare), '未在 /health 中暴露');
  chk('⑪ zdb 字段紧邻 uploadSources（确认属于 /health 的响应体）',
    /uploadSources,\s*zdb:\s*zdbStatus\(\)/.test(dBare) || /zdb:\s*zdbStatus\(\),/.test(dBare), '');
  chk('⑪ 守护采集循环对 zcode-db 是"虚拟来源"特判（不是按文件读）',
    /def\.virtual/.test(dBare) && /ZDB_CURSOR_PREFIX/.test(dBare), '');
}

console.log('\n---------- 客户端清单一致性验证：通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
ok.forEach((x) => console.log('  ✓ ' + x));
if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
process.exit(0);