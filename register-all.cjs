// register-all.cjs — 一键把 TD 记忆注册进本机所有 Agent 客户端（幂等，跑前备份）
// 用法：node register-all.cjs [--no-hook] [--no-instructions] [--autostart] [--workspace <项目根>]
//   --no-hook          跳过 UserPromptSubmit hook
//   --no-instructions  跳过全局指令文件（AGENTS.md / CLAUDE.md）
//   --autostart        同时写启动文件夹 VBS（登录自启守护进程）
//   --workspace <dir>  ZCode 的 hook 是工作区级的，用它指定要接入的项目根
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname);
const NODE = process.execPath;
const DAEMON = path.join(REPO, 'daemon', 'tdai-daemon.js');
const MCP = path.join(REPO, 'mcp', 'tdai-mcp.js');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ARGV = process.argv.slice(2);
const FLAGS = new Set(ARGV);
const DO_HOOK = !FLAGS.has('--no-hook');
const DO_INSTR = !FLAGS.has('--no-instructions');
const DO_AUTOSTART = FLAGS.has('--autostart');
// --workspace 取值形式：`--workspace <dir>`
const WORKSPACE = (() => {
  const i = ARGV.indexOf('--workspace');
  return i >= 0 && ARGV[i + 1] ? path.resolve(ARGV[i + 1]) : null;
})();

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

// 在 JSON.stringify 后的文本里查找某条路径：Windows 的 `\` 转义成 `\\`。
// 直接 includes(原始路径) 会永远不命中（幂等判定失效 → 重复写入），必须先转义。
function escapeForJsonMatch(p) {
  return JSON.stringify(String(p)).slice(1, -1);   // 去掉首尾引号，得到 JSON 串里的实际形态
}

/* ---------- 0. 客户端清单（来自 core/clients.js 唯一真源） ---------- */

const { CLIENTS, INSTR, INSTR_MARK, INSTR_TARGETS, hookEventList, hookConfigFile, stripForbiddenUserHooks } = require('./core/clients.js');

/* ---------- 1. MCP 注册（各客户端配置文件，表驱动） ---------- */

// 与桌面端 register.js 共用同一份 CLIENTS 清单：认识哪些客户端、配置文件在哪、
// 用什么格式写 —— 全部同源。这里唯一不同的是"注册目标"：源码用户指向 node + 源码目录
// （桌面端指向应用 exe，那是刻意的设计差异）。
const mcpStdio = { type: 'stdio', command: NODE, args: [MCP] };

// 按 pointer 读写 JSON 条目（'/mcp/servers/tdai' 或 '/mcpServers/tdai' 通吃）
function getPointer(obj, pointer) {
  const parts = String(pointer).split('/').filter(Boolean);
  const leaf = parts.pop();
  let cur = obj;
  for (const p of parts) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[p]; }
  return cur && typeof cur === 'object' ? cur[leaf] : undefined;
}
function setPointer(obj, pointer, value) {
  const parts = String(pointer).split('/').filter(Boolean);
  const leaf = parts.pop();
  let parent = obj;
  for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
  parent[leaf] = value;
}

