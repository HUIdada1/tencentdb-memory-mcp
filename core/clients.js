// clients.js — Agent 客户端清单（**唯一真源**）
//
// 为什么单独抽一个文件：
//   Agent 接入同时存在于两处实现 —— `pet/src/register.js`（桌面应用，注册目标指向应用 exe）
//   与 `register-all.cjs`（源码用户，注册目标指向 node + 源码目录）。
//   它们**注册目标不同**（那是刻意设计），但**认识哪些客户端、每个客户端的配置文件在哪、
//   用什么格式写**必须完全一致。早先两边各写一份硬编码清单 → 极易漂移：
//   一边加了新客户端、另一边没加，用户就会遇到"桌面端说已接入、命令行说未接入"。
//
// 本文件只放**与执行环境无关**的元数据（key / 显示名 / 探测路径 / 配置文件 / 写入格式）。
// 具体"写什么命令"（exe 还是 node）由调用方决定，不在本文件。
//
// 用法：
//   const { CLIENTS, byKey, clientKeys } = require('../core/clients');
'use strict';
const path = require('path');

// kind 取值：
//   'json'       — 读改写一份 JSON（pointer 指定条目位置，如 '/mcpServers/tdai'）
//   'json-nested'— JSON 但条目嵌在非顶层（pointer 反推父路径），如 ZCode 的 mcp.servers.tdai、
//                  OpenClaw 的 mcp.servers.tdai
//   'toml'       — TOML 追加 [mcp_servers.tdai] 段（Codex）
//   'yaml'       — YAML 追加 mcp_servers.tdai 映射（Hermes）
//   'opencode'   — OpenCode 专有：field 'mcp'，且 command 是**数组**（不是字符串 + args）
//   'dsh-patch'  — DeepSeek Harness 用户 patch 层（cordis.patch.yml 的 insert 条目）
//
// probe：判断"该客户端是否装在本机"的路径。**不存在即跳过**，绝不替未安装的客户端造配置。
// file：真正要写的那份配置文件。
const CLIENTS = [
  {
    key: 'zcode',
    name: 'ZCode CLI',
    source: 'zcode',
    injection: { kinds: ['mcp', 'hook', 'instructions'], label: 'MCP + 提问前 hook + 全局指令', requiresRestart: true, recall: true, capture: true },
    kind: 'json-nested',
    probe: (h) => path.join(h, '.zcode'),
    file: (h) => path.join(h, '.zcode', 'cli', 'config.json'),
    // ZCode 的 MCP 条目位置：mcp.servers.tdai（不是顶层 mcpServers）
    pointer: '/mcp/servers/tdai',
    // hook 的展示名沿用历史标签（UI 文案与既有测试都按它断言，别顺手改）
    //
    // ⚠️ ZCode 的 hook 与 Claude Code **不同构**，别按 CC 的写法套（2026-09-23 踩过）：
    //   1. 位置：CC 写在用户级 ~/.claude/settings.json；
    //      ZCode 只从**工作区**读 hook —— `~/.zcode/cli/config.json` 的 hooks 段会被
    //      zod 判为 `Unrecognized key`，**整份用户配置随之作废**（plugins.enabledPlugins
    //      读不到 → 插件开关点了就弹回）。所以绝不能往用户级 config.json 写 hooks。
    //   2. 层级：CC 是 `hooks.UserPromptSubmit`；
    //      ZCode 是 `hooks.events.UserPromptSubmit`（多了 events 这一层）。
    //   3. ZCode 的 hook 需用户信任授权后执行（trustState/workspaceHookReview）。
    //
    // ZCode 3.14 的 hooks schema（从 app.asar 提取，见 test/clients-consistency.test.js）：
    //   hooks = { enabled?, timeoutMs?, maxOutputBytes?, events?: { <Event>: Matcher[] } }
    //   Matcher = { matcher?, hooks: [{ type:'command'|'process', command, ... }] }.strict()
    // 事件集：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
    //         PostToolUse / PostToolUseFailure / Stop
    //
    // scope='workspace' 表示写在**工作区**（`<项目>/.zcode/config.json`）而非用户主目录。
    // hookEventsPath 是相对工作区根的分段，供 workspaceHookFile() 拼接。
    hook: {
      scope: 'workspace',
      label: 'ZCode hook',
      eventsPath: ['.zcode', 'config.json'],
      // 工作区级配置里 hooks 的容器层级：ZCode 需要 events 中转，CC 不需要（undefined=直接挂事件名）
      eventsContainer: 'events',
      // 用户级 config.json 里**不允许**出现 hooks —— 出现即整份配置作废，需清理
      forbiddenAtUserConfig: true,
    },
  },
  {
    key: 'claude-code',
    name: 'Claude Code',
    source: 'claude-code',
    injection: { kinds: ['mcp', 'hook', 'instructions'], label: 'MCP + UserPromptSubmit hook + 全局指令', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    probe: (h) => path.join(h, '.claude.json'),
    file: (h) => path.join(h, '.claude.json'),
    pointer: '/mcpServers/tdai',
    // Claude Code 的 UserPromptSubmit hook 写在 ~/.claude/settings.json（与 MCP 配置不同文件）
    hook: { file: (h) => path.join(h, '.claude', 'settings.json'), scope: 'global', label: 'Claude Code hook' },
  },
  {
    key: 'cursor',
    name: 'Cursor',
    source: 'cursor',
    injection: { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    // Cursor 的 MCP 配置目录可能不存在（未装），用目录探测比探文件更准
    probe: (h) => path.join(h, '.cursor'),
    file: (h) => path.join(h, '.cursor', 'mcp.json'),
    pointer: '/mcpServers/tdai',
  },
  {
    key: 'codex',
    name: 'Codex',
    source: 'codex',
    injection: { kinds: ['mcp'], label: 'TOML MCP 服务器', requiresRestart: true, recall: true, capture: true },
    kind: 'toml',
    probe: (h) => path.join(h, '.codex', 'config.toml'),
    file: (h) => path.join(h, '.codex', 'config.toml'),
    // TOML 段名（写入与检测必须用同一份，别在两处各写字符串）
    tomlSection: 'mcp_servers.tdai',
  },
  {
    key: 'trae',
    name: 'Trae',
    source: 'trae',
    injection: { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    probe: (h) => path.join(h, '.trae'),
    file: (h) => path.join(h, '.trae', 'mcp.json'),
    pointer: '/mcpServers/tdai',
  },
  {
    key: 'deepseek-harness',
    name: 'DeepSeek Harness',
    source: 'deepseek-harness',
    injection: { kinds: ['mcp-patch'], label: 'Cordis patch MCP 注入', requiresRestart: true, recall: true, capture: true },
    kind: 'dsh-patch',
    probe: (h) => path.join(h, '.dsh'),
    // patch 层是按 profile 目录放的，这里返回 profiles 根目录，实际文件由调用方枚举
    file: (h) => path.join(h, '.dsh', 'profiles'),
    // 幂等标记：检查 patch 文件里是否已有该条目（写入与检测同源）
    patchMark: 'dsh-mcp-client',
  },
  // ---- 以下 6 个为 P2-1 扩充（2026-09-22）----
  // 路径与字段均按各家官方文档核对：
  //   CodeBuddy  ~/.codebuddy/.mcp.json（最高优先级；mcp.json 已废弃、.codebuddy.json 为旧版）
  //   优先级：~/.codebuddy/.mcp.json > ~/.codebuddy/mcp.json > ~/.codebuddy.json
  {
    key: 'codebuddy',
    name: 'CodeBuddy',
    source: 'codebuddy',
    injection: { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    probe: (h) => path.join(h, '.codebuddy'),
    file: (h) => path.join(h, '.codebuddy', '.mcp.json'),
    pointer: '/mcpServers/tdai',
  },
  // WorkBuddy  ~/.workbuddy-ai/mcp.json（注意不是 ~/.workbuddy —— 后者是另一个产品的目录）
  {
    key: 'workbuddy',
    name: 'WorkBuddy',
    source: 'workbuddy',
    injection: { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    probe: (h) => path.join(h, '.workbuddy-ai'),
    file: (h) => path.join(h, '.workbuddy-ai', 'mcp.json'),
    pointer: '/mcpServers/tdai',
  },
  // OpenCode  ~/.config/opencode/opencode.json：字段是 'mcp'（不是 mcpServers），
  // 且 command 必须写成**数组**（如 ["node", "/path/mcp.js"]），没有独立的 args
  {
    key: 'opencode',
    name: 'OpenCode',
    source: 'opencode',
    injection: { kinds: ['mcp'], label: 'OpenCode local MCP 命令', requiresRestart: true, recall: true, capture: true },
    kind: 'opencode',
    probe: (h) => path.join(h, '.config', 'opencode'),
    file: (h) => path.join(h, '.config', 'opencode', 'opencode.json'),
    pointer: '/mcp/tdai',
  },
  // Hermes  ~/.hermes/：MCP 配置写在**主配置 config.yaml** 的顶层 mcp_servers 映射里
  // （不是单独的 mcp.json —— 官方文档明确"不存在用户侧的独立 mcp 配置文件"）。
  // 注意别与 auxiliary.mcp 混淆：那个是"辅助模型的 MCP 工具调度 LLM 设置"，不是服务器定义。
  {
    key: 'hermes',
    name: 'Hermes',
    source: 'hermes',
    injection: { kinds: ['mcp-yaml'], label: 'YAML MCP 服务器', requiresRestart: true, recall: true, capture: true },
    kind: 'yaml',
    probe: (h) => path.join(h, '.hermes'),
    file: (h) => path.join(h, '.hermes', 'config.yaml'),
    yamlTop: 'mcp_servers',
    yamlLeaf: 'tdai',
  },
  // OpenClaw  ~/.openclaw/openclaw.json：条目在 mcp.servers 下（与 ZCode 同为嵌套形态）
  {
    key: 'openclaw',
    name: 'OpenClaw',
    source: 'openclaw',
    injection: { kinds: ['mcp'], label: '嵌套 MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json-nested',
    probe: (h) => path.join(h, '.openclaw'),
    file: (h) => path.join(h, '.openclaw', 'openclaw.json'),
    pointer: '/mcp/servers/tdai',
  },
  // Pi  ~/.pi/agent/mcp.json（Pi 自有全局覆盖层；~/.config/mcp/mcp.json 是跨主机共享文件，不改它）
  {
    key: 'pi',
    name: 'Pi',
    source: 'pi',
    injection: { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true },
    kind: 'json',
    probe: (h) => path.join(h, '.pi'),
    file: (h) => path.join(h, '.pi', 'agent', 'mcp.json'),
    pointer: '/mcpServers/tdai',
  },
];

// 全局指令文件的**唯一真源**：写入与检测必须用同一份清单。
// 早先写入集合是 ['.zcode/AGENTS.md', '.claude/CLAUDE.md']，
// 而检测集合多出一个从未被写入的 `.claude/AGENTS.md` → Claude Code 用户自带的同名文件
// 会被误判成"tdai 指令块已写入"（**假阳性**式接入状态错报）。
const INSTR_TARGETS = [['.zcode', 'AGENTS.md'], ['.claude', 'CLAUDE.md']];
const INSTR_MARK = 'tdai-memory:begin';

// 指令块正文（写入与"是否已存在"判定都以此为准）
const INSTR = [
  '',
  '<!-- tdai-memory:begin -->',
  '## 团队记忆（TD）',
  '当用户提到「之前」「上次」「我们怎么做的」「还记得」等回忆类表述时，先调用 tdai.my_agents 拿 block_id，再调用 tdai.memory_search 检索团队记忆，基于检索结果回答并标注来源；不要凭猜测回答历史问题。',
  '技能/Wiki/代码图谱检索用 tdai.skill_list / tdai.skill_get / tdai.wiki_search / tdai.codegraph_search / tdai.codegraph_explore。',
  '<!-- tdai-memory:end -->',
  '',
].join('\n');

// hook 判据（桌面端 / 网页端 / 命令行三处共用同一份，改一处即三处同时生效）
const HOOK_MARK = 'tdai-hook.cmd';
// 历史版本的 hook 写法：直接把 daemon 脚本交给 node.exe 跑（没有 .cmd 包装）。
// 它**确实在生效**，只是指向源码目录/node.exe —— 升级到 exe 版后会失效，
// 所以必须认出来并提示"切换"，而不是当成"没注入"。
const HOOK_LEGACY_MARKS = ['tdai-daemon.js', 'tdai-daemon.cjs'];

// ---- hook 配置的层级读写（唯一真源，三处共用） ----
//
// 各家 hook 的"容器层级"不一样，早先所有客户端共用同一句
// `c.hooks.UserPromptSubmit`，ZCode 3.14 因此被判为非法 key（整份用户配置作废）。
// 这里把"事件名在哪一层"收敛成两个函数，杜绝再出现"按 CC 的写法套给 ZCode"。
//
// 层级约定（容器名取自客户端清单的 hook.eventsContainer）：
//   无 container → 事件直接挂 hooks 下：hooks.UserPromptSubmit           （Claude Code）
//   有 container → 事件挂 hooks[container] 下：hooks.events.UserPromptSubmit（ZCode 3.14+）
function hookEventList(config, hook, create) {
  const c = config;
  if (!c || typeof c !== 'object') return null;
  if (!create && (!c.hooks || typeof c.hooks !== 'object')) return null;
  if (create) { c.hooks = (c.hooks && typeof c.hooks === 'object') ? c.hooks : {}; }
  const container = hook && hook.eventsContainer;
  let host = c.hooks;
  if (container) {
    if (create) { host[container] = (host[container] && typeof host[container] === 'object') ? host[container] : {}; }
    host = host[container];
    if (!host || typeof host !== 'object') return null;
  }
  const list = host.UserPromptSubmit;
  if (Array.isArray(list)) return list;
  if (!create) return null;
  host.UserPromptSubmit = [];
  return host.UserPromptSubmit;
}

// hook 该写进哪个文件：工作区级（ZCode）需由调用方给出工作区根；用户级直接用清单的 file()。
// 返回 null 表示"该客户端没有可写 hook 的目标"（未配置 hook 或缺少必要入参）。
function hookConfigFile(cls, home, workspaceRoot) {
  if (!cls || !cls.hook) return null;
  if (cls.hook.scope === 'workspace') {
    if (!workspaceRoot) return null;
    return path.join(workspaceRoot, ...(cls.hook.eventsPath || []));
  }
  return cls.hook.file ? cls.hook.file(home) : null;
}

// 用户级配置里**不该出现**的 hooks 段（出现即整份配置作废）。
// 返回被清理掉的备份路径；无风险返回 null。调用方负责日志。
function stripForbiddenUserHooks(cls, home) {
  const c = cls && cls.hook;
  if (!c || !c.forbiddenAtUserConfig) return null;
  const f = cls.file(home);
  let raw = null;
  try { raw = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch (_) { return null; }
  if (!raw || typeof raw !== 'object' || !raw.hooks) return null;
  const fsMod = require('fs');
  const bak = f + '.bak.tdai-strip-hooks.' + new Date().toISOString().replace(/[:.]/g, '-');
  try { fsMod.copyFileSync(f, bak); } catch (_) { /* 备份失败则不写，宁可不修 */ return null; }
  delete raw.hooks;
  try { fsMod.writeFileSync(f, JSON.stringify(raw, null, 2)); } catch (_) { return null; }
  return bak;
}

/** 按 key 取客户端定义 */
function byKey(key) {
  return CLIENTS.find((c) => c.key === key) || null;
}

/** 全部客户端 key（顺序与 CLIENTS 一致，测试据此断言两边不漂移） */
function clientKeys() {
  return CLIENTS.map((c) => c.key);
}

/** 按 key 取显示名（未知 key 原样返回，界面不会出现 undefined） */
function nameOf(key) {
  const c = byKey(key);
  return c ? c.name : key;
}

// 各客户端的配置文件**分段字面量**（唯一真源）。
// 为什么单独导出：daemon 因 SEA 单文件要求不能 require 本文件，只能内联一份；
// 但 `path.join(home, '.zcode', 'cli', 'config.json')` 这种分段不该在两边各写一遍
// （历史教训：写一套、查一套 → 假阳性/假阴性）。这里把它规范化成同一种声明形式，
// 供 `test/clients-consistency.test.js` 断言 core 与 daemon **逐字一致**。
// 约定：每项是「相对 home 的路径段数组」，用正斜杠书写，两端各自 join。
// 实现：拿一个哨兵根去调 probe()/file()，再剥掉哨兵那一段。
const SENTINEL = '/__tdai_home__';
const rel = (abs) => String(abs).replace(/\\/g, '/').split('/').filter((s) => s && s !== '__tdai_home__').join('/');
const CLIENT_PATHS = CLIENTS.map((c) => ({
  key: c.key,
  name: c.name,
  kind: c.kind,
  probe: rel(c.probe(SENTINEL)),
  file: rel(c.file(SENTINEL)),
}));

module.exports = {
  CLIENTS, CLIENT_PATHS, INSTR, INSTR_MARK, INSTR_TARGETS, HOOK_MARK, HOOK_LEGACY_MARKS,
  byKey, clientKeys, nameOf,
  hookEventList, hookConfigFile, stripForbiddenUserHooks,
};