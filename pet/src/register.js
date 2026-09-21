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
  { key: 'trae', name: 'Trae', probe: (h) => path.join(h, '.trae'), kind: 'json', file: (h) => path.join(h, '.trae', 'mcp.json'), pointer: '/mcpServers/tdai' },
  { key: 'deepseek-harness', name: 'DeepSeek Harness', probe: (h) => path.join(h, '.dsh'), kind: 'dsh-patch', file: (h) => path.join(h, '.dsh', 'profiles') },
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
  if (cls.kind === 'dsh-patch') {
    let profiles = [];
    try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { return null; }
    for (const p of profiles) {
      const t = readText(path.join(file, p, 'cordis.patch.yml'));
      if (t && t.includes('dsh-mcp-client')) return { command: 'cordis.patch.yml' };
    }
    return null;
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
    items.push({
      key: cls.key,
      name: cls.name,
      status: !installed ? 'absent' : (entry ? 'installed' : 'missing'),
      detail,
      byApp,
    });
  }

  // UserPromptSubmit hook（Claude Code 与 ZCode）
  const hookOf = (file) => {
    const s = readJson(file);
    return !!(s && JSON.stringify(s.hooks && s.hooks.UserPromptSubmit || []).includes(HOOK_MARK));
  };
  const cc = items.find((x) => x.key === 'claude-code');
  if (cc) {
    const hasHook = hookOf(path.join(home, '.claude', 'settings.json'));
    cc.detail = [cc.detail, hasHook ? 'hook 已注入' : (cc.status === 'absent' ? '' : 'hook 未注入')].filter(Boolean).join(' · ');
  }
  const zc = items.find((x) => x.key === 'zcode');
  if (zc) {
    const hasHook = hookOf(path.join(home, '.zcode', 'cli', 'config.json'));
    zc.detail = [zc.detail, hasHook ? 'hook 已注入' : (zc.status === 'absent' ? '' : 'hook 未注入')].filter(Boolean).join(' · ');
  }

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
      } else if (cls.kind === 'dsh-patch') {
        let profiles = [];
        try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
        let wrote = 0, skipped = 0;
        for (const p of profiles) {
          const f = path.join(file, p, 'cordis.patch.yml');
          if (!exists(f)) continue; // profile 未初始化（无 patch 文件）不动
          const text = readText(f) || '';
          if (text.includes('dsh-mcp-client')) { skipped++; continue; }
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

  // 2. UserPromptSubmit hook（提问前自动注入记忆，不依赖模型主动调用）：Claude Code 与 ZCode
  try {
    const hookTargets = [
      { name: 'Claude Code hook', homeDir: path.join(home, '.claude'), file: path.join(home, '.claude', 'settings.json') },
      { name: 'ZCode hook', homeDir: path.join(home, '.zcode'), file: path.join(home, '.zcode', 'cli', 'config.json') },
    ];
    for (const t of hookTargets) {
      if (!exists(t.homeDir)) { rec(t.name, '跳过', '未安装该客户端'); continue; }
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

/* ---------- 单个客户端的接入 / 断开（手动开关用） ---------- */

// 把某客户端的 MCP 注册流程单独抽出，给"接入单个"开关复用（与 register 内对应分支口径一致）
function registerOne(cls, { home, exePath, mcpJs, daemonJs }, results) {
  const file = cls.file(home);
  if (!exists(cls.probe(home))) { results.push({ target: cls.name, action: '跳过', detail: '未安装该客户端' }); return; }
  try {
    if (cls.kind === 'toml') {
      const text = readText(file) || '';
      if (text.includes('[mcp_servers.tdai]')) { results.push({ target: cls.name, action: '跳过', detail: '已注册 [mcp_servers.tdai]' }); return; }
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      backup(file);
      fs.appendFileSync(file, `\n[mcp_servers.tdai]\ncommand = "${esc(exePath)}"\nargs = ["${esc(mcpJs)}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`);
      results.push({ target: cls.name, action: '追加', detail: '[mcp_servers.tdai]' });
    } else if (cls.kind === 'dsh-patch') {
      let profiles = [];
      try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
      let wrote = 0, skipped = 0;
      for (const p of profiles) {
        const f = path.join(file, p, 'cordis.patch.yml');
        if (!exists(f)) continue;
        const text = readText(f) || '';
        if (text.includes('dsh-mcp-client')) { skipped++; continue; }
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
    } else {
      const c = readJson(file) || {};
      const next = mcpEntry({ exePath, mcpJs });
      const zcodeStyle = cls.pointer === '/mcp/servers/tdai';
      if (zcodeStyle) { c.mcp = c.mcp || {}; c.mcp.servers = c.mcp.servers || {}; }
      else { c.mcpServers = c.mcpServers || {}; }
      const prev = zcodeStyle ? c.mcp.servers.tdai : c.mcpServers.tdai;
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) { results.push({ target: cls.name, action: '跳过', detail: '已是本应用接入' }); return; }
      if (zcodeStyle) c.mcp.servers.tdai = next; else c.mcpServers.tdai = next;
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
  if (key === 'claude-code' || key === 'zcode') {
    try {
      const home = opts.home;
      const t = key === 'claude-code'
        ? { name: 'Claude Code hook', homeDir: path.join(home, '.claude'), file: path.join(home, '.claude', 'settings.json') }
        : { name: 'ZCode hook', homeDir: path.join(home, '.zcode'), file: path.join(home, '.zcode', 'cli', 'config.json') };
      if (exists(t.homeDir)) {
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
      const text = readText(file) || '';
      const m = text.match(/\n?\[mcp_servers\.tdai\][\s\S]*?(?=\n\[|$)/);
      if (m) { backup(file); fs.writeFileSync(file, text.replace(m[0], '\n')); results.push({ target: cls.name, action: '移除', detail: '[mcp_servers.tdai]' }); }
      else results.push({ target: cls.name, action: '跳过', detail: '无 tdai 条目' });
    } else if (cls.kind === 'dsh-patch') {
      let profiles = [];
      try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { }
      let removed = 0;
      for (const p of profiles) {
        const f = path.join(file, p, 'cordis.patch.yml');
        const text = readText(f) || '';
        if (!text.includes('dsh-mcp-client')) continue;
        backup(f);
        // 移除 tdai-memory 注入块（含其上的注释行）：按行过滤掉注释+insert 块
        const lines = text.split('\n');
        const out = [];
        let skip = false;
        for (const l of lines) {
          if (/tdai-memory:begin/.test(l)) { skip = true; continue; }
          if (skip) {
            if (l.trim().startsWith('- insert:')) continue;
            if (l.trim().startsWith('- resolve:')) continue;
            if (/dsh-mcp-client/.test(l)) continue;
            if (l.trim().startsWith('config:') || l.trim().startsWith('transport:') || l.trim().startsWith('serverName:')
              || l.trim().startsWith('command:') || l.trim().startsWith('args:') || l.trim().startsWith('- ')
              || l.trim().startsWith('ELECTRON_RUN_AS_NODE') || l.trim() === '') continue;
            skip = false;
          }
          out.push(l);
        }
        fs.writeFileSync(f, out.join('\n').replace(/\n{3,}/g, '\n\n'));
        removed++;
      }
      results.push({ target: cls.name, action: removed ? '移除' : '跳过', detail: removed ? `${removed} 个 profile 移除 insert 条目` : '无 tdai 条目' });
    } else {
      const c = readJson(file);
      if (!c) { results.push({ target: cls.name, action: '跳过', detail: '配置文件不存在' }); return results; }
      const zcodeStyle = cls.pointer === '/mcp/servers/tdai';
      const has = zcodeStyle ? (c.mcp && c.mcp.servers && c.mcp.servers.tdai) : (c.mcpServers && c.mcpServers.tdai);
      if (!has) { results.push({ target: cls.name, action: '跳过', detail: '无 tdai 条目' }); return results; }
      if (zcodeStyle) delete c.mcp.servers.tdai; else delete c.mcpServers.tdai;
      backup(file); writeJson(file, c);
      results.push({ target: cls.name, action: '移除', detail: cls.pointer });
    }
  } catch (e) { results.push({ target: cls.name, action: '失败', detail: e.message }); }
  // 同步移除 Claude Code / ZCode 的 hook
  if (key === 'claude-code' || key === 'zcode') {
    try {
      const f = key === 'claude-code' ? path.join(home, '.claude', 'settings.json') : path.join(home, '.zcode', 'cli', 'config.json');
      const c = readJson(f);
      if (c && c.hooks && Array.isArray(c.hooks.UserPromptSubmit)) {
        const before = c.hooks.UserPromptSubmit.length;
        c.hooks.UserPromptSubmit = c.hooks.UserPromptSubmit.filter((x) => !JSON.stringify(x).includes(HOOK_MARK));
        if (c.hooks.UserPromptSubmit.length !== before) { backup(f); writeJson(f, c); results.push({ target: key + ' hook', action: '移除', detail: 'UserPromptSubmit' }); }
        else results.push({ target: key + ' hook', action: '跳过', detail: '无 tdai hook' });
      }
    } catch (e) { results.push({ target: key + ' hook', action: '失败', detail: e.message }); }
  }
  return results;
}

module.exports = { status, register, registerOneClient, unregisterOneClient, mcpEntry, hookScript, hookCmdPath, dshPatchBlock, INSTR, CLIENTS, HOOK_MARK };
