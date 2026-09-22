// sessions.js — 会话扫描（主进程侧，零依赖）
// 职责：直接读各 Agent 的会话文件，产出「进行中的会话」列表给总览页实时展示。
// 与守护进程的采集游标相互独立：这里只读元信息（轮次/末次时间/摘要），不做上传。
//
// 数据来源（按"是否还在被写入"排序，越靠前越新）：
//   ZCode 会话库 : ~/.zcode/cli/db/db.sqlite   ← 权威源，zcode 会在聊完后异步归档写入
//   ZCode CLI    : ~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl  （实时落盘，聊完归档进 sqlite）
//   Claude Code  : ~/.claude/projects/<proj>/<sid>.jsonl
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

// node:sqlite 是 Node 22 内置模块（Experimental），Electron 主进程同样可用。
// 拿不到就安静降级到文件扫描 —— 绝不因为 sqlite 不可用而让整个列表空白。
let _sqliteMod;
function sqliteMod() {
  if (_sqliteMod !== undefined) return _sqliteMod;
  try { _sqliteMod = require('node:sqlite'); } catch (_) { _sqliteMod = null; }
  return _sqliteMod;
}

let _sqliteCache = { at: 0, rows: null, error: null };

// 读 session 表：拿会话元信息 + 末次消息时间 + 轮次 + 末条摘要。
// 一次 SQL 拿全，避免 N+1（426 个会话逐个查会明显卡顿）。
function readSqliteSessions() {
  const now = Date.now();
  if (_sqliteCache.rows && now - _sqliteCache.at < SQLITE_TTL) return _sqliteCache.rows;
  const mod = sqliteMod();
  if (!mod) { _sqliteCache = { at: now, rows: [], error: 'node:sqlite 不可用' }; return []; }
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
      ORDER BY upd DESC
      LIMIT 200`;
    const rows = db.prepare(sql).all();
    _sqliteCache = { at: now, rows: rows || [], error: null };
  } catch (e) {
    _sqliteCache = { at: now, rows: [], error: (e && e.message) || String(e) };
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
function sqliteSessions() {
  const rows = readSqliteSessions();
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

const PARSERS = { zcode: parseZCodeLine, 'claude-code': parseClaudeLine };

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

  const { text, size } = readTail(entry.file, TAIL_BYTES);
  const parse = PARSERS[entry.source] || parseZCodeLine;

  let turns = 0, lastTs = 0, sawTs = false, lastNote = '', lastRole = '';
  for (const ln of text.split('\n')) {
    if (!ln || ln[0] !== '{') continue;   // 首行可能是被截断的半截 JSON，跳过
    let j; try { j = JSON.parse(ln); } catch (_) { continue; }
    const t = tsOf(j);
    // 取文件内最大时间戳；文件内一条都没有时回落到 mtime
    if (!isNaN(t)) { sawTs = true; if (t > lastTs) lastTs = t; }
    const msg = parse(j);
    if (!msg) continue;
    turns++;
    lastRole = msg.role;
    lastNote = msg.content;
  }
  if (!sawTs) lastTs = st.mtimeMs;

  // 回读被截断时看到的轮次只是尾部一小段，用文件大小粗估总量。
  // 只有在"确实读到了轮次但明显少于文件规模"时才抬升，避免虚高。
  const est = Math.max(1, Math.round(size / 3072));
  const turnsFinal = turns === 0 ? est : (turns < est ? Math.round((turns + est) / 2) : turns);

  const label = entry.source === 'zcode'
    ? (entry.session || '').replace(/^sess_/, '').slice(0, 8)
    : (entry.id || '').slice(0, 8);

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
  const limit = Math.max(1, Math.min(Number(o.limit) || 40, 500));

  const byKey = new Map();   // sessionKey -> 会话行
  const rank = (s) => (s.fromDb ? 1e15 : 0) + (Number(s.lastTs) || 0);  // 时间相同时优先 sqlite

  for (const s of sqliteSessions()) {
    byKey.set(String(s.id).replace(/^zcode-db:/, ''), s);
  }

  const all = zcodeFiles().concat(claudeFiles());
  const alive = new Set();
  for (const e of all) {
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
  return { ok: true, files: all.length, total: out.length, sessions: out.slice(0, limit) };
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
  scanSessions, cursorStats, zcodeFiles, claudeFiles, scanOne,
  sqliteSessions,       // sqlite 权威源（守护进程上传侧也要用它）
  SQLITE,
};
