// register.js — Agent 接入：状态检测 + 一键注册（MCP / Claude Code hook / 全局指令文件）
// 纯 Node（不依赖 electron），可脱离应用单测；与源码版 register-all.cjs 的差异：
// 注册目标一律指向**已安装的应用 exe**（ELECTRON_RUN_AS_NODE 以 node 模式跑打包内的 js），
// 不依赖用户机器上的 node 与源码目录——这是 exe 用户唯一可行的接入路径。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 只注册到"确实装了"的客户端：目录/文件不存在即跳过，绝不替未安装的客户端造配置
const CLIENTS = [
  { key: 'zcode', name: 'ZCode CLI', probe: (h) => path.join(h, '.zcode'), kind: 'json', file: (h) => path.join(h, '.zcode', 'cli', 'config.json'), pointer: '/mcp/servers/tdai' },
  { key: 'claude-code', name: 'Claude Code', probe: (h) => path.join(h, '.claude.json'), kind: 'json', file: (h) => path.join(h, '.claude.json'), pointer: '/mcpServers/tdai' },
  { key: 'cursor', name: 'Cursor', probe: (h) => path.join(h, '.cursor'), kind: 'json', file: (h) => path.join(h, '.cursor', 'mcp.json'), pointer: '/mcpServers/tdai' },
  { key: 'codex', name: 'Codex', probe: (h) => path.join(h, '.codex', 'config.toml'), kind: 'toml', file: (h) => path.join(h, '.codex', 'config.toml') },
];

const INSTR = [
  '',
  '<!-- tdai-memory:begin -->',
  '## 团队记忆（TD）',
  '当用户提到「之前」「上次」「我们怎么做的」「还记得」等回忆类表述时，先调用 tdai.my_agents 拿 block_id，再调用 tdai.memory_search 检索团队记忆，基于检索结果回答并标注来源；不要凭猜测回答历史问题。',
  '技能/Wiki/代码图谱检索用 tdai.skill_list / tdai.skill_get / tdai.wiki_search / tdai.codegraph_search / tdai.codegraph_explore。',
  '<!-- tdai-memory:end -->',
  '',
].join('\n');

const INSTR_FILES = ['AGENTS.md', 'CLAUDE.md'];
const HOOK_MARK = 'tdai-hook.cmd';

/* ---------- 小工具 ---------- */

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { } }
function backup(file) {
  if (!exists(file)) return null;
  const bak = file + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(file, bak); return bak; } catch (_) { return null; }
}
function writeJson(file, obj) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function samePath(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } catch (_) { return false; }
}

/* ---------- 注册内容（MCP 条目 / hook 脚本） ---------- */

