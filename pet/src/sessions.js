// sessions.js — 会话扫描（主进程侧，零依赖）
// 职责：直接读各 Agent 的会话文件，产出「进行中的会话」列表给总览页实时展示。
// 与守护进程的采集游标相互独立：这里只读元信息（轮次/末次时间/摘要），不做上传。
//
// 数据来源（按"是否还在被写入"排序，越靠前越新）：
//   ZCode 会话库 : ~/.zcode/cli/db/db.sqlite   ← 权威源，zcode 会在聊完后异步归档写入
//   ZCode CLI    : ~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl  （实时落盘，聊完归档进 sqlite）
//   Claude Code  : ~/.claude/projects/<proj>/<sid>.jsonl
//   Codex        : ~/.codex/sessions/**/rollout-*.jsonl + archived_sessions/*.jsonl
//   其它 Agent   : 各自的 sessions/conversations/history 目录（统一 JSONL/JSON 兼容解析）
//
// ⚠️ 历史教训（2026-09-22 修复）：
//   zcode 旧版把会话写在 agents/*/transcript.jsonl，新版改成了 sqlite 数据库。
//   只扫文件目录会看到"最新会话停在几个月前"的假象 —— 用户每天都在用，
//   但文件目录里的最新文件是 8 月 28 日的归档残留。
//   实时会话页的"最近交互"必须认 sqlite，文件目录只作为兜底。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const NOTE_MAX = 46;           // 摘要截断长度
const TAIL_BYTES = 96 * 1024;  // 每个文件最多回读的字节数
const SQLITE = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const SQLITE_TTL = 3000;       // sqlite 查询节流：3s 内复用上一次结果（扫描是 4s 一轮）

/* ---------- ZCode SQLite 会话库（权威源） ---------- */

// node:sqlite 是 Node 22.16+ 的内置模块（Experimental）。
// ⚠️ 但它**不是"有 Node 就有"** —— Electron 是各自编译的，内嵌 Node ∈ 20.x 的构建里
//    该模块根本不存在（实测 Electron 33/34 都没有；35 的内嵌 Node 才升到 22.16.0）。
//    旧注释写"Electron 主进程同样可用"是错的，已按实测改正（2026-09-22）。
// 拿不到就降级到文件扫描 —— 但**必须把降级事实暴露出去**（sqliteStatus().degraded），
// 否则用户看到的是"最新会话停在几个月前"的假象，还会以为程序坏了。
const SQLITE_MIN_NODE = '22.16.0';
let _sqliteMod;
function sqliteMod() {
  if (_sqliteMod !== undefined) return _sqliteMod;
  try { _sqliteMod = require('node:sqlite'); } catch (_) { _sqliteMod = null; }
  return _sqliteMod;
}

/* ---------- 运行时识别（决定提示文案，别再误导用户去升级系统 Node） ----------
 * ⚠️ 血泪教训（2026-09-22 用户实测反馈）：
 *   桌面版跑在 Electron 里，用的是 **Electron 内嵌的 Node**，与用户系统装的 Node 无关。
 *   Electron 33 → 内嵌 Node 20.18.3 → 没有 node:sqlite。
 *   用户机器上明明装着 Node 22，看到"当前 Node 20.18.3 不支持…请升级 Node 到 ≥22.16.0"
 *   直接懵了（"我此刻电脑是 node22，是识别有错误吗？"）。
 *   **提示里的版本号必须说清是哪一层**，并且修法要指向应用自身，而不是让用户去折腾系统 Node。
 * 返回 { kind, node, electron, isElectron, label }
 */
function runtimeInfo() {
  const v = process.versions || {};
  const electron = v.electron || '';
  return {
    node: v.node || '',
    electron,
    isElectron: !!electron,
    label: electron ? `Electron ${electron}（内嵌 Node ${v.node || '未知'}）` : `Node ${v.node || '未知'}`,
  };
}

// 「数值化版本比较」—— 千万别用字符串比较：'9.0.0' > '22.16.0' 是 true。
// 只取前两段（Electron 的主版本决定内嵌 Node 的 Node 大版本，够用了），
// 非数字段一律当 0，缺段补齐，保证 'v34.0.0' / '34.0' / '34' 都能比。
function verNum(s) {
  const p = String(s || '').replace(/^v/, '').split('.');
  const a = parseInt(p[0], 10) || 0;
  const b = parseInt(p[1], 10) || 0;
  return a * 1000 + b;
}

