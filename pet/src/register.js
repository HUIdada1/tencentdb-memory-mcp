// register.js — Agent 接入：状态检测 + 一键注册（MCP / Claude Code hook / 全局指令文件）
// 纯 Node（不依赖 electron），可脱离应用单测；与源码版 register-all.cjs 的差异：
// 注册目标一律指向**已安装的应用 exe**（ELECTRON_RUN_AS_NODE 以 node 模式跑打包内的 js），
// 不依赖用户机器上的 node 与源码目录——这是 exe 用户唯一可行的接入路径。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 客户端清单与指令文件清单来自 core/clients.js（**唯一真源**）。
// 桌面端与源码版 register-all.cjs 共用同一份，杜绝"一边加了客户端、另一边没加"的漂移。
// 这里只覆盖"注册目标"——桌面端一律指向应用 exe（ELECTRON_RUN_AS_NODE 跑打包内的 js），
// 不依赖用户机器上的 node 与源码目录，这是 exe 用户唯一可行的接入路径。
const {
  CLIENTS, INSTR, INSTR_MARK, INSTR_TARGETS, HOOK_MARK, HOOK_LEGACY_MARKS,
} = require(path.join(__dirname, '..', '..', 'core', 'clients.js'));

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

/* ---------- UserPromptSubmit hook 检测（桌面端与网页端共用同一口径） ----------
 * 返回 { present, legacy }：
 *   present=true 表示配置里确实挂了一个本工具的 hook（新旧写法都算）
 *   legacy=true  表示是旧写法（tdai-daemon.js + node.exe），建议关→开切到本应用
 * 抽成导出函数的原因：daemon 的 /api/agents-status 也要报 hook 状态，
 * 早先两处各写一套判据（一处查 'tdai-hook.cmd'、一处查 'tdai-daemon'），
 * 同一台机器上桌面端说"未注入"、网页端说"已注入"，用户完全无法判断该信谁。
 */
// hook 配置文件位置：来自清单的 cls.hook.file（唯一真源）。
// 早先这个映射在本文件里被硬编码了 4 遍（hookState / register / registerOne / unregister），
// 任何一处漏改都会造成"写这里、查那里"的不一致。现在全部走 hookTargets()。
function hookTargets(home) {
  return CLIENTS
    .filter((c) => c.hook)
    .map((c) => ({ key: c.key, name: c.hook.label || `${c.name} hook`, file: c.hook.file(home), cls: c }));
}

function hookState(home, which) {
  const t = hookTargets(home).find((x) => x.key === which);
  if (!t) return { present: false, legacy: false };
  const s = readJson(t.file);
  const arr = (s && s.hooks && s.hooks.UserPromptSubmit) || [];
  const text = JSON.stringify(arr);
  const present = text.includes(HOOK_MARK) || HOOK_LEGACY_MARKS.some((m) => text.includes(m));
  const legacy = present && !text.includes(HOOK_MARK);
  return { present, legacy };
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

// YAML 标量的双引号转义：Windows 路径必须加引号，否则 `C:\Users` 的 `\U` 会被当转义序列
function yamlQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// OpenCode 的 stdio 条目是**独立方言**：type='local'，且 command 是数组（自带参数）。
// 与通用 mcpEntry 不能混用 —— 写错形态 OpenCode 会直接不认这个服务器。
function opencodeEntry({ exePath, mcpJs }) {
  return { type: 'local', command: [exePath, mcpJs], enabled: true };
}

// Hermes 的 mcp_servers 是 YAML 映射。这里做**块定位写入**而不是全量解析，
// 因为本项目硬约束是零 npm 依赖（不能引 js-yaml）。
// 返回 [action, detail] 供调用方 rec() 使用；写入与 entryOf 的检测标记必须一致。
// 注意：Hermes 的 MCP 配置在**主配置 config.yaml** 里，文件可能尚不存在
// （用户装了 Hermes 但还没跑过）—— 此时新建，而不是跳过。
//
// ⚠️ 必须**插到 mcp_servers 块内部**，不能简单追加到文件末尾：
// config.yaml 是用户的整个主配置（model / tts / auxiliary ... 都在里面），
// 末尾追加一个缩进 2 空格的 `  tdai:` 会被 YAML 解析成**最后一个顶层键**的子键
// （实测会挂到 `tts.tdai` 下）→ MCP 服务器根本读不到，且静默无报错。
function yamlRegister(file, cls, { exePath, mcpJs }) {
  const text = readText(file) || '';
  const top = cls.yamlTop || 'mcp_servers';
  const leaf = cls.yamlLeaf || 'tdai';
  const body = `  ${leaf}:\n    command: ${yamlQuote(exePath)}\n    args:\n      - ${yamlQuote(mcpJs)}\n`;
  ensureDir(path.dirname(file));
  if (!text.trim()) { fs.writeFileSync(file, `${top}:\n${body}`); return ['新建', `${top}.${leaf}`]; }
  if (new RegExp('^\\s{2}' + leaf + ':', 'm').test(text)) return ['跳过', `已存在 ${top}.${leaf}`];
  // 顶层 mcp_servers 已存在 → 插到该块末尾（下一个顶层键之前），而不是文件末尾
  const lines = text.split('\n');
  let topAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^' + top + ':').test(lines[i])) { topAt = i; break; }
  }
  backup(file);
  if (topAt >= 0) {
    // 找该块结束：下一个非空且缩进 0 的键
    let end = lines.length;
    for (let i = topAt + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) { end = i; break; }
    }
    // 去掉块尾多余空行，再插入新子键
    let ins = end;
    while (ins > topAt + 1 && !lines[ins - 1].trim()) ins--;
    lines.splice(ins, 0, ...body.replace(/\n$/, '').split('\n'));
    fs.writeFileSync(file, lines.join('\n'));
    return ['追加', `${top}.${leaf}`];
  }
  // 没有顶层 mcp_servers → 在文件末尾新开一个顶层键
  fs.appendFileSync(file, (/\n$/.test(text) ? '' : '\n') + `\n${top}:\n${body}`);
  return ['追加', `${top}.${leaf}`];
}

