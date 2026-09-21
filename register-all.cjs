// register-all.cjs — 一键把 TD 记忆注册进本机所有 Agent 客户端（幂等，跑前备份）
// 用法：node register-all.cjs [--no-hook] [--no-instructions] [--autostart]
//   --no-hook          跳过 Claude Code UserPromptSubmit hook
//   --no-instructions  跳过全局指令文件（AGENTS.md / CLAUDE.md）
//   --autostart        同时写启动文件夹 VBS（登录自启守护进程）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname);
const NODE = process.execPath;
const DAEMON = path.join(REPO, 'daemon', 'tdai-daemon.js');
const MCP = path.join(REPO, 'mcp', 'tdai-mcp.js');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const FLAGS = new Set(process.argv.slice(2));
const DO_HOOK = !FLAGS.has('--no-hook');
const DO_INSTR = !FLAGS.has('--no-instructions');
const DO_AUTOSTART = FLAGS.has('--autostart');

const results = [];

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = file + '.bak.' + STAMP;
  fs.copyFileSync(file, bak);
  return bak;
}
function record(target, action, detail) {
  results.push({ target, action, detail });
  console.log(`[${action}] ${target} — ${detail}`);
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJSON(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

/* ---------- 1. MCP 注册（各客户端配置文件） ---------- */

const mcpStdio = { type: 'stdio', command: NODE, args: [MCP] };

// ZCode CLI
{
  const f = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  const c = readJSON(f) || {};
  c.mcp = c.mcp || {}; c.mcp.servers = c.mcp.servers || {};
  const existed = !!c.mcp.servers.tdai;
  c.mcp.servers.tdai = mcpStdio;
  backup(f); writeJSON(f, c);
  record(f, existed ? '覆盖' : '新增', 'mcp.servers.tdai');
}

// Claude Code（用户级 ~/.claude.json）
{
  const f = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(f)) {
    const c = readJSON(f) || {};
    c.mcpServers = c.mcpServers || {};
    const existed = !!c.mcpServers.tdai;
    c.mcpServers.tdai = mcpStdio;
    backup(f); writeJSON(f, c);
    record(f, existed ? '覆盖' : '新增', 'mcpServers.tdai');
  } else record(f, '跳过', '文件不存在（未安装 Claude Code）');
}

// Cursor
{
  const f = path.join(os.homedir(), '.cursor', 'mcp.json');
  const existed = fs.existsSync(f);
  const c = existed ? (readJSON(f) || {}) : {};
  c.mcpServers = c.mcpServers || {};
  c.mcpServers.tdai = mcpStdio;
  if (existed) backup(f);
  writeJSON(f, c);
  record(f, existed ? '覆盖' : '新增', 'mcpServers.tdai');
}

// Codex（TOML 追加）
{
  const f = path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(f)) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('[mcp_servers.tdai]')) {
      record(f, '跳过', '已存在 [mcp_servers.tdai]');
    } else {
      backup(f);
      fs.appendFileSync(f, `\n[mcp_servers.tdai]\ncommand = "${NODE.replace(/\\/g, '\\\\')}"\nargs = ["${MCP.replace(/\\/g, '\\\\')}"]\n`);
      record(f, '追加', '[mcp_servers.tdai]');
    }
  } else record(f, '跳过', '文件不存在（未安装 Codex）');
}

/* ---------- 2. Claude Code UserPromptSubmit hook ---------- */

if (DO_HOOK) {
  const f = path.join(os.homedir(), '.claude', 'settings.json');
  const c = readJSON(f) || {};
  c.hooks = c.hooks || {};
  c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit || [];
  const cmd = `${NODE} "${DAEMON}" hook`;
  const entry = { matcher: '*', hooks: [{ type: 'command', command: cmd }] };
  const already = JSON.stringify(c.hooks.UserPromptSubmit).includes(DAEMON);
  if (already) {
    record(f, '跳过', 'hook 已存在');
  } else {
    c.hooks.UserPromptSubmit.push(entry);
    backup(f); writeJSON(f, c);
    record(f, '新增', 'UserPromptSubmit → daemon hook');
  }
}

/* ---------- 3. 全局指令文件（档 B 兜底硬规则） ---------- */

const INSTR = [
  '',
  '<!-- tdai-memory:begin -->',
  '## 团队记忆（TD）',
  '当用户提到「之前」「上次」「我们怎么做的」「还记得」等回忆类表述时，先调用 tdai.my_agents 拿 block_id，再调用 tdai.memory_search 检索团队记忆，基于检索结果回答并标注来源；不要凭猜测回答历史问题。',
  '技能/Wiki/代码图谱检索用 tdai.skill_list / tdai.skill_get / tdai.wiki_search / tdai.codegraph_search / tdai.codegraph_explore。',
  '<!-- tdai-memory:end -->',
  '',
].join('\n');

if (DO_INSTR) {
  for (const f of [
    path.join(os.homedir(), '.zcode', 'AGENTS.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  ]) {
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (text.includes('tdai-memory:begin')) { record(f, '跳过', '指令块已存在'); continue; }
    if (fs.existsSync(f)) backup(f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, INSTR);
    record(f, '追加', '团队记忆指令块');
  }
}

/* ---------- 4. 可选：启动文件夹自启守护进程 ---------- */

if (DO_AUTOSTART) {
  const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  // VBS 引号嵌套坑：无空格纯路径不适用时用Chr(34)；node 路径一般无空格，daemon 路径可能含空格 → 用 Chr(34) 拼接
  const vbs = [
    'Set ws = CreateObject("WScript.Shell")',
    `ws.Run Chr(34) & "${NODE}" & Chr(34) & " " & Chr(34) & "${DAEMON}" & Chr(34), 0, False`,
  ].join('\r\n');
  const vbsPath = path.join(startup, 'tdai-daemon.vbs');
  fs.writeFileSync(vbsPath, vbs);
  record(vbsPath, '写入', '登录自启 tdai-daemon serve');
}

console.log(`\n完成：${results.length} 项。配置文件：~/.zcode/tdai-mcp.json（panelUrl/userKey/teamId/agentId）。`);