// Electron 主版本 → 其内嵌 Node 的 Node 版本。
// ⚠️⚠️ 全部为**实测值**，不是推算 —— 这张表曾因"想当然"写错，务必先验证再改。
// 实测记录（`ELECTRON_RUN_AS_NODE=1 electron.exe -e "require('node:sqlite')"`）：
//   33 → Node 20.18.3  → 无 node:sqlite
//   34 → Node 20.19.1  → 无 node:sqlite   ← 曾误以为 34 已带，实际没有！
//   35 → Node 22.16.0  → **有** node:sqlite
// 门槛是"内嵌 Node ≥ 22.16.0"，而 Electron 34 的内嵌 Node 仍是 20.x（只升了 patch）
// → **可用下限是 Electron 35，不是 34**。教训：Electron 主版本 ≠ 内嵌 Node 大版本会同步跳。
// 将来要升门槛，必须先跑上面那条命令实测，再改这张表；它同时被 pet 与测试消费（单一真源）。
const ELECTRON_EMBEDDED_NODE = {
  33: '20.18.3',   // 无 node:sqlite
  34: '20.19.1',   // 无 node:sqlite（实测！）
  35: '22.16.0',   // 有 node:sqlite
};
const ELECTRON_MIN = 35;   // 最低可用 Electron 主版本（内嵌 Node 需 ≥22.16.0）
const ELECTRON_MIN_LABEL = '35';

// 打包形态自检：**发布出去的应用**必须跑在够新的 Electron 上。
// 为什么必须显式检查（真实故障，2026-09-22）：
//   开发机上 `node -v` 是 22.x，很容易让"打包时 Electron 版本偏低"这件事滑过去；
//   直到用户侧发现「ZCode 会话库来源不可用、线上对话不再上传」才暴露。
//   electron 依赖在 pet/package.json 里升了，本函数是**运行期的最后一道闸**。
// 返回 { kind:'ok'|'electron-too-old'|'node-too-old', needed, actual, message }
function runtimeGate() {
  const rt = runtimeInfo();
  if (rt.isElectron) {
    const major = parseInt(String(rt.electron).split('.')[0], 10) || 0;
    if (major < ELECTRON_MIN) {
      const embedded = ELECTRON_EMBEDDED_NODE[major] || '未知';
      return {
        kind: 'electron-too-old', ok: false,
        actual: rt.electron, needed: ELECTRON_MIN_LABEL,
        message: `本应用打包所用 Electron ${rt.electron} 过低（内嵌 Node ${embedded}，`
          + `不含 node:sqlite）。需重新用 Electron ≥${ELECTRON_MIN_LABEL} 打包发布，`
          + '否则 ZCode 会话库既无法展示、也无法采集上传。',
      };
    }
    // Electron 版本够新，仍要确认内嵌 Node 真的带了 node:sqlite（防"表里假设"失真）
    if (verNum(rt.node) < verNum(SQLITE_MIN_NODE) && !sqliteMod()) {
      return {
        kind: 'node-too-old', ok: false,
        actual: rt.node, needed: SQLITE_MIN_NODE,
        message: `Electron ${rt.electron} 的内嵌 Node ${rt.node} 仍不含 node:sqlite`
          + `（需 ≥${SQLITE_MIN_NODE}），请改用更高版本的 Electron 打包。`,
      };
    }
    return { kind: 'ok', ok: true, actual: rt.electron, needed: ELECTRON_MIN_LABEL, message: '' };
  }
  // 纯 Node 形态：门槛就是 node:sqlite 本身的版本要求
  const nodeOk = verNum(rt.node) >= verNum(SQLITE_MIN_NODE) || !!sqliteMod();
  return {
    kind: nodeOk ? 'ok' : 'node-too-old', ok: nodeOk,
    actual: rt.node, needed: SQLITE_MIN_NODE,
    message: nodeOk ? ''
      : `当前 Node ${rt.node} 不含 node:sqlite（需 ≥${SQLITE_MIN_NODE}），`
        + 'ZCode 会话库无法读取。',
  };
}

// 降级原因：分「模块缺失」「库文件缺失」「查询失败」三种 —— 用户能据此自助修复。
// kind: 'ok' | 'no-module' | 'no-db' | 'query-error'
function sqliteStatus() {
  const mod = sqliteMod();
  const rt = runtimeInfo();
  const nodeVer = rt.node;
  if (!mod) {
    // Electron 形态：内嵌 Node 是**应用自带的**，用户升系统 Node 一点用都没有。
    // 必须换成"等应用升级"的口径，否则用户会白折腾（甚至怀疑是误报）。
    const message = rt.isElectron
      ? `应用内置运行时不支持 node:sqlite：${rt.label}，需 Node ≥${SQLITE_MIN_NODE}。`
        + '（这与您系统安装的 Node 版本无关，您系统的 Node 无需改动）'
        + '正在进行的会话只统计归档文件，可能看不到最近的对话。'
      : `当前运行时 Node ${nodeVer || '未知'} 不支持内置 node:sqlite（需 ≥${SQLITE_MIN_NODE}），`
        + '正在进行中的会话只统计归档文件，可能看不到最近的对话。';
    const hint = rt.isElectron
      ? '这是应用自身依赖的运行时版本偏低，需升级「TD 记忆守护」到采用 Electron 34+ 的版本；'
        + '守护进程与本机采集不受影响（它们只看归档文件与 ZCode 会话日志）。'
      : `升级 Node 到 ≥${SQLITE_MIN_NODE}，或从源码用更高版本重新运行应用。`;
    return {
      kind: 'no-module', ok: false, degraded: true,
      node: nodeVer, electron: rt.electron, runtime: rt.label,
      isElectron: rt.isElectron, minNode: SQLITE_MIN_NODE, path: SQLITE,
      message, hint,
    };
  }
  if (!fs.existsSync(SQLITE)) {
    return {
      kind: 'no-db', ok: true, degraded: false,
      node: nodeVer, electron: rt.electron, runtime: rt.label,
      isElectron: rt.isElectron, path: SQLITE,
      message: '', hint: '',
    };
  }
  const err = _sqliteCache && _sqliteCache.error;
  if (err) {
    return {
      kind: 'query-error', ok: false, degraded: true,
      node: nodeVer, electron: rt.electron, runtime: rt.label,
      isElectron: rt.isElectron, path: SQLITE, minNode: SQLITE_MIN_NODE,
      message: `读取 ZCode 会话库失败：${err}`,
      hint: '若 ZCode 正在写入，稍后会自动重试；持续失败请确认该文件未被其它程序独占。',
    };
  }
  return {
    kind: 'ok', ok: true, degraded: false,
    node: nodeVer, electron: rt.electron, runtime: rt.label,
    isElectron: rt.isElectron, path: SQLITE, message: '', hint: '',
  };
}

let _sqliteCache = { at: 0, limit: null, rows: null, error: null };

// 读 session 表：拿会话元信息 + 末次消息时间 + 轮次 + 末条摘要。
// 一次 SQL 拿全，避免 N+1（426 个会话逐个查会明显卡顿）。
function readSqliteSessions(limit) {
  const now = Date.now();
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), 5000) : 0;
  if (_sqliteCache.rows && _sqliteCache.limit === cap && now - _sqliteCache.at < SQLITE_TTL) return _sqliteCache.rows;
  const mod = sqliteMod();
  if (!mod) { _sqliteCache = { at: now, limit: cap, rows: [], error: 'node:sqlite 不可用' }; return []; }
  let db;
  try {
    // readOnly + 不设 WAL：这是别人正在写的库，只读打开最安全
    db = new mod.DatabaseSync(SQLITE, { readOnly: true });
    const sql = `
      SELECT s.id AS sid,
             s.title AS title,
             s.directory AS dir,
             COALESCE(s.time_updated, s.time_created) AS upd,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id
                AND json_extract(m.data, '$.role') = 'user') AS turns,
             (SELECT m.time_created FROM message m WHERE m.session_id = s.id
                ORDER BY m.time_created DESC LIMIT 1) AS last_ms,
             (SELECT substr(p.data, 1, 800) FROM part p
                WHERE p.session_id = s.id AND json_extract(p.data, '$.type') = 'text'
                ORDER BY p.time_created DESC LIMIT 1) AS last_part
      FROM session s
      ORDER BY upd DESC${cap ? `\n      LIMIT ${cap}` : ''}`;
    const rows = db.prepare(sql).all();
    _sqliteCache = { at: now, limit: cap, rows: rows || [], error: null };
  } catch (e) {
    _sqliteCache = { at: now, limit: cap, rows: [], error: (e && e.message) || String(e) };
  } finally {
    try { if (db) db.close(); } catch (_) { }
  }
  return _sqliteCache.rows;
}

// part.data 是 JSON 包裹：{"type":"text","text":"..."} / {"type":"reasoning","text":"..."}
// 模型只回工具调用时没有 text 字段，此时返回空串（上层会显示 "—"）
function textFromPart(raw) {
  if (!raw) return '';
  let j;
  try { j = JSON.parse(raw); } catch (_) { return String(raw); }
  if (!j || typeof j !== 'object') return String(j || '');
  const t = j.text != null ? j.text : (j.content != null ? j.content : '');
  if (typeof t === 'string') return t;
  // content 可能是分片数组（[{type:'text',text:'..'}]）
  if (Array.isArray(t)) {
    return t.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
  }
  return '';
}

// sqlite 摘要常以 markdown 或"二次转义"的 JSON 片段开头，统一清成人话。
// 有些 part 里存的 text 本身就是一段 JSON 字符串（{"type":"text","text":"..."}），
// 解一层后还剩 `"text\":\"...` 这类残渣 —— 这里反复剥离，并用 \" 还原引号。
function cleanNote(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 3; i++) {
    // {"type":"text","text":"  /  "text\":\"  —— 两种转义形态都吃掉
    const before = t;
    t = t.replace(/^\s*\{\s*"[a-zA-Z_]+"\s*:\s*"[a-zA-Z_]+"\s*,\s*"[a-zA-Z_]+"\s*:\s*"?/, '');
    t = t.replace(/^\s*"?[a-zA-Z_]+\\?"\s*:\s*\\?"?/, '');
    if (t === before) break;
  }
  t = t.replace(/\\"/g, '"').replace(/\\n/g, ' ')
       .replace(/[#*`>]+/g, '').replace(/\s+/g, ' ')
       .replace(/^[\s"\\:]+/, '').trim();
  return t;
}

// 会话标题：zcode 会自动起标题；没有就用工作目录名兜底
function titleOf(row) {
  const t = String((row && row.title) || '').trim();
  if (t) return t;
  const d = String((row && row.dir) || '').replace(/[\\/]+$/, '');
  const base = d.split(/[\\/]/).pop();
  return base || '未命名会话';
}

// sqlite 摘要优先用最后一条"纯文本"part（跳过 reasoning / tool 调用），渲染前清洗 markdown
function noteFromRow(r) {
  return cleanNote(textFromPart(r.last_part)).slice(0, NOTE_MAX);
}

// sqlite → 统一的会话行（与 scanOne 的输出结构对齐）
function sqliteSessions(limit) {
  const rows = readSqliteSessions(limit);
  const out = [];
  for (const r of rows) {
    const lastTs = Number(r.last_ms) || Number(r.upd) || 0;
    const turns = Number(r.turns) || 0;
    if (!lastTs) continue;
    out.push({
      id: `zcode-db:${String(r.sid || '')}`,
      source: 'zcode',
      label: titleOf(r),
      file: r.dir ? String(r.dir) : SQLITE,
      turns: turns || 1,
      msgCount: Number(r.msgs) || 0,
      lastTs,
      lastRole: 'assistant',
      lastNote: noteFromRow(r),
      size: Number(r.msgs) || 0,
      fromDb: true,
    });
  }
  return out;
}

/* ---------- 来源枚举 ---------- */

// ZCode CLI：~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl
function zcodeFiles() {
  const root = path.join(HOME, '.zcode', 'cli', 'agents');
  let sess = [];
  try { sess = fs.readdirSync(root); } catch (_) { return []; }
  const out = [];
  for (const s of sess) {
    let agents = [];
    try { agents = fs.readdirSync(path.join(root, s)); } catch (_) { continue; }
    for (const a of agents) {
      const f = path.join(root, s, a, 'transcript.jsonl');
      try {
        if (!fs.statSync(f).isFile()) continue;
        out.push({ file: f, source: 'zcode', id: `${s}`, agent: a, session: s });
      } catch (_) { }
    }
  }
  return out;
}

// Claude Code：~/.claude/projects/<proj>/<sid>.jsonl
function claudeFiles() {
  const root = path.join(HOME, '.claude', 'projects');
  let projs = [];
  try { projs = fs.readdirSync(root); } catch (_) { return []; }
  const out = [];
  for (const p of projs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, p)); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(root, p, f);
      try {
        if (fs.statSync(full).isFile()) out.push({ file: full, source: 'claude-code', id: f.replace(/\.jsonl$/, ''), project: p });
      } catch (_) { }
    }
  }
  return out;
}

// 其它客户端的会话目录没有统一标准，只在明确的会话目录下递归，
// 不扫描客户端根目录，避免把配置、缓存和扩展包当成会话上传。
const EXTRA_SOURCE_DIRS = {
  cursor: ['.cursor/projects', '.cursor/chats'],
  trae: ['.trae/projects', '.trae/sessions', '.trae/conversations'],
  'deepseek-harness': ['.dsh/sessions', '.dsh/conversations', '.dsh/storages/session_projcache/sessions'],
  codebuddy: ['.codebuddy/sessions', '.codebuddy/conversations', '.codebuddy/history'],
  workbuddy: ['.workbuddy-ai/sessions', '.workbuddy-ai/conversations', '.workbuddy-ai/history', '.workbuddy-ai/logs', '.workbuddy/sessions'],
  opencode: ['.local/share/opencode/storage/message', '.local/share/opencode/storage/session', '.config/opencode/sessions', '.config/opencode/storage'],
  hermes: ['.hermes/sessions', '.hermes/conversations', '.hermes/history'],
  openclaw: ['.openclaw/sessions', '.openclaw/conversations', '.openclaw/history'],
  pi: ['.pi/agent/sessions', '.pi/agent/conversations', '.pi/agent/history'],
};

const EXTRA_EXTS = new Set(['.jsonl', '.json', '.log']);
const EXTRA_SKIP = /(?:\\|\/)(?:cache|caches|node_modules|extensions?|artifacts?)(?:\\|\/)/i;
function walkSessionFiles(roots, maxDepth = 5) {
  const out = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > maxDepth || out.length >= 5000 || seen.has(dir) || EXTRA_SKIP.test(dir)) return;
    seen.add(dir);
    let names; try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (out.length >= 5000) break;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) visit(full, depth + 1);
      else if (st.isFile() && EXTRA_EXTS.has(path.extname(name).toLowerCase()) && !EXTRA_SKIP.test(full)) out.push(full);
    }
  };
  roots.forEach((r) => visit(r, 0));
  return out;
}

function extraFiles(source) {
  const roots = sourceRoots(source);
  return walkSessionFiles(roots).filter((file) => isExtraCandidate(source, file))
    .map((file) => ({ file, source, id: path.basename(file).replace(/\.(jsonl|json|log)$/i, '') }));
}

// AppData 下的 VS Code 工作区包含大量配置/缓存 JSON；它们即使扩展名正确也不是会话。
// WorkBuddy 只认 conversations 目录，避免 daemon.log、sandbox 和 startup 日志进入列表。
function isExtraCandidate(source, file) {
  const lower = String(file || '').toLowerCase().replace(/\\/g, '/');
  const base = path.basename(lower);
  if (/^(workspace|storage|settings|config|state|state\.vscdb(?:\.options)?|package-lock)\.json$/.test(base)) return false;
  if (source === 'workbuddy') return /\/conversations\//.test(lower);
  if (source === 'deepseek-harness') return /\/sessions\//.test(lower) || /\/conversations\//.test(lower);
  if (source === 'codebuddy' && /\/plans\//.test(lower)) return false;
  return true;
}

function sourceRoots(source) {
  const roots = (EXTRA_SOURCE_DIRS[source] || []).map((r) => path.join(HOME, r));
  const app = process.env.APPDATA || '';
  const local = process.env.LOCALAPPDATA || '';
  const appRoots = {
    cursor: ['Cursor/User/workspaceStorage', 'Cursor/User/globalStorage'],
    trae: ['Trae/User/workspaceStorage', 'Trae CN/User/workspaceStorage'],
    codebuddy: ['CodeBuddy/User/workspaceStorage', 'CodeBuddy/User/globalStorage', 'CodeBuddy CN/User/workspaceStorage'],
    workbuddy: ['WorkBuddy/User/workspaceStorage', 'WorkBuddy AI/User/workspaceStorage'],
    opencode: ['opencode/storage'],
  };
  for (const rel of (appRoots[source] || [])) {
    if (app) roots.push(path.join(app, rel));
    if (local) roots.push(path.join(local, rel));
  }
  return roots;
}

function codexFiles() {
  const root = path.join(HOME, '.codex');
  const names = new Map();
  try {
    for (const line of fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const j = JSON.parse(line); if (j && j.id && j.thread_name) names.set(String(j.id), String(j.thread_name)); } catch (_) { }
    }
  } catch (_) { }
  const roots = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')];
  return walkSessionFiles(roots, 8)
    .filter((f) => /(?:^|[\\/])rollout-.*\.jsonl$/i.test(f))
    .map((file) => {
      const id = path.basename(file).replace(/\.jsonl$/i, '').replace(/^rollout-.*-([0-9a-f-]{36})$/, '$1');
      return { file, source: 'codex', id, label: names.get(id) || path.basename(file).replace(/\.jsonl$/i, '') };
    });
}

/* ---------- 行解析（与 daemon 完全同构，只取摘要不参与上传） ---------- */

// ZCode：turn_started.payload.input = 用户输入；turn_complete.payload.response = 最终答复
// 注意：实测真实文件用的字段是 `type`（不是 `event`），两者都认，避免上游口径变化时静默失效。
function parseZCodeLine(j) {
  if (!j || typeof j !== 'object') return null;
  const kind = j.type || j.event;
  if (kind === 'turn_started' && j.payload && j.payload.input != null && String(j.payload.input).trim()) {
    return { role: 'user', content: String(j.payload.input) };
  }
  if (kind === 'turn_complete' && j.payload && j.payload.response != null && String(j.payload.response).trim()) {
    return { role: 'assistant', content: String(j.payload.response) };
  }
  return null;
}

// Claude Code：标准 messages 数组
function parseClaudeLine(j) {
  const m = j && j.message; if (!m) return null;
  const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
  if (!role) return null;
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    text = m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
  }
  text = String(text || '').trim();
  if (!text || text.startsWith('<system-reminder>')) return null;
  return { role, content: text };
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.filter((x) => x && (x.type === 'text' || x.type === 'input_text' || x.type === 'output_text') && x.text)
    .map((x) => x.text).join('\n').trim();
  if (content && typeof content === 'object') return textOfContent(content.text || content.content || content.parts || '');
  return '';
}

// Codex rollout 记录：response_item.payload.message.role/content。
// 兼容历史/归档记录中的 message 顶层写法，并跳过 developer/system/tool。
function parseCodexLine(j) {
  if (!j || typeof j !== 'object') return null;
  const p = j.payload && typeof j.payload === 'object' ? j.payload : j;
  const item = p.type === 'message' ? p : (j.type === 'message' ? j : null);
  const msg = item && item.message && typeof item.message === 'object' ? item.message : item;
  const role = msg && (msg.role === 'user' || msg.role === 'assistant') ? msg.role : null;
  const text = textOfContent(msg && (msg.content != null ? msg.content : msg.text));
  if (!role || !text || text.startsWith('<system-reminder>') || text.startsWith('<task-notification>')) return null;
  return { role, content: text };
}

// Cursor/Trae/CodeBuddy 等 VS Code 系客户端常见的 message 形态；
// 也兼容 Pi/Hermes/OpenClaw 的 {role,content} 或 {message:{...}}。
function parseGenericLine(j) {
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (_) {
      const i = j.indexOf('{');
      if (i < 0) return null;
      try { j = JSON.parse(j.slice(i)); } catch (_) { return null; }
    }
  }
  if (!j || typeof j !== 'object') return null;
  const batch = Array.isArray(j) ? j : (Array.isArray(j.messages) ? j.messages : (Array.isArray(j.items) ? j.items : null));
  if (batch) {
    const out = [];
    for (const item of batch) {
      const parsed = parseGenericLine(item);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed) out.push(parsed);
    }
    return out.length ? out : null;
  }
  const m = j.message && typeof j.message === 'object' ? j.message : j;
  const role = m.role === 'assistant' || m.role === 'user' ? m.role : null;
  const text = textOfContent(m.content != null ? m.content : (m.text != null ? m.text : m.parts));
  if (!role || !text || text.startsWith('<system-reminder>') || text.startsWith('<task-notification>')) return null;
  return { role, content: text };
}

// WorkBuddy SDK 日志：行首有时间和 method 前缀，末尾才是 JSON。
// 真实对话位于 method:requests:result 的 state[].userContent/assistantContent。
function parseWorkBuddyLine(j) {
  if (typeof j === 'string') {
    const i = j.indexOf('{');
    if (i < 0) return null;
    try { j = JSON.parse(j.slice(i)); } catch (_) { return null; }
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.state)) return null;
  const out = [];
  const text = (items) => Array.isArray(items)
    ? items.filter((x) => x && x.text && (!x.type || x.type === 'text' || x.type === 'input_text' || x.type === 'output_text'))
      .map((x) => String(x.text)).join('\n').trim() : '';
  for (const state of j.state) {
    const user = text(state && state.userContent);
    const assistant = text(state && state.assistantContent);
    if (user) out.push({ role: 'user', content: user });
    if (assistant) out.push({ role: 'assistant', content: assistant });
  }
  return out.length ? out : null;
}

function parseDeepSeekLine(j) {
  if (!j || typeof j !== 'object') return null;
  const turns = j.record && j.record.rows && j.record.rows.turnOutline && j.record.rows.turnOutline.val && j.record.rows.turnOutline.val.turns;
  if (!Array.isArray(turns)) return parseGenericLine(j);
  const out = [];
  for (const turn of turns) {
    if (turn && turn.prompt) out.push({ role: 'user', content: String(turn.prompt) });
    if (turn && turn.response) out.push({ role: 'assistant', content: String(turn.response) });
  }
  return out.length ? out : null;
}

const PARSERS = {
  zcode: parseZCodeLine,
  'claude-code': parseClaudeLine,
  codex: parseCodexLine,
  cursor: parseGenericLine,
  trae: parseGenericLine,
  'deepseek-harness': parseDeepSeekLine,
  codebuddy: parseGenericLine,
  workbuddy: parseWorkBuddyLine,
  opencode: parseGenericLine,
  hermes: parseGenericLine,
  openclaw: parseGenericLine,
  pi: parseGenericLine,
};

// 从一行 JSON 里取时间戳（两个来源字段不同）
function tsOf(j) {
  const cands = [j && j.timestamp, j && j.ts, j && j.time, j && j.created_at,
    j && j.payload && j.payload.timestamp, j && j.message && j.message.timestamp];
  for (const c of cands) {
    if (c == null) continue;
    const t = typeof c === 'number' ? (c > 1e12 ? c : c * 1000) : Date.parse(c);
    if (!isNaN(t)) return t;
  }
  return NaN;
}

/* ---------- 读取单个会话文件 ---------- */

function readTail(file, maxBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return { text: '', size: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - maxBytes);
    const len = size - from;
    if (len <= 0) return { text: '', size };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    return { text: buf.toString('utf8'), size, truncated: from > 0 };
  } catch (_) {
    return { text: '', size: 0 };
  } finally {
    try { fs.closeSync(fd); } catch (_) { }
  }
}

// 扫描结果缓存：4s 一轮全量扫描 + 每文件 96KB 回读，会话多时是纯浪费。
// 文件 mtime + size 都没变就直接复用上一轮结果（这是最容易命中且收益最大的优化）。
const scanCache = new Map();   // file -> { mtimeMs, size, result }