// 从 YAML 文本里移除 tdai 子块（块定位，零依赖）。
// 与写入侧的标记同源：从 `  tdai:` 起，到下一个**同级（缩进 ≤2）键**或文件末尾为止。
// ⚠️ 早先写成「遇到缩进 0 才结束」是错的 —— 主配置里 `tts:` 这类缩进 0 的顶层键
// 之后的内容会被一并吞掉。同级判定必须用"缩进 ≤ 本块缩进"。
function yamlUnregister(file, cls) {
  const text = readText(file);
  if (text == null) return false;
  const top = cls.yamlTop || 'mcp_servers';
  const leaf = cls.yamlLeaf || 'tdai';
  const lines = text.split('\n');
  const out = [];
  let inBlock = false;
  let hit = false;
  let leafIndent = 2;
  for (const l of lines) {
    if (!inBlock && new RegExp('^\\s{2}' + leaf + ':').test(l)) {
      inBlock = true; hit = true; leafIndent = l.match(/^\s*/)[0].length; continue;
    }
    if (inBlock) {
      // 同级或更浅的键 → 本块结束，该行属于其他配置，保留
      const ind = l.trim() ? l.match(/^\s*/)[0].length : Infinity;
      if (ind <= leafIndent) { inBlock = false; out.push(l); continue; }
      continue;   // 块内更深缩进的行（command/args/...）一并删掉
    }
    out.push(l);
  }
  if (!hit) return false;
  backup(file);
  let next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]*$/, '\n');
  // 顶层键若已空（mcp_servers: 之后没有任何子项）则一并清掉，避免留下空映射
  const topEmpty = new RegExp('^' + top + ':[ \\t]*\\n(?=[ \\t]*(?:\\n|$))', 'm');
  if (topEmpty.test(next)) next = next.replace(topEmpty, '');
  fs.writeFileSync(file, next);
  return true;
}

// DeepSeek Harness 的用户 patch 层（~/.dsh/profiles/<profile>/cordis.patch.yml）：
// 官方方言是 PatchOptions { insert: EntryOptions[] }，往配置树追加 MCP 客户端条目
function dshPatchBlock({ exePath, mcpJs }) {
  // YAML 单引号串里反斜杠不是转义符（Windows 路径原样写），只有单引号要双写
  const y = (s) => String(s).replace(/'/g, "''");
  return [
    '',
    '# tdai-memory:begin （TD 记忆 MCP，由 TD记忆守护 一键接入写入）',
    '- insert:',
    "    - resolve: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: tdai-memory',
    `        command: '${y(exePath)}'`,
    '        args:',
    `          - '${y(mcpJs)}'`,
    '        env:',
    "          ELECTRON_RUN_AS_NODE: '1'",
    '',
  ].join('\n');
}

/* ---------- 状态检测 ---------- */

// 按 pointer 取值（'/mcp/servers/tdai' 或 '/mcpServers/tdai' 通吃）。
// 读写两侧共用同一套推导，杜绝"写这里、查那里"。
function readPointer(obj, pointer) {
  const parts = String(pointer || '/mcpServers/tdai').split('/').filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[p]; }
  return cur && typeof cur === 'object' ? cur : undefined;
}

