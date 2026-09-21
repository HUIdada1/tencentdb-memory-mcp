// 功能校验：Agent 接入模块（pet/src/register.js）
// 隔离临时 HOME，验证「一键接入」写入的配置内容、幂等性、状态判定与备份。
// 纯 Node（不依赖 electron），发版流水线可直接跑。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const register = require(path.join(REPO, 'pet', 'src', 'register.js'));

const results = [];
function check(name, ok) { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-reg-'));
const HOME_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-reg-empty-'));
const EXE = 'C:\\Program Files\\TD记忆守护\\TD记忆守护.exe';
const MCP_JS = 'C:\\Program Files\\TD记忆守护\\resources\\mcp\\tdai-mcp.js';
const DAEMON_JS = 'C:\\Program Files\\TD记忆守护\\resources\\daemon\\tdai-daemon.js';
const CLIENTS = ['ZCode CLI', 'Claude Code', 'Cursor', 'Codex', 'Trae', 'DeepSeek Harness'];
const KEYS = ['zcode', 'claude-code', 'cursor', 'codex', 'trae', 'deepseek-harness'];
const find = (arr, key) => arr.find((x) => x.key === key);
const read = (p) => fs.readFileSync(path.join(HOME, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

// 造 6 个「已安装」客户端（各自带原有配置，验证不被破坏）
fs.mkdirSync(path.join(HOME, '.zcode', 'cli'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.zcode', 'cli', 'config.json'), JSON.stringify({ model: 'keep-me', mcp: { servers: { other: { command: 'x' } } } }));
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { existing: { command: 'y' } } }));
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] }, theme: 'dark' }));
fs.mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), '# existing\nmodel = "keep-me"\n');
fs.mkdirSync(path.join(HOME, '.trae'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), '# Your patch layer for this dsh profile.\n[]\n');
fs.mkdirSync(path.join(HOME, '.dsh', 'profiles', 'web'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - resolve: "@deepseek-ai/dsh-some-other"\n      config: {}\n');

/* ---------- 1. 初始状态 ---------- */
const s0 = register.status({ home: HOME, exePath: EXE });
check('初始：6 个已装客户端均「未接入」', KEYS.every((k) => find(s0, k).status === 'missing'));
check('初始：指令文件未写入', find(s0, 'instructions').status === 'missing');
const sEmpty = register.status({ home: HOME_EMPTY, exePath: EXE });
check('空 HOME：客户端全部「未装客户端」', KEYS.every((k) => find(sEmpty, k).status === 'absent'));
check('空 HOME：无 hook 标注误报', !(find(sEmpty, 'claude-code').detail || '').includes('hook 已注入'));

/* ---------- 2. 一键接入 ---------- */
const r1 = register.register({ home: HOME, exePath: EXE, mcpJs: MCP_JS, daemonJs: DAEMON_JS });
check('注册：6 个客户端均写入', CLIENTS.every((n) => r1.some((x) => x.target === n && ['新增', '追加', '覆盖'].includes(x.action))));
check('注册：无失败项', !r1.some((x) => x.action === '失败'));
check('注册：未安装客户端不造配置', !fs.existsSync(path.join(HOME, '.gemini')) && !fs.existsSync(path.join(HOME, '.windsurf')));

const zc = readJson('.zcode/cli/config.json');
check('ZCode：条目指向本应用 exe', zc.mcp.servers.tdai.command === EXE && zc.mcp.servers.tdai.args[0] === MCP_JS);
check('ZCode：以 ELECTRON_RUN_AS_NODE 运行（不依赖 node）', zc.mcp.servers.tdai.env.ELECTRON_RUN_AS_NODE === '1');
check('ZCode：原有配置与其它 server 未被破坏', zc.model === 'keep-me' && !!zc.mcp.servers.other);
check('ZCode：写入前生成备份', fs.readdirSync(path.join(HOME, '.zcode', 'cli')).some((f) => f.includes('.bak.')));

const cc = readJson('.claude.json');
check('Claude Code：mcpServers.tdai 已写入且保留其它 server', !!cc.mcpServers.tdai && !!cc.mcpServers.existing);

const cu = readJson('.cursor/mcp.json');
check('Cursor：mcp.json 新建并写入', !!cu.mcpServers.tdai && cu.mcpServers.tdai.command === EXE);

const cx = read('.codex/config.toml');
check('Codex：追加 [mcp_servers.tdai] 且路径已转义', cx.includes('[mcp_servers.tdai]') && cx.includes(EXE.replace(/\\/g, '\\\\')));
check('Codex：env 与原有配置保留', cx.includes('ELECTRON_RUN_AS_NODE = "1"') && cx.includes('model = "keep-me"'));

const tr = readJson('.trae/mcp.json');
check('Trae：mcp.json 新建并写入', !!tr.mcpServers.tdai && tr.mcpServers.tdai.command === EXE);

const dshDesk = read('.dsh/profiles/desktop/cordis.patch.yml');
const dshWeb = read('.dsh/profiles/web/cordis.patch.yml');
check('dsh：空占位 [] 重写为 insert 条目（非法 YAML 规避）', dshDesk.includes('- insert:') && dshDesk.includes("resolve: '@deepseek-ai/dsh-mcp-client'") && !dshDesk.includes('[]'));
check('dsh：既有 patch 列表走追加', dshWeb.includes('dsh-mcp-client') && dshWeb.includes('dsh-some-other'));
check('dsh：serverName 与 env 正确', dshDesk.includes('serverName: tdai-memory') && dshDesk.includes("ELECTRON_RUN_AS_NODE: '1'"));
check('dsh：模板注释保留', dshDesk.includes('# Your patch layer'));

const st = readJson('.claude/settings.json');
check('Claude Code：hook 已注入且原 hooks 保留', JSON.stringify(st.hooks.UserPromptSubmit).includes('tdai-hook.cmd') && Array.isArray(st.hooks.PreToolUse) && st.theme === 'dark');
const zcHook = readJson('.zcode/cli/config.json');
check('ZCode：hook 已注入且 mcp/model 保留', JSON.stringify(zcHook.hooks.UserPromptSubmit).includes('tdai-hook.cmd') && !!zcHook.mcp.servers.tdai && zcHook.model === 'keep-me');
const hookCmd = read('.zcode/tdai-daemon/tdai-hook.cmd');
check('hook 脚本：设 env 后调用 daemon hook 子命令', hookCmd.includes('ELECTRON_RUN_AS_NODE=1') && hookCmd.includes(DAEMON_JS) && /hook\s*\r?\n?$/.test(hookCmd.replace(/\r\n/g, '\n')));

check('指令文件：AGENTS.md 追加指令块', read('.zcode/AGENTS.md').includes('tdai-memory:begin'));
check('指令文件：CLAUDE.md 追加指令块', read('.claude/CLAUDE.md').includes('tdai-memory:begin'));

/* ---------- 3. 接入后状态 ---------- */
const s1 = register.status({ home: HOME, exePath: EXE });
check('接入后：6 个客户端均「已接入」', KEYS.every((k) => find(s1, k).status === 'installed'));
check('接入后：标注「本应用接入」', find(s1, 'zcode').detail.includes('本应用'));
check('接入后：Claude Code 标注 hook 已注入', /hook 已注入/.test(find(s1, 'claude-code').detail || ''));
check('接入后：ZCode 标注 hook 已注入', /hook 已注入/.test(find(s1, 'zcode').detail || ''));
check('接入后：dsh 标注已写入 patch', /cordis\.patch/.test(find(s1, 'deepseek-harness').detail || ''));
check('接入后：指令文件「已接入」', find(s1, 'instructions').status === 'installed');

/* ---------- 4. 幂等 ---------- */
const r2 = register.register({ home: HOME, exePath: EXE, mcpJs: MCP_JS, daemonJs: DAEMON_JS });
check('再跑一次：MCP 客户端全部「跳过」', CLIENTS.every((n) => r2.find((x) => x.target === n).action === '跳过'));
check('再跑一次：hook 跳过（脚本仍更新）', r2.find((x) => x.target === 'Claude Code hook').action === '跳过' && r2.find((x) => x.target === 'ZCode hook').action === '跳过');
check('再跑一次：指令文件全部「跳过」', r2.filter((x) => x.target.endsWith('.md')).every((x) => x.action === '跳过'));

/* ---------- 5. 由其它程序接入时的来源标注 ---------- */
const zc2 = readJson('.zcode/cli/config.json');
zc2.mcp.servers.tdai = { type: 'stdio', command: 'C:\\nodejs\\node.exe', args: ['D:\\src\\mcp\\tdai-mcp.js'] };
fs.writeFileSync(path.join(HOME, '.zcode', 'cli', 'config.json'), JSON.stringify(zc2, null, 2));
const s2 = register.status({ home: HOME, exePath: EXE });
check('指向其它程序：仍判 installed 并标注来源', find(s2, 'zcode').status === 'installed' && find(s2, 'zcode').detail.includes('node.exe'));

/* ---------- 收尾 ---------- */
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(HOME_EMPTY, { recursive: true, force: true });
const failed = results.filter((r) => !r[1]);
console.log(failed.length ? `\n接入模块校验失败 ${failed.length} 项` : `\n接入模块校验全部通过（${results.length} 项）`);
process.exit(failed.length ? 1 : 0);