function scanOne(entry) {
  let st;
  try { st = fs.statSync(entry.file); } catch (_) { return null; }

  const hit = scanCache.get(entry.file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;

  const isSnapshot = /\.json$/i.test(entry.file);
  const { text, size } = isSnapshot
    ? (() => { try { return { text: fs.readFileSync(entry.file, 'utf8'), size: fs.statSync(entry.file).size }; } catch (_) { return { text: '', size: 0 }; } })()
    : readTail(entry.file, TAIL_BYTES);
  const parse = PARSERS[entry.source] || parseZCodeLine;

  let turns = 0, lastTs = 0, sawTs = false, lastNote = '', lastRole = '';
  const lines = isSnapshot
    ? (() => { try { const j = JSON.parse(text); return (Array.isArray(j) ? j : [j]).map((x) => JSON.stringify(x)); } catch (_) { return []; } })()
    : text.split('\n');
  for (const ln of lines) {
    if (!ln) continue;
    let j;
    if (entry.source === 'workbuddy' && ln[0] !== '{') {
      // WorkBuddy 行首带时间戳和 method 前缀，交给专用解析器处理。
      j = ln;
    } else {
      if (ln[0] !== '{') continue; // 首行可能是被截断的半截 JSON，跳过
      try { j = JSON.parse(ln); } catch (_) { continue; }
    }
    const t = typeof j === 'string' && entry.source === 'workbuddy'
      ? Date.parse(j.slice(0, 24)) : tsOf(j);
    // 取文件内最大时间戳；文件内一条都没有时回落到 mtime
    if (!isNaN(t)) { sawTs = true; if (t > lastTs) lastTs = t; }
    const parsed = parse(j);
    const msgs = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    for (const msg of msgs) {
      if (!msg) continue;
      turns++;
      lastRole = msg.role;
      lastNote = msg.content;
    }
  }
  if (!sawTs) lastTs = st.mtimeMs;

  // 回读被截断时看到的轮次只是尾部一小段，用文件大小粗估总量。
  // 只有在"确实读到了轮次但明显少于文件规模"时才抬升，避免虚高。
  const est = Math.max(1, Math.round(size / 3072));
  // 非会话文件（配置、缓存、普通日志）不能按大小伪造一条会话。
  if (turns === 0) return null;
  const turnsFinal = turns < est ? Math.round((turns + est) / 2) : turns;

  const label = entry.label || (entry.source === 'zcode'
    ? (entry.session || '').replace(/^sess_/, '').slice(0, 8)
    : (entry.id || path.basename(entry.file).replace(/\.(jsonl|json)$/i, '')).slice(0, 32));

  const result = {
    id: `${entry.source}:${entry.id}${entry.agent ? ':' + String(entry.agent).replace(/^agent_/, '').slice(0, 8) : ''}`,
    source: entry.source,
    label,
    file: entry.file,
    turns: turnsFinal,
    lastTs,
    lastRole,
    lastNote: String(lastNote || '').replace(/\s+/g, ' ').slice(0, NOTE_MAX),
    size,
  };
  scanCache.set(entry.file, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// 扫描全部会话，返回按最近交互倒序的列表
//
// 合并策略（去重后取时间更新的一条）：
//   ① sqlite 会话库 = 权威源（覆盖 100% 历史，zcode 归档后仍在这里）
//   ② agents/*/transcript.jsonl = 实时落盘文件（正在对话时先写文件、聊完归档进 sqlite）
//   同一个 sessionId 在两边都出现时，取 lastTs 更大的那份元信息。
function scanSessions(opts) {
  const o = opts || {};
  // limit=0 表示不截断；UI 会在渲染层按 40 条分页，避免把“前 40 条”误当成全部。
  const requested = Number(o.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 5000) : 0;

  const byKey = new Map();   // sessionKey -> 会话行
  const rank = (s) => (s.fromDb ? 1e15 : 0) + (Number(s.lastTs) || 0);  // 时间相同时优先 sqlite

  for (const s of sqliteSessions(limit || undefined)) {
    byKey.set(String(s.id).replace(/^zcode-db:/, ''), s);
  }

  const entries = zcodeFiles().map((e) => e)
    .concat(claudeFiles().map((e) => e))
    .concat(codexFiles())
    .concat(Object.keys(EXTRA_SOURCE_DIRS).flatMap((source) => extraFiles(source)));
  const all = entries.map((e) => e.file);
  const alive = new Set();
  for (const e of entries) {
    alive.add(e.file);
    const r = scanOne(e);
    if (!r) continue;
    // 文件来源的 id 形如 "zcode:sess_xxx:agent_yyy" —— 用 sessionId 去重，
    // 因为 sqlite 里的 sessionId 与文件目录名同源（都是 sess_xxx）
    const key = e.source === 'zcode' ? String(e.session || r.id) : String(r.id);
    const prev = byKey.get(key);
    if (!prev || rank(r) > rank(prev)) byKey.set(key, r);
  }
  for (const k of Array.from(scanCache.keys())) if (!alive.has(k)) scanCache.delete(k);

  const out = Array.from(byKey.values());
  out.sort((a, b) => b.lastTs - a.lastTs);
  // sqliteHealth 一并回传：UI 据此在降级时显示明确警告，而不是静默少显示会话
  const sqlite = sqliteStatus();
  const res = { ok: true, files: all.length, total: out.length, sessions: limit ? out.slice(0, limit) : out };
  if (limit && out.length > limit) res.truncated = true;
  if (sqlite.degraded) res.warnings = [{ code: 'sqlite', source: 'zcode', ...sqlite }];
  return res;
}

// 游标统计：哪些会话已建立上传进度
function cursorStats() {
  const p = path.join(HOME, '.zcode', 'tdai-daemon', 'cursors.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return { ok: false, count: 0, bySource: {}, seeded: 0, pending: 0 }; }
  const bySource = {};
  let seeded = 0, pending = 0;
  for (const k of Object.keys(raw || {})) {
    const v = raw[k] || {};
    const src = v.source || (String(k).indexOf('claude') >= 0 ? 'claude-code' : 'zcode');
    bySource[src] = (bySource[src] || 0) + 1;
    if (v.seeded) seeded++; else pending++;
  }
  return { ok: true, count: Object.keys(raw || {}).length, bySource, seeded, pending, path: p };
}

module.exports = {
  scanSessions, cursorStats, zcodeFiles, claudeFiles, codexFiles, extraFiles, sourceRoots, scanOne,
  parseCodexLine, parseGenericLine, parseDeepSeekLine, parseWorkBuddyLine,
  sqliteSessions,       // sqlite 权威源（守护进程上传侧也要用它）
  sqliteStatus,         // 降级状态（UI 警告用）：kind/degraded/message/hint
  runtimeInfo,          // 运行时识别（Electron 内嵌 Node vs 系统 Node），文案据此分流
  runtimeGate,          // 打包形态自检：Electron 主版本够不够新（发布闸门）
  verNum,               // 数值化版本比较（字符串比较会误判，见实现注释）
  SQLITE_MIN_NODE,      // node:sqlite 最低 Node 版本（与 daemon 的 ZDB_MIN_NODE 必须一致）
  ELECTRON_MIN,         // 最低可用 Electron 主版本
  ELECTRON_MIN_LABEL,
  ELECTRON_EMBEDDED_NODE,  // 实测的「Electron 主版本 → 内嵌 Node 版本」表（单一真源）
  SQLITE,
};