function entryOf(cls, home) {
  const file = cls.file(home);
  if (cls.kind === 'toml') {
    const t = readText(file);
    if (t == null) return null;
    // 段名来自 cls.tomlSection（与写入侧同源），别在这里另写一份字符串
    const sec = (cls.tomlSection || 'mcp_servers.tdai').replace(/[.[\]]/g, '\\$&');
    const m = t.match(new RegExp('\\[' + sec + '\\]([\\s\\S]*?)(?=\\n\\[|$)'));
    if (!m) return null;
    const cmd = (m[1].match(/command\s*=\s*"([^"]+)"/) || [])[1];
    return { command: cmd };
  }
  if (cls.kind === 'dsh-patch') {
    let profiles = [];
    try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { return null; }
    const mark = cls.patchMark || 'dsh-mcp-client';
    for (const p of profiles) {
      const t = readText(path.join(file, p, 'cordis.patch.yml'));
      if (t && t.includes(mark)) {
        const m = t.match(/\n\s*command:\s*'([^']+)'/);
        return { command: m ? m[1].replace(/''/g, "'") : 'cordis.patch.yml' };
      }
    }
    return null;
  }
  if (cls.kind === 'opencode') {
    const c = readJson(file);
    if (c == null) return null;
    const e = readPointer(c, cls.pointer);
    // OpenCode 的 command 是数组，取首元素当"由谁接入"的判据
    if (!e || !Array.isArray(e.command)) return null;
    return { command: e.command[0] };
  }
  if (cls.kind === 'yaml') {
    // 块定位检测：与写入侧同源的标记（`  tdai:` 两空格缩进）
    const t = readText(file);
    if (t == null) return null;
    const top = cls.yamlTop || 'mcp_servers';
    const leaf = cls.yamlLeaf || 'tdai';
    if (!new RegExp('^\\s{2}' + leaf + ':', 'm').test(t)) return null;
    // 取 command 行（引号包裹）作为"由谁接入"的判据
    const m2 = t.match(new RegExp('^\\s{2}' + leaf + ':[\\s\\S]*?^\\s+command:\\s*"?([^"\\n]+)"?', 'm'));
    return { command: m2 ? m2[1].replace(/\\(.)/g, '$1') : '' };
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
    // byApp=true 表示由本应用接入（exe 路径一致）；否则是旧版/源码版 node 接入，
    // 需要在界面提示"建议切换到本应用接入"，否则升级后旧路径可能失效。
    const byApp = entry ? (cls.kind === 'dsh-patch' ? false : samePath(entry.command, exePath)) : false;
    const detail = entry
      ? (cls.kind === 'dsh-patch' ? '已写入 cordis.patch'
        : byApp ? '本应用接入' : `由 ${path.basename(entry.command || '')} 接入（旧路径，建议点开关重连）`)
      : '';
    const injection = cls.injection || { kinds: ['mcp'], label: 'MCP 配置', requiresRestart: true, recall: true, capture: true };
    const item = {
      key: cls.key,
      name: cls.name,
      status: !installed ? 'absent' : (entry ? 'installed' : 'missing'),
      detail,
      byApp,
      source: cls.source || cls.key,
      config: {
        kind: cls.kind,
        file: cls.file(home),
        pointer: cls.pointer || cls.tomlSection || (cls.yamlTop && `${cls.yamlTop}.${cls.yamlLeaf || 'tdai'}`) || (cls.kind === 'dsh-patch' ? 'profiles/*/cordis.patch.yml :: insert' : ''),
      },
      injection: {
        kinds: Array.isArray(injection.kinds) ? injection.kinds.slice() : [],
        label: injection.label || 'MCP 配置',
        requiresRestart: injection.requiresRestart !== false,
        recall: injection.recall !== false,
        capture: injection.capture !== false,
      },
      checks: { mcp: !!entry, byApp, hook: null, instructions: null },
    };
    items.push(item);
  }

  // UserPromptSubmit hook（Claude Code 与 ZCode）
  const hookOf = (which) => hookState(home, which);
  const hookDetail = (st, isAbsent) => {
    if (st.present) return st.legacy ? 'hook 已注入（旧写法，建议关→开切换）' : 'hook 已注入';
    return isAbsent ? '' : 'hook 未注入';
  };
  const cc = items.find((x) => x.key === 'claude-code');
  if (cc) {
    const hs = hookOf('claude-code');
    cc.checks.hook = hs.present;
    cc.detail = [cc.detail, hookDetail(hs, cc.status === 'absent')].filter(Boolean).join(' · ');
  }
  const zc = items.find((x) => x.key === 'zcode');
  if (zc) {
    const hs = hookOf('zcode');
    zc.checks.hook = hs.present;
    zc.detail = [zc.detail, hookDetail(hs, zc.status === 'absent')].filter(Boolean).join(' · ');
  }

  // 全局指令文件（MCP 没生效时的兜底硬规则）
  // 与 register() 的写入清单同源（INSTR_TARGETS），避免"检测面"与"写入面"不一致。
  const instrFiles = INSTR_TARGETS.map(([d, n]) => path.join(home, d, n));
  const instrHit = instrFiles.filter((f) => (readText(f) || '').includes(INSTR_MARK));
  const instructionItem = {
    key: 'instructions',
    name: '全局指令文件',
    status: instrHit.length ? 'installed' : 'missing',
    detail: instrHit.length ? `${instrHit.map((f) => path.basename(f)).join(' / ')} 已写入` : '兜底规则未写入',
    source: 'instructions',
    config: { kind: 'markdown', file: instrFiles.join('、'), pointer: 'tdai-memory:begin' },
    injection: { kinds: ['instructions'], label: '全局指令文件（兜底）', requiresRestart: false, recall: true, capture: false },
    checks: { mcp: false, byApp: true, hook: null, instructions: instrHit.length > 0 },
  };
  items.push(instructionItem);

  for (const item of items) {
    if (!item.checks) continue;
    if (item.key !== 'instructions' && item.injection && item.injection.kinds.includes('instructions')) {
      const target = item.key === 'zcode'
        ? path.join(home, '.zcode', 'AGENTS.md')
        : path.join(home, '.claude', 'CLAUDE.md');
      item.checks.instructions = (readText(target) || '').includes(INSTR_MARK);
    }
    const required = item.injection && item.injection.kinds || [];
    const hookReady = !required.includes('hook') || item.checks.hook === true;
    const mcpReady = !required.includes('mcp') && !required.some((k) => k === 'mcp-patch' || k === 'mcp-yaml')
      ? true : item.checks.mcp === true && item.checks.byApp !== false;
    const instructionReady = !required.includes('instructions') || item.checks.instructions !== false;
    item.effective = item.status === 'installed' && mcpReady && hookReady && instructionReady;
    if (item.status === 'installed' && !item.effective && item.detail) item.detail += ' · 注入未完全生效';
  }

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
        // 段名来自清单（cls.tomlSection），写入与检测共用一份，别在两处各写字符串
        const sec = cls.tomlSection || 'mcp_servers.tdai';
        const text = readText(file) || '';
        if (text.includes(`[${sec}]`)) { rec(cls.name, '跳过', `已注册 [${sec}]`); continue; }
        const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        backup(file);
        fs.appendFileSync(file, `\n[${sec}]\ncommand = "${esc(exePath)}"\nargs = ["${esc(mcpJs)}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`);
        rec(cls.name, '追加', `[${sec}]`);
      } else if (cls.kind === 'dsh-patch') {
        let profiles = [];
        try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
        const mark = cls.patchMark || 'dsh-mcp-client';
        let wrote = 0, skipped = 0;
        for (const p of profiles) {
          const f = path.join(file, p, 'cordis.patch.yml');
          if (!exists(f)) continue; // profile 未初始化（无 patch 文件）不动
          const text = readText(f) || '';
          if (text.includes(mark)) { skipped++; continue; }
          backup(f);
          // 模板占位（仅注释或空数组 []）不能直接追加（[] 后跟条目是非法 YAML）：保留注释行、整体重写
          const body = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trim();
          if (body === '' || body === '[]') {
            const header = text.split('\n').filter((l) => l.trim().startsWith('#')).join('\n');
            fs.writeFileSync(f, (header ? header + '\n' : '') + dshPatchBlock({ exePath, mcpJs }).replace(/^\n+/, ''));
          } else {
            fs.writeFileSync(f, text.replace(/\s*$/, '') + '\n' + dshPatchBlock({ exePath, mcpJs }));
          }
          wrote++;
        }
        if (wrote) rec(cls.name, '追加', `${wrote} 个 profile 写入 insert 条目`);
        else if (skipped) rec(cls.name, '跳过', 'patch 已存在');
        else rec(cls.name, '跳过', '~/.dsh/profiles 下无 cordis.patch.yml');
      } else if (cls.kind === 'opencode') {
        const c = readJson(file) || {};
        const entry = opencodeEntry({ exePath, mcpJs });
        const parts = String(cls.pointer || '/mcp/tdai').split('/').filter(Boolean);
        const leaf = parts.pop();
        let parent = c;
        for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
        const prev = parent[leaf];
        if (prev && JSON.stringify(prev) === JSON.stringify(entry)) { rec(cls.name, '跳过', '已是本应用接入'); continue; }
        parent[leaf] = entry;
        backup(file); writeJson(file, c);
        rec(cls.name, prev ? '覆盖' : '新增', prev ? '更新为当前程序路径' : cls.pointer);
      } else if (cls.kind === 'yaml') {
        rec(cls.name, ...yamlRegister(file, cls, { exePath, mcpJs }));
      } else {
        const c = readJson(file) || {};
        const next = mcpEntry({ exePath, mcpJs });
        // 条目位置由清单的 pointer 决定（'/mcp/servers/tdai' 或 '/mcpServers/tdai'），
        // 不再用字符串比较硬编 ZCode 特例 —— 父路径按 pointer 反推即可通用。
        const parts = String(cls.pointer || '/mcpServers/tdai').split('/').filter(Boolean);
        const leaf = parts.pop();
        let parent = c;
        for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
        const prev = parent[leaf];
        // 完全一致就不重写、不备份（真正幂等）
        if (prev && JSON.stringify(prev) === JSON.stringify(next)) { rec(cls.name, '跳过', '已是本应用接入'); continue; }
        parent[leaf] = next;
        backup(file); writeJson(file, c);
        rec(cls.name, prev ? '覆盖' : '新增', prev ? '更新为当前程序路径' : cls.pointer);
      }
    } catch (e) { rec(cls.name, '失败', e.message); }
  }

  // 2. UserPromptSubmit hook（提问前自动注入记忆，不依赖模型主动调用）：Claude Code 与 ZCode
  try {
    for (const t of hookTargets(home)) {
      const dir = t.cls.probe(home);
      if (!exists(dir)) { rec(t.name, '跳过', '未安装该客户端'); continue; }
      const cmdFile = hookCmdPath(home);
      ensureDir(path.dirname(cmdFile));
      fs.writeFileSync(cmdFile, hookScript({ exePath, daemonJs }));
      const c = readJson(t.file) || {};
      c.hooks = c.hooks || {};
      c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit || [];
      if (JSON.stringify(c.hooks.UserPromptSubmit).includes(HOOK_MARK)) {
        rec(t.name, '跳过', 'hook 已存在（脚本已更新）');
      } else {
        c.hooks.UserPromptSubmit.push({ matcher: '*', hooks: [{ type: 'command', command: `"${cmdFile}"` }] });
        backup(t.file); writeJson(t.file, c);
        rec(t.name, '新增', 'UserPromptSubmit → 本应用');
      }
    }
  } catch (e) { rec('UserPromptSubmit hook', '失败', e.message); }

  // 3. 全局指令文件（档 B 兜底：告诉模型何时调 tdai 工具）
  // 清单来自 INSTR_TARGETS（与 status() 检测同源），别再在这里另写一份字面量。
  for (const rel of INSTR_TARGETS) {
    const dir = path.join(home, rel[0]);
    const f = path.join(dir, rel[1]);
    if (!exists(dir)) { rec(rel[1], '跳过', `无 ${rel[0]} 目录（未安装对应客户端）`); continue; }
    try {
      const text = readText(f) || '';
      if (text.includes(INSTR_MARK)) { rec(rel[1], '跳过', '指令块已存在'); continue; }
      backup(f);
      ensureDir(dir);
      fs.appendFileSync(f, INSTR);
      rec(rel[1], '追加', '团队记忆指令块');
    } catch (e) { rec(rel[1], '失败', e.message); }
  }

  return results;
}

/* ---------- 单个客户端的接入 / 断开（手动开关用） ---------- */

// 把某客户端的 MCP 注册流程单独抽出，给"接入单个"开关复用（与 register 内对应分支口径一致）
function registerOne(cls, { home, exePath, mcpJs, daemonJs }, results) {
  const file = cls.file(home);
  if (!exists(cls.probe(home))) { results.push({ target: cls.name, action: '跳过', detail: '未安装该客户端' }); return; }
  try {
    if (cls.kind === 'toml') {
      const sec = cls.tomlSection || 'mcp_servers.tdai';
      const text = readText(file) || '';
      if (text.includes(`[${sec}]`)) { results.push({ target: cls.name, action: '跳过', detail: `已注册 [${sec}]` }); return; }
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      backup(file);
      fs.appendFileSync(file, `\n[${sec}]\ncommand = "${esc(exePath)}"\nargs = ["${esc(mcpJs)}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`);
      results.push({ target: cls.name, action: '追加', detail: `[${sec}]` });
    } else if (cls.kind === 'dsh-patch') {
      let profiles = [];
      try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
      const mark = cls.patchMark || 'dsh-mcp-client';
      let wrote = 0, skipped = 0;
      for (const p of profiles) {
        const f = path.join(file, p, 'cordis.patch.yml');
        if (!exists(f)) continue;
        const text = readText(f) || '';
        if (text.includes(mark)) { skipped++; continue; }
        backup(f);
        const body = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trim();
        if (body === '' || body === '[]') {
          const header = text.split('\n').filter((l) => l.trim().startsWith('#')).join('\n');
          fs.writeFileSync(f, (header ? header + '\n' : '') + dshPatchBlock({ exePath, mcpJs }).replace(/^\n+/, ''));
        } else {
          fs.writeFileSync(f, text.replace(/\s*$/, '') + '\n' + dshPatchBlock({ exePath, mcpJs }));
        }
        wrote++;
      }
      if (wrote) results.push({ target: cls.name, action: '追加', detail: `${wrote} 个 profile 写入 insert 条目` });
      else if (skipped) results.push({ target: cls.name, action: '跳过', detail: 'patch 已存在' });
      else results.push({ target: cls.name, action: '跳过', detail: '~/.dsh/profiles 下无 cordis.patch.yml' });
    } else if (cls.kind === 'opencode') {
      const c = readJson(file) || {};
      const entry = opencodeEntry({ exePath, mcpJs });
      const parts = String(cls.pointer || '/mcp/tdai').split('/').filter(Boolean);
      const leaf = parts.pop();
      let parent = c;
      for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
      const prev = parent[leaf];
      if (prev && JSON.stringify(prev) === JSON.stringify(entry)) { results.push({ target: cls.name, action: '跳过', detail: '已是本应用接入' }); return; }
      parent[leaf] = entry;
      backup(file); writeJson(file, c);
      results.push({ target: cls.name, action: prev ? '覆盖' : '新增', detail: prev ? '更新为当前程序路径' : cls.pointer });
    } else if (cls.kind === 'yaml') {
      const [action, detail] = yamlRegister(file, cls, { exePath, mcpJs });
      results.push({ target: cls.name, action, detail });
    } else {
      const c = readJson(file) || {};
      const next = mcpEntry({ exePath, mcpJs });
      // 与 register 主流程同一套 pointer 推导（单一实现，避免两处口径漂移）
      const parts = String(cls.pointer || '/mcpServers/tdai').split('/').filter(Boolean);
      const leaf = parts.pop();
      let parent = c;
      for (const p of parts) { if (!parent[p] || typeof parent[p] !== 'object') parent[p] = {}; parent = parent[p]; }
      const prev = parent[leaf];
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) { results.push({ target: cls.name, action: '跳过', detail: '已是本应用接入' }); return; }
      parent[leaf] = next;
      backup(file); writeJson(file, c);
      results.push({ target: cls.name, action: prev ? '覆盖' : '新增', detail: prev ? '更新为当前程序路径' : cls.pointer });
    }
  } catch (e) { results.push({ target: cls.name, action: '失败', detail: e.message }); }
}