for (const cls of CLIENTS) {
  const probe = cls.probe(os.homedir());
  if (!fs.existsSync(probe)) { record(cls.name, '跳过', '未安装该客户端'); continue; }
  const file = cls.file(os.homedir());
  try {
    if (cls.kind === 'toml') {
      const sec = cls.tomlSection || 'mcp_servers.tdai';
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (text == null) { record(cls.name, '跳过', `文件不存在（未安装 ${cls.name}）`); continue; }
      if (text.includes(`[${sec}]`)) { record(file, '跳过', `已存在 [${sec}]`); continue; }
      backup(file);
      const esc = (s) => String(s).replace(/\\/g, '\\\\');
      fs.appendFileSync(file, `\n[${sec}]\ncommand = "${esc(NODE)}"\nargs = ["${esc(MCP)}"]\n`);
      record(file, '追加', `[${sec}]`);
    } else if (cls.kind === 'dsh-patch') {
      const profilesDir = file;
      let profiles = [];
      try { profiles = fs.readdirSync(profilesDir).filter((n) => n !== 'node_modules'); } catch (_) { }
      const mark = cls.patchMark || 'dsh-mcp-client';
      let wrote = 0, skipped = 0;
      for (const p of profiles) {
        const f = path.join(profilesDir, p, 'cordis.patch.yml');
        if (!fs.existsSync(f)) continue; // profile 未初始化（无 patch 文件）不动
        const text = fs.readFileSync(f, 'utf8');
        if (text.includes(mark)) { skipped++; continue; }
        backup(f);
        const block = [
          '# tdai-memory:begin （TD 记忆 MCP，由 register-all 写入）',
          '- insert:',
          "    - resolve: '@deepseek-ai/dsh-mcp-client'",
          '      config:',
          '        transport: stdio',
          '        serverName: tdai-memory',
          `        command: '${NODE}'`,
          '        args:',
          `          - '${MCP}'`,
          '',
        ].join('\n');
        // 模板占位（仅注释或空数组 []）不能直接追加（[] 后跟条目是非法 YAML）：保留注释行、整体重写
        const body = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trim();
        if (body === '' || body === '[]') {
          const header = text.split('\n').filter((l) => l.trim().startsWith('#')).join('\n');
          fs.writeFileSync(f, (header ? header + '\n' : '') + block);
        } else {
          fs.appendFileSync(f, '\n' + block);
        }
        wrote++;
      }
      record('~/.dsh/profiles', wrote ? '追加' : '跳过', wrote ? `${wrote} 个 profile 写入 insert 条目` : (skipped ? 'patch 已存在' : '无 cordis.patch.yml'));
    } else if (cls.kind === 'opencode') {
      // OpenCode 专有形态：字段名是 'mcp'，且 command 是**数组**（自带参数，无独立 args）
      const existed = fs.existsSync(file);
      const c = existed ? (readJSON(file) || {}) : {};
      const ptr = cls.pointer || '/mcp/tdai';
      const entry = { type: 'local', command: [NODE, MCP], enabled: true };
      const prev = getPointer(c, ptr);
      if (prev && JSON.stringify(prev) === JSON.stringify(entry)) {
        record(file, '跳过', `${ptr.replace(/^\//, '')} 已是最新`);
        continue;
      }
      setPointer(c, ptr, entry);
      if (existed) backup(file);
      writeJSON(file, c);
      record(file, prev ? '覆盖' : '新增', ptr.replace(/^\//, ''));
    } else if (cls.kind === 'yaml') {
      // Hermes：MCP 配置在**主配置 ~/.hermes/config.yaml** 的顶层 mcp_servers 里。
      // 用「块定位」而不是全量解析，避免引入 YAML 依赖（本项目零 npm 依赖是硬约束）。
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const top = cls.yamlTop || 'mcp_servers';
      const leaf = cls.yamlLeaf || 'tdai';
      if (new RegExp('^\\s{2}' + leaf + ':', 'm').test(text)) { record(file, '跳过', `已存在 ${top}.${leaf}`); continue; }
      if (text) backup(file);
      // YAML 里 Windows 路径要加引号，否则 `C:\...` 会被当作转义序列
      const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const block = new RegExp('^' + top + ':', 'm').test(text)
        ? `  ${leaf}:\n    command: ${q(NODE)}\n    args:\n      - ${q(MCP)}\n`
        : `${top}:\n  ${leaf}:\n    command: ${q(NODE)}\n    args:\n      - ${q(MCP)}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, (text && !/\n$/.test(text) ? '\n' : '') + '\n' + block);
      record(file, text ? '追加' : '新建', `${top}.${leaf}`);
    } else {
      const existed = fs.existsSync(file);
      const c = existed ? (readJSON(file) || {}) : {};
      const ptr = cls.pointer || '/mcpServers/tdai';
      // 真幂等：条目内容完全一致就跳过（不重写、不备份）。
      // 早先只看"条目是否存在"，于是每次运行都重写+留一份 .bak，
      // 备份目录被无意义地堆满，用户也分不清这次到底改没改。
      const prev = getPointer(c, ptr);
      if (prev && JSON.stringify(prev) === JSON.stringify(mcpStdio)) {
        record(file, '跳过', `${ptr.replace(/^\//, '')} 已是最新`);
        continue;
      }
      setPointer(c, ptr, mcpStdio);
      if (existed) backup(file);
      writeJSON(file, c);
      record(file, prev ? '覆盖' : '新增', ptr.replace(/^\//, ''));
    }
  } catch (e) {
    record(cls.name, '失败', e.message);
  }
}

/* ---------- 2. UserPromptSubmit hook（Claude Code / ZCode） ---------- */

// hook 目标来自 CLIENTS 的 hook 声明（单一真源）。
//
// ⚠️ 两类客户端**不同构**，别按同一句写：
//   - Claude Code（scope=global）：~/.claude/settings.json 的 hooks.UserPromptSubmit
//   - ZCode（scope=workspace）：<工作区>/.zcode/config.json 的 hooks.events.UserPromptSubmit
// ZCode 的用户级 ~/.zcode/cli/config.json **不接受** hooks —— 写了会被 Zod 判为
// Unrecognized key 并作废整份配置（插件开关点不动）。故这里：
//   ① 先清掉用户级里的非法 hooks 残留（幂等，无残留则不动）
//   ② Claude Code 按老写法写；ZCode 需 --workspace 指定项目根，未指定则给出提示
if (DO_HOOK) {
  // ① 清理非法残留（ZCode 特有）
  for (const cls of CLIENTS.filter((c) => c.hook && c.hook.forbiddenAtUserConfig)) {
    const f = cls.file(os.homedir());
    if (!fs.existsSync(f)) continue;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    if (raw && raw.hooks) {
      const bak = stripForbiddenUserHooks(cls, os.homedir());
      record(f, bak ? '清理' : '跳过', bak ? '移除非法 hooks 段（修 ZCode 插件开关）' : '无法备份，未改动');
    }
  }
  // ② 按各自的 scope 写入
  const hookClients = CLIENTS.filter((c) => c.hook);
  for (const cls of hookClients) {
    const dir = cls.probe(os.homedir());
    if (!fs.existsSync(dir)) { record(cls.name, '跳过', '未安装该客户端'); continue; }
    if (cls.hook.scope === 'workspace' && !WORKSPACE) {
      record(cls.name, '跳过', `hook 是工作区级，需 --workspace <项目根> 指定（应写 ${cls.hook.eventsPath.join('/')}）`);
      continue;
    }
    const f = hookConfigFile(cls, os.homedir(), WORKSPACE);
    const c = readJSON(f) || {};
    const list = hookEventList(c, cls.hook, true);
    const cmd = `${NODE} "${DAEMON}" hook`;
    // ⚠️ 幂等判据必须用**已 JSON 转义**的形式去比：
    // Windows 路径里的 `\` 在 JSON 串里是 `\\`，直接 includes(DAEMON) 永远不命中
    // → 每次运行都再追加一条，hook 静默翻倍（每次提问注入两次记忆）。
    // 早先就是踩了这个坑，这里用 escapeForJsonMatch(DAEMON) 修正。
    const needle = escapeForJsonMatch(DAEMON);
    const hasCommand = (arr) => JSON.stringify(arr).includes(needle);
    if (hasCommand(list)) {
      record(f, '跳过', 'hook 已存在');
    } else {
      list.push({ matcher: '*', hooks: [{ type: 'command', command: cmd }] });
      backup(f); writeJSON(f, c);
      record(f, '新增', `UserPromptSubmit → daemon hook（${cls.name}）`);
    }
  }
}

/* ---------- 3. 全局指令文件（档 B 兜底硬规则） ---------- */

// 指令块正文与目标清单都来自 core/clients.js（唯一真源）：
// 写入集合 = 检测集合，避免用户自带的同名文件造成"已接入"假阳性。
if (DO_INSTR) {
  for (const [dir, name] of INSTR_TARGETS) {
    const f = path.join(os.homedir(), dir, name);
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (text.includes(INSTR_MARK)) { record(f, '跳过', '指令块已存在'); continue; }
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