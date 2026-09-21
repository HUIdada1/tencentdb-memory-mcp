// sessions.js — 会话扫描（主进程侧，零依赖）
// 职责：直接读各 Agent 的会话文件，产出「进行中的会话」列表给总览页实时展示。
// 与守护进程的采集游标相互独立：这里只读元信息（轮次/末次时间/摘要），不做上传。
//
// 文件布局（与 daemon/tdai-daemon.js 的 SOURCES 口径严格一致，不要凭猜测改）：
//   ZCode CLI  : ~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl
//   Claude Code: ~/.claude/projects/<proj>/<sid>.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const NOTE_MAX = 46;           // 摘要截断长度
const TAIL_BYTES = 96 * 1024;  // 每个文件最多回读的字节数

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

function scanOne(entry) {
  let st;
  try { st = fs.statSync(entry.file); } catch (_) { return null; }
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

  return {
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
}

// 扫描全部会话，返回按最近交互倒序的列表
function scanSessions(opts) {
  const o = opts || {};
  const limit = o.limit || 40;
  const all = zcodeFiles().concat(claudeFiles());
  const out = [];
  for (const e of all) {
    const r = scanOne(e);
    if (r) out.push(r);
  }
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

module.exports = { scanSessions, cursorStats, zcodeFiles, claudeFiles, scanOne };