// 接入单个客户端（用户手动开启）：等于 register 的对应子集，返回 results
function registerOneClient(key, opts) {
  const cls = CLIENTS.find((x) => x.key === key);
  if (!cls) throw new Error('未知客户端: ' + key);
  const results = [];
  registerOne(cls, { home: opts.home, exePath: opts.exePath, mcpJs: opts.mcpJs, daemonJs: opts.daemonJs }, results);
  // Claude Code / ZCode 同时补 hook（开关语义：开启即完整接入）
  // 是否"有 hook"由清单决定（cls.hook 存在与否），不再硬编码 key 白名单
  if (cls.hook) {
    try {
      const home = opts.home;
      const t = hookTargets(home).find((x) => x.key === key);
      if (t && exists(t.cls.probe(home))) {
        const cmdFile = hookCmdPath(home);
        ensureDir(path.dirname(cmdFile));
        fs.writeFileSync(cmdFile, hookScript({ exePath: opts.exePath, daemonJs: opts.daemonJs }));
        const c = readJson(t.file) || {};
        c.hooks = c.hooks || {};
        c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit || [];
        if (JSON.stringify(c.hooks.UserPromptSubmit).includes(HOOK_MARK)) {
          results.push({ target: t.name, action: '跳过', detail: 'hook 已存在（脚本已更新）' });
        } else {
          c.hooks.UserPromptSubmit.push({ matcher: '*', hooks: [{ type: 'command', command: `"${cmdFile}"` }] });
          backup(t.file); writeJson(t.file, c);
          results.push({ target: t.name, action: '新增', detail: 'UserPromptSubmit → 本应用' });
        }
      }
    } catch (e) { results.push({ target: key + ' hook', action: '失败', detail: e.message }); }
  }
  return results;
}