// MCP stdio 条目：本应用 exe 以 node 模式运行打包内的 mcp server
function mcpEntry({ exePath, mcpJs }) {
  return { type: 'stdio', command: exePath, args: [mcpJs], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// hook 包装脚本：Claude Code 的 hook 不支持 env 字段，用 .cmd 设好 env 再调 daemon hook 子命令
function hookScript({ exePath, daemonJs }) {
  return ['@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', `"${exePath}" "${daemonJs}" hook`, ''].join('\r\n');
}

function hookCmdPath(home) { return path.join(home, '.zcode', 'tdai-daemon', HOOK_MARK); }

/* ---------- 状态检测 ---------- */

function entryOf(cls, home) {
  const file = cls.file(home);
  if (cls.kind === 'toml') {
    const t = readText(file);
    if (t == null) return null;
    const m = t.match(/\[mcp_servers\.tdai\]([\s\S]*?)(?=\n\[|$)/);
    if (!m) return null;
    const cmd = (m[1].match(/command\s*=\s*"([^"]+)"/) || [])[1];
    return { command: cmd };
  }
  const c = readJson(file);
  const parts = cls.pointer.split('/').filter(Boolean);
  let cur = c;
  for (const p of parts) { if (!cur || typeof cur !== 'object') return null; cur = cur[p]; }
  return cur && typeof cur === 'object' ? cur : null;
}

// 每个客户端的接入状态：installed=已接入 / missing=装了未接入 / absent=未装客户端
function status({ home = os.homedir(), exePath = '' } = {}) {
  const items = [];
  for (const cls of CLIENTS) {
    const installed = exists(cls.probe(home));
    const entry = entryOf(cls, home);
    const detail = entry
      ? (samePath(entry.command, exePath) ? '本应用接入' : `由 ${path.basename(entry.command || '')} 接入`)
      : '';
    items.push({
      key: cls.key,
      name: cls.name,
      status: !installed ? 'absent' : (entry ? 'installed' : 'missing'),
      detail,
    });
  }

  // Claude Code hook
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  const hasHook = !!(settings && JSON.stringify(settings.hooks && settings.hooks.UserPromptSubmit || []).includes(HOOK_MARK));
  const cc = items.find((x) => x.key === 'claude-code');
  if (cc) cc.detail = [cc.detail, hasHook ? 'hook 已注入' : (cc.status === 'absent' ? '' : 'hook 未注入')].filter(Boolean).join(' · ');

  // 全局指令文件（MCP 没生效时的兜底硬规则）
  const instrFiles = INSTR_FILES.map((n) => path.join(home, '.claude', n)).concat([path.join(home, '.zcode', 'AGENTS.md')]);
  const instrHit = instrFiles.filter((f) => (readText(f) || '').includes('tdai-memory:begin'));
  items.push({
    key: 'instructions',
    name: '全局指令文件',
    status: instrHit.length ? 'installed' : 'missing',
    detail: instrHit.length ? `${instrHit.map((f) => path.basename(f)).join(' / ')} 已写入` : '兜底规则未写入',
  });

  return items;
}

/* ---------- 一键接入 ---------- */

function register({ home = os.homedir(), exePath, mcpJs, daemonJs } = {}) {
  if (!exePath) throw new Error('缺少 exePath（接入目标）');
  const results = [];
  const rec = (target, action, detail) => results.push({ target, action, detail });

  // 1. 各客户端 MCP 注册
  for (const cls of CLIENTS) {
    const file = cls.file(home);
    if (!exists(cls.probe(home))) { rec(cls.name, '跳过', '未安装该客户端'); continue; }
    try {
      if (cls.kind === 'toml') {
        const text = readText(file) || '';
        if (text.includes('[mcp_servers.tdai]')) { rec(cls.name, '跳过', '已注册 [mcp_servers.tdai]'); continue; }
        const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        backup(file);
        fs.appendFileSync(file, `\n[mcp_servers.tdai]\ncommand = "${esc(exePath)}"\nargs = ["${esc(mcpJs)}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`);
        rec(cls.name, '追加', '[mcp_servers.tdai]');
      } else {
        const c = readJson(file) || {};
        const next = mcpEntry({ exePath, mcpJs });
        const zcodeStyle = cls.pointer === '/mcp/servers/tdai';
        if (zcodeStyle) { c.mcp = c.mcp || {}; c.mcp.servers = c.mcp.servers || {}; }
        else { c.mcpServers = c.mcpServers || {}; }
        const prev = zcodeStyle ? c.mcp.servers.tdai : c.mcpServers.tdai;
        // 完全一致就不重写、不备份（真正幂等）
        if (prev && JSON.stringify(prev) === JSON.stringify(next)) { rec(cls.name, '跳过', '已是本应用接入'); continue; }
        if (zcodeStyle) c.mcp.servers.tdai = next; else c.mcpServers.tdai = next;
        backup(file); writeJson(file, c);
        rec(cls.name, prev ? '覆盖' : '新增', prev ? '更新为当前程序路径' : cls.pointer);
      }
    } catch (e) { rec(cls.name, '失败', e.message); }
  }

  // 2. Claude Code UserPromptSubmit hook（提问前自动注入记忆，不依赖模型主动调用）
  try {
    if (!exists(path.join(home, '.claude'))) { rec('Claude Code hook', '跳过', '未安装 Claude Code'); }
    else {
      const cmdFile = hookCmdPath(home);
      ensureDir(path.dirname(cmdFile));
      fs.writeFileSync(cmdFile, hookScript({ exePath, daemonJs }));
      const f = path.join(home, '.claude', 'settings.json');
      const c = readJson(f) || {};
      c.hooks = c.hooks || {};
      c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit || [];
      if (JSON.stringify(c.hooks.UserPromptSubmit).includes(HOOK_MARK)) {
        rec('Claude Code hook', '跳过', 'hook 已存在（脚本已更新）');
      } else {
        c.hooks.UserPromptSubmit.push({ matcher: '*', hooks: [{ type: 'command', command: `"${cmdFile}"` }] });
        backup(f); writeJson(f, c);
        rec('Claude Code hook', '新增', 'UserPromptSubmit → 本应用');
      }
    }
  } catch (e) { rec('Claude Code hook', '失败', e.message); }

  // 3. 全局指令文件（档 B 兜底：告诉模型何时调 tdai 工具）
  for (const rel of [['.zcode', 'AGENTS.md'], ['.claude', 'CLAUDE.md']]) {
    const dir = path.join(home, rel[0]);
    const f = path.join(dir, rel[1]);
    if (!exists(dir)) { rec(rel[1], '跳过', `无 ${rel[0]} 目录（未安装对应客户端）`); continue; }
    try {
      const text = readText(f) || '';
      if (text.includes('tdai-memory:begin')) { rec(rel[1], '跳过', '指令块已存在'); continue; }
      backup(f);
      ensureDir(dir);
      fs.appendFileSync(f, INSTR);
      rec(rel[1], '追加', '团队记忆指令块');
    } catch (e) { rec(rel[1], '失败', e.message); }
  }

  return results;
}

module.exports = { status, register, mcpEntry, hookScript, hookCmdPath, INSTR, CLIENTS, HOOK_MARK };