// 断开单个客户端（用户手动关闭）：删除其 MCP 条目 + hook（若有）
function unregisterOneClient(key, { home = os.homedir() } = {}) {
  const cls = CLIENTS.find((x) => x.key === key);
  if (!cls) throw new Error('未知客户端: ' + key);
  const results = [];
  const file = cls.file(home);
  try {
    if (cls.kind === 'toml') {
      const sec = cls.tomlSection || 'mcp_servers.tdai';
      const esc2 = sec.replace(/[.[\]]/g, '\\$&');
      const text = readText(file) || '';
      const m = text.match(new RegExp('\\n?\\[' + esc2 + '\\][\\s\\S]*?(?=\\n\\[|$)'));
      if (m) { backup(file); fs.writeFileSync(file, text.replace(m[0], '\n')); results.push({ target: cls.name, action: '移除', detail: `[${sec}]` }); }
      else results.push({ target: cls.name, action: '跳过', detail: '无 tdai 条目' });
    } else if (cls.kind === 'dsh-patch') {
      let profiles = [];
      try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
      const mark = cls.patchMark || 'dsh-mcp-client';
      let removed = 0;
      for (const p of profiles) {
        const f = path.join(file, p, 'cordis.patch.yml');
        const text = readText(f) || '';
        if (!text.includes(mark)) continue;
        backup(f);
        // 精确移除 tdai-memory 注入块。
        // 早先按"命中区间内任何 - 开头的行都跳过"过滤，会连带吞掉用户在
        // 本块之后写的其它 insert 条目（那些条目也是 `- insert:` / `- resolve:` 开头）。
        // 现在改为**结构化定位**：从 `# tdai-memory:begin` 注释行开始，到本块
        // 自身的 `ELECTRON_RUN_AS_NODE` 行为止（那是注入块的最后一行），
        // 整段删掉；块外内容一行不动。
        const lines = text.split('\n');
        const out = [];
        let inBlock = false;
        let sawBegin = false;
        for (const l of lines) {
          const trimmed = l.trim();
          if (!inBlock && /tdai-memory:begin/.test(l)) { inBlock = true; sawBegin = true; continue; }
          if (inBlock) {
            // 注入块以 env 那行收尾（见 dshPatchBlock）：命中即结束本块
            if (/ELECTRON_RUN_AS_NODE/.test(l)) { inBlock = false; continue; }
            // 防御：块内若出现下一段注释分节，说明结构已被人工改动，就此收尾避免误删
            if (/^#/.test(trimmed) && !/tdai-memory/.test(l)) { inBlock = false; out.push(l); continue; }
            continue;   // 块内其它行（insert/resolve/config/transport/serverName/command/args/env/空行）一并删除
          }
          out.push(l);
        }
        if (!sawBegin) continue;
        fs.writeFileSync(f, out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'));
        removed++;
      }
      results.push({ target: cls.name, action: removed ? '移除' : '跳过', detail: removed ? `${removed} 个 profile 移除 insert 条目` : '无 tdai 条目' });
    } else if (cls.kind === 'opencode') {
      const c = readJson(file);
      if (!c) { results.push({ target: cls.name, action: '跳过', detail: '配置文件不存在' }); return results; }
      const parts = String(cls.pointer || '/mcp/tdai').split('/').filter(Boolean);
      const leaf = parts.pop();
      let parent = c;
      for (const p of parts) { if (!parent || typeof parent !== 'object') { parent = null; break; } parent = parent[p]; }
      if (!parent || !parent[leaf]) { results.push({ target: cls.name, action: '跳过', detail: '无 tdai 条目' }); return results; }
      delete parent[leaf];
      backup(file); writeJson(file, c);
      results.push({ target: cls.name, action: '移除', detail: cls.pointer });
    } else if (cls.kind === 'yaml') {
      const okDel = yamlUnregister(file, cls);
      results.push({ target: cls.name, action: okDel ? '移除' : '跳过', detail: okDel ? `${cls.yamlTop}.${cls.yamlLeaf}` : '无 tdai 条目' });
    } else {
      const c = readJson(file);
      if (!c) { results.push({ target: cls.name, action: '跳过', detail: '配置文件不存在' }); return results; }
      // pointer 推导与 register/registerOne 完全同一套（改这里即三处同步）
      const parts = String(cls.pointer || '/mcpServers/tdai').split('/').filter(Boolean);
      const leaf = parts.pop();
      let parent = c;
      for (const p of parts) { if (!parent || typeof parent !== 'object') { parent = null; break; } parent = parent[p]; }
      if (!parent || !parent[leaf]) { results.push({ target: cls.name, action: '跳过', detail: '无 tdai 条目' }); return results; }
      delete parent[leaf];
      backup(file); writeJson(file, c);
      results.push({ target: cls.name, action: '移除', detail: cls.pointer });
    }
  } catch (e) { results.push({ target: cls.name, action: '失败', detail: e.message }); }
  // 同步移除该客户端的 hook（有 hook 配置的客户端才做，判据来自清单）
  if (cls.hook) {
    try {
      const t = hookTargets(home).find((x) => x.key === key);
      const f = t ? t.file : null;
      const c = f ? readJson(f) : null;
      if (c && c.hooks && Array.isArray(c.hooks.UserPromptSubmit)) {
        const before = c.hooks.UserPromptSubmit.length;
        // 两种写法都要清：新写法（HOOK_MARK）与旧写法（legacy 标记）
        const hit = (x) => {
          const s = JSON.stringify(x);
          return s.includes(HOOK_MARK) || HOOK_LEGACY_MARKS.some((m) => s.includes(m));
        };
        c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit.filter((x) => !hit(x));
        if (c.hooks.UserPromptSubmit.length !== before) { backup(f); writeJson(f, c); results.push({ target: key + ' hook', action: '移除', detail: 'UserPromptSubmit' }); }
        else results.push({ target: key + ' hook', action: '跳过', detail: '无 tdai hook' });
      }
    } catch (e) { results.push({ target: key + ' hook', action: '失败', detail: e.message }); }
  }
  return results;
}

module.exports = { status, register, registerOneClient, unregisterOneClient, mcpEntry, hookScript, hookCmdPath, dshPatchBlock, hookState, INSTR, INSTR_TARGETS, INSTR_MARK, CLIENTS, HOOK_MARK, HOOK_LEGACY_MARKS };
