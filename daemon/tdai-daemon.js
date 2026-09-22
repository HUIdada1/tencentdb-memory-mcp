#!/usr/bin/env node
// tdai-daemon.js — TD 记忆守护·单文件零依赖守护进程
// 无参运行 = 守护服务（HTTP :8100 + 采集上传循环）
// 子命令：push   = 立即采集上传一轮
//         hook   = recall hook 入口（stdin/--q 读取用户输入，stdout 输出记忆片段）
//         health = 打印健康状态
// 零 npm 依赖；自包含（可被 Node SEA 打包为单文件 exe）。
// 配置仅读本机 ~/.zcode/tdai-mcp.json（env 同权覆盖）；密钥不出本机。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

/* ---------- 常量 ---------- */

const CFG_PATH = path.join(os.homedir(), '.zcode', 'tdai-mcp.json');
const DATA_DIR = path.join(os.homedir(), '.zcode', 'tdai-daemon');
const CURSORS_PATH = path.join(DATA_DIR, 'cursors.json');
const QUEUE_DIR = path.join(DATA_DIR, 'queue');
const LOG_PATH = path.join(DATA_DIR, 'daemon.log');

const RECALL_PORT = Number(process.env.TDAI_DAEMON_PORT) || 8100;
const APP_VER = '0.5.14';         // 与 package.json 同步；SEA exe 的版本号
const REPO_API = 'https://api.github.com/repos/HUIdada1/tencentdb-memory-mcp/releases/latest';
const RECALL_TIMEOUT_MS = 800;   // hook 链路硬超时：超时返回空，绝不阻塞对话
const SCAN_INTERVAL_MS = 2 * 60 * 1000;  // 采集循环 2 分钟
const MSG_MAX_CHARS = 8192;      // 面板单条消息硬限制
const RECALL_CLIP = 2048;        // 单次注入 ≤2KB
const CACHE_TTL_MS = 10 * 60 * 1000;     // 固定块缓存 10 分钟
const QUEUE_MAX = 200;           // NAS 离线积压上限
const REQ_TIMEOUT = 15000;

// 意图门控：命中才做远程 search，未命中只注入缓存固定块
const INTENT_WORDS = [
  '之前', '上次', '我们怎么做的', '怎么做', '还记得', '历史', '曾经', '以前', '那个方案', '以前怎么',
  'earlier', 'last time', 'remember', 'previously', 'we discussed', 'how did we',
];

/* ---------- 配置 ---------- */

function loadConfig() {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { }
  const env = {
    panelUrl: process.env.TDAI_PANEL_URL,
    userKey: process.env.TDAI_USER_KEY,
    teamId: process.env.TDAI_TEAM_ID,
    agentId: process.env.TDAI_AGENT_ID,
    taskId: process.env.TDAI_TASK_ID,
    serviceId: process.env.TDAI_SERVICE_ID,
    recallAlways: process.env.TDAI_RECALL_ALWAYS,
  };
  const cfg = Object.assign(
    { panelUrl: '', userKey: '', teamId: '', agentId: '', taskId: '', serviceId: 'default', recallAlways: false },
    disk, Object.fromEntries(Object.entries(env).filter(([, v]) => v))
  );
  cfg.panelUrl = String(cfg.panelUrl || '').replace(/\/+$/, '');
  cfg.upload = Object.assign(
    { enabledSources: { zcode: true, 'zcode-db': true, 'claude-code': true }, createAgentIfMissing: true },
    disk.upload || {}, process.env.TDAI_UPLOAD_SOURCES ? JSON.parse(process.env.TDAI_UPLOAD_SOURCES) : {}
  );
  // 老配置文件里没有 zcode-db 这一项：缺省补上，否则升级后新来源静默不采。
  // 用户显式写 false 的尊重其选择。
  if (cfg.upload.enabledSources && cfg.upload.enabledSources['zcode-db'] === undefined) {
    cfg.upload.enabledSources['zcode-db'] = true;
  }
  return cfg;
}

function missingConfig(cfg) {
  const miss = [];
  if (!cfg.panelUrl) miss.push('panelUrl');
  if (!cfg.userKey) miss.push('userKey');
  if (!cfg.teamId) miss.push('teamId');
  if (!cfg.agentId) miss.push('agentId');
  return miss.length ? `请在 ${CFG_PATH} 写入: ${miss.join(', ')}` : '';
}

/* ---------- 日志 ---------- */

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) { }
  console.log(line);
}

/* ---------- HTTP 客户端 ---------- */

function requestRaw(urlStr, { method = 'GET', headers = {}, body = null, timeout = REQ_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign({ 'Accept': 'application/json' }, headers),
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/* ---------- 面板响应判定（core/panel-codes.js 的**内联副本**） ----------
 *
 * ⚠️ 为什么内联而不 require：
 *   本文件要能单独打包成 SEA exe（单文件自包含），不能依赖 core/ 目录存在。
 *   `test/clients-consistency.test.js` 会断言这里的常量/函数与 core/panel-codes.js 语义一致，
 *   改一边必须改另一边（测试会拦），别让两处漂移。
 *
 * 2026-09-22 实测（真实面板）——「HTTP 状态码 ≠ 结论」：
 *   缺 X-Tdai-Service-Id        → 400 {"code":400,"message":"MISSING_INSTANCE_ID"}
 *   缺 X-Tdai-User-Key          → 400 {"code":400,"message":"MISSING_USER_KEY"}
 *   serviceId 不存在             → 400 {"code":400,"message":"INVALID_INSTANCE"}
 *   检索没给 block_id            → 400 {"code":400,"message":"MISSING_BLOCK_ID"}
 *   分层传了非法 layer           → 400 {"code":400,"message":"INVALID_LAYER"}
 *   检索用错 userKey            → 401 {"code":401,"message":"INVALID_USER_KEY"}
 *   /skill/list 用错 userKey    → 200 {"code":0}  ← 该端点**不校验** key！
 *   端点不存在 / 方法不对        → 404 纯文本（**无 JSON**）
 *   成功                       → 200 {"code":0,"message":"ok","data":{...}}
 *
 * 旧实现只看 status===401/403 与 status>=500 → 把「HTTP 400 + 可操作业务码」和
 * 「HTTP 404」判成成功 ⇒ 上游静默"上传成功"实则零写入。本块修的就是这个。
 */
const PANEL_OK_CODE = 0;
const PANEL_API_PREFIX = '/api/v1';   // ⚠️ 不是上游文档里的 /v3（/v3 是前端路由，实测全 404）
const PANEL_HINTS = {
  MISSING_INSTANCE_ID: '未带 X-Tdai-Service-Id 头：请在配置里填 serviceId（默认 default）',
  MISSING_USER_KEY: '缺少 userKey：请在「设置 → 记忆库连接」里填面板的用户密钥',
  INVALID_INSTANCE: 'serviceId 面板不认：核对「设置 → 记忆库连接」里的 serviceId 是否与面板一致',
  INVALID_USER_KEY: 'userKey 失效：去面板重新复制一份用户密钥，填回「设置 → 记忆库连接」',
  PERMISSION_DENIED: '当前 userKey 没有该操作权限：请在面板里给这个用户授权（或换有权限的 key）',
  FORBIDDEN: '当前 userKey 没有该操作权限：请在面板里给这个用户授权',
  MISSING_BLOCK_ID: '缺少记忆块：请配置 teamId + agentId，或显式指定 block_id',
  INVALID_LAYER: 'layer 只支持 L0/L1/L2/L3：请检查记忆页选的层级',
  INVALID_TEAM_ID: 'teamId 无效或不存在：核对「设置 → 记忆库连接」里的团队 ID',
  INVALID_AGENT_ID: 'agentId 无效或不存在：核对「设置 → 记忆库连接」里的 Agent ID',
  INTERNAL_ERROR: '面板内部错误（可重试）：若持续出现请查看面板服务端日志',
  SERVICE_UNAVAILABLE: '面板服务不可用（可重试）：稍后再试，或确认面板容器状态',
  LLM_ERROR: '面板的模型服务报错（可重试）：蒸馏/抽取依赖模型，稍后再试',
  EXTRACT_FAILED: '面板抽取流水线失败（可重试）',
};
const PANEL_CODE_CLASS = {
  MISSING_INSTANCE_ID: 'config', MISSING_USER_KEY: 'config', INVALID_INSTANCE: 'config',
  INVALID_USER_KEY: 'config', PERMISSION_DENIED: 'config', FORBIDDEN: 'config',
  MISSING_BLOCK_ID: 'input', INVALID_LAYER: 'input', INVALID_TEAM_ID: 'input', INVALID_AGENT_ID: 'input',
  INTERNAL_ERROR: 'server', SERVICE_UNAVAILABLE: 'server', LLM_ERROR: 'server', EXTRACT_FAILED: 'server',
};
function codeKeyOf(message) {
  const s = String(message == null ? '' : message).trim();
  if (!s) return '';
  const m = s.match(/^([A-Z][A-Z0-9_]{2,})/);
  if (m) return m[1];
  const head = s.split(/[:：]/)[0].trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(head) ? head : '';
}
// 详见 core/panel-codes.js 的 classify 文档。返回值多带 ok/kind/retriable 便于调用方分支。
function classifyPanel(r) {
  const status = (r && typeof r.status === 'number') ? r.status : 0;
  let json = (r && r.json && typeof r.json === 'object') ? r.json : null;
  if (!json && r && typeof r.raw === 'string' && r.raw) {
    const t = r.raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { json = JSON.parse(t); } catch (_) { json = null; } }
  }
  const code = json && typeof json.code === 'number' ? json.code : undefined;
  const message = String((json && (json.message || json.msg || json.error)) || '');
  // ⚠️ 业务码常量可能出现在三处：message / code（字符串）/ error。
  //   只看数字 code 会漏掉 {"code":"MISSING_INSTANCE_ID"} 这类形态 → 提示退化成
  //   "面板返回 HTTP 400"。与 core/panel-codes.js 的 classify() 保持同一口径。
  const shownCode = json && typeof json.code === 'string' ? json.code : code;
  const key = codeKeyOf(
    (json && typeof json.code === 'string' ? json.code : '')
    || message
    || String((json && json.error) || ''));
  const hint = (key && PANEL_HINTS[key]) || '';
  const cls = (key && PANEL_CODE_CLASS[key]) || '';
  const base = { status, code: shownCode, message, key, hint, cls, json };
  if (status === 0) return Object.assign(base, { ok: false, kind: 'unreachable', retriable: true, hint: hint || '面板不可达：检查地址/端口/公网开闸' });
  if (code !== undefined && code !== PANEL_OK_CODE) {
    if (code === 401 || code === 403) return Object.assign(base, { ok: false, kind: 'auth', retriable: false, hint: hint || 'userKey 失效或权限不足：去面板重新复制密钥' });
    if (code >= 500) return Object.assign(base, { ok: false, kind: 'server', retriable: true, hint: hint || '面板内部错误（可重试）' });
    const kind = cls === 'server' ? 'server' : (cls === 'config' ? 'auth' : (cls === 'input' ? 'input' : 'unknown'));
    return Object.assign(base, { ok: false, kind, retriable: cls === 'server', hint });
  }
  if (status >= 200 && status < 300) return Object.assign(base, { ok: true, kind: 'ok', retriable: false, hint: '' });
  if (status === 401 || status === 403) return Object.assign(base, { ok: false, kind: 'auth', retriable: false, hint: hint || 'userKey 失效或权限不足：去面板重新复制密钥' });
  if (status === 404) return Object.assign(base, { ok: false, kind: 'not-found', retriable: false, hint: hint || '面板没有这个接口：请确认面板版本（本项目走 /api/v1 业务面）' });
  if (status >= 500) return Object.assign(base, { ok: false, kind: 'server', retriable: true, hint: hint || '面板 5xx（可重试）' });
  return Object.assign(base, { ok: false, kind: 'unknown', retriable: false, hint: hint || `面板返回 HTTP ${status}` });
}
/** 一行摘要：优先业务 hint。 */
function panelSummary(v) {
  if (!v || v.ok) return '';
  return v.hint || v.message || (v.status ? `面板返回 HTTP ${v.status}` : '面板不可达');
}

/* ---------- 面板 API ---------- */

function mkApi(cfg) {
  return async function api(pathname, { method = 'GET', body = null, timeout = REQ_TIMEOUT } = {}) {
    const url = cfg.panelUrl + PANEL_API_PREFIX + pathname;
    const r = await requestRaw(url, {
      method, body, timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': cfg.serviceId || 'default',
        'X-Tdai-User-Key': cfg.userKey,
      },
    });
    let json = null;
    try { json = JSON.parse(r.body); } catch (_) { }
    const out = { status: r.status, json, raw: r.body };
    // v.ok === true 才是真成功。旧代码用 `status >= 200 && status < 300` 判断，
    // 会把 404 / 业务 4xx 当成功 —— 现统一挂 v，调用方一律判 v.ok。
    out.v = classifyPanel(out);
    out.ok = out.v.ok;
    return out;
  };
}

/* ---------- 采集器：各客户端会话文件 parser ---------- */

// ZCode CLI：~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl
// 已验证映射：用户输入=turn_started.payload.input；最终答复=turn_complete.payload.response。
// 注意：真实文件里事件类型字段是 `type`（不是 `event`）。早期只判 `j.event` 会导致一条都解析不出来，
//       采集静默为空；这里两者都认，并在两侧都缺失时保持静默（不误报）。
function parseZCodeLine(line) {
  let j; try { j = JSON.parse(line); } catch (_) { return []; }
  const out = [];
  const kind = j.type || j.event;
  if (kind === 'turn_started' && j.payload && j.payload.input != null && String(j.payload.input).trim()) {
    out.push({ role: 'user', content: String(j.payload.input) });
  } else if (kind === 'turn_complete' && j.payload && j.payload.response != null && String(j.payload.response).trim()) {
    out.push({ role: 'assistant', content: String(j.payload.response) });
  }
  return out;
}

function zcodeSources() {
  const root = path.join(os.homedir(), '.zcode', 'cli', 'agents');
  let sess = [];
  try { sess = fs.readdirSync(root); } catch (_) { return []; }
  const files = [];
  for (const s of sess) {
    try {
      for (const a of fs.readdirSync(path.join(root, s))) {
        const f = path.join(root, s, a, 'transcript.jsonl');
        try { if (fs.statSync(f).isFile()) files.push(f); } catch (_) { }
      }
    } catch (_) { }
  }
  return files;
}

// Claude Code：~/.claude/projects/<proj>/<sid>.jsonl（标准 messages 数组）
function parseClaudeLine(line) {
  let j; try { j = JSON.parse(line); } catch (_) { return []; }
  const m = j && j.message; if (!m) return [];
  const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
  if (!role) return [];
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    text = m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
  }
  text = text.trim();
  if (!text || text.startsWith('<system-reminder>')) return [];
  return [{ role, content: text }];
}

function claudeSources() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let proj = [];
  try { proj = fs.readdirSync(root); } catch (_) { return []; }
  const files = [];
  for (const p of proj) {
    try {
      for (const f of fs.readdirSync(path.join(root, p))) {
        if (f.endsWith('.jsonl')) files.push(path.join(root, p, f));
      }
    } catch (_) { }
  }
  return files;
}

// ZCode 新版会话：~/.zcode/cli/rollout/model-io-<sess>.jsonl（每行一次模型调用；request.messages 只带历史尾巴，
// 必须按内容哈希去重，否则同一轮对话会随每次调用重复上传）
// 去重集合必须有上限：常驻守护进程里 Set 只增不减 → 长时间运行必然内存泄漏。
// 用 FIFO + 上限做近似 LRU（超出容量淘汰最旧的哈希，牺牲极小概率的重复上传换内存可控）。
const ROLLOUT_SEEN_MAX = 20000;
const rolloutSeen = new Set();
function rolloutHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return 'h' + h.toString(36) + '-' + s.length;
}
function rolloutSeenAdd(h) {
  if (rolloutSeen.has(h)) return false;
  rolloutSeen.add(h);
  if (rolloutSeen.size > ROLLOUT_SEEN_MAX) {
    // Set 保持插入序：删掉最早插入的那批
    const drop = rolloutSeen.size - ROLLOUT_SEEN_MAX;
    let i = 0;
    for (const k of rolloutSeen) { if (i++ >= drop) break; rolloutSeen.delete(k); }
  }
  return true;
}
function rolloutText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
  }
  return '';
}
function parseRolloutLine(line) {
  let j; try { j = JSON.parse(line); } catch (_) { return []; }
  if (j.type !== 'model_io') return [];
  const out = [];
  const msgs = Array.isArray(j.request && j.request.messages) ? j.request.messages : [];
  // 每行只认最新一条真实用户输入（往前找第一条 user，tool 结果回填一律跳过）
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i] || msgs[i].role !== 'user') continue;
    const text = rolloutText(msgs[i].content);
    if (!text || text.startsWith('<system-reminder>') || text.startsWith('<task-notification>')) break;
    if (rolloutSeenAdd(rolloutHash(text))) out.push({ role: 'user', content: text });
    break;
  }
  const reply = j.response && typeof j.response.text === 'string' ? j.response.text.trim() : '';
  if (reply && rolloutSeenAdd(rolloutHash(reply))) out.push({ role: 'assistant', content: reply });
  return out;
}

function rolloutSources() {
  const root = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  let names = [];
  try { names = fs.readdirSync(root); } catch (_) { return []; }
  return names.filter((n) => /^model-io-sess_.*\.jsonl$/.test(n)).map((n) => path.join(root, n));
}

/* ---------- ZCode 会话库（SQLite，权威源） ----------
 * ⚠️ 2026-09-22 新增。zcode 新版把会话历史写进 ~/.zcode/cli/db/db.sqlite
 * （session / message / part 三张表）；agents 下的 transcript.jsonl 只是归档残留，
 * rollout 下的 model-io jsonl 是模型 IO 调试流。只扫这两个目录会漏掉全部近期会话。
 *
 * 本来源是"虚拟来源"：没有真实文件，游标键取 sqlite://zcode-db/<sessionId>，
 * 值里记 msgCount 作为水位 —— 会话追加消息时 msgCount 变大，即可增量补齐。
 */
const ZCODE_DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const ZDB_CURSOR_PREFIX = 'sqlite://zcode-db/';
const ZDB_MIN_NODE = '22.16.0';

let _zdbMod;
function zdbMod() {
  if (_zdbMod !== undefined) return _zdbMod;
  try { _zdbMod = require('node:sqlite'); } catch (_) { _zdbMod = null; }
  return _zdbMod;
}

/* 运行时识别：桌面版把守护作为子进程跑在 Electron 内嵌 Node 里
 * （tdai-hook.cmd 用 `ELECTRON_RUN_AS_NODE=1 TD记忆守护.exe …`），
 * 那个 Node 的版本由 Electron 决定，**与用户系统装的 Node 无关**。
 * Electron 33 → 内嵌 Node 20.18.3 → 没有 node:sqlite。
 * ⚠️ 2026-09-22 真实故障：用户系统是 Node 22，但守护跑在 Electron 里，
 *   zdbQuery 静默 return []，导致 zcode-db 来源"永不推进"，
 *   线上 L0 对话就停在最后一次成功上传的时间，且**界面上一点异常都看不到**。
 *   所以降级状态必须能被 /health 与后台状态暴露出去（zdbStatus）。
 */
function zdbStatus() {
  const v = process.versions || {};
  const isElectron = !!v.electron;
  const label = isElectron
    ? `Electron ${v.electron}（内嵌 Node ${v.node || '未知'}）`
    : `Node ${v.node || '未知'}`;
  if (!zdbMod()) {
    return {
      ok: false, reason: 'no-module', runtime: label, isElectron,
      node: v.node || '', electron: v.electron || '', minNode: ZDB_MIN_NODE,
      dbPath: ZCODE_DB,
      message: isElectron
        ? `守护运行在 ${label}，该运行时不含 node:sqlite（需 Node ≥${ZDB_MIN_NODE}），`
          + 'ZCode 会话库来源无法采集。注意：这与您系统安装的 Node 版本无关。'
        : `守护运行时为 ${label}，不含 node:sqlite（需 ≥${ZDB_MIN_NODE}），ZCode 会话库来源无法采集。`,
    };
  }
  if (!zdbAvailable()) {
    return { ok: false, reason: 'no-db', runtime: label, isElectron, dbPath: ZCODE_DB, message: '' };
  }
  return { ok: true, reason: 'ok', runtime: label, isElectron, dbPath: ZCODE_DB, message: '' };
}

function zdbAvailable() {
  if (!zdbMod()) return false;
  try { return fs.statSync(ZCODE_DB).isFile(); } catch (_) { return false; }
}

// 只读打开 + 查询；任何异常都返回 []（采集静默失败，不炸守护）
// 注意：必须写成 const mod = zdbMod(); new mod.DatabaseSync(...) ——
// 直接 new zdbMod().DatabaseSync(...) 的优先级会踩坑，且异常信息拿不到。
function zdbQuery(sql, params) {
  const mod = zdbMod();
  if (!mod || !zdbAvailable()) return [];
  let db;
  try {
    db = new mod.DatabaseSync(ZCODE_DB, { readOnly: true });
    const st = db.prepare(sql);
    const args = params || [];
    return args.length ? st.all(...args) : st.all();
  } catch (e) {
    logOnce('zdb-query', `zcode-db query failed: ${(e && e.message) || e}`);
    return [];
  } finally {
    try { if (db) db.close(); } catch (_) { }
  }
}

// 同一条错误只记一次，避免 4s 一轮扫描把日志刷爆
const _logOnceSeen = new Set();
function logOnce(key, msg) {
  if (_logOnceSeen.has(key)) return;
  _logOnceSeen.add(key);
  log(msg);
}

// 列出「会话」作为虚拟文件（游标键 = sqlite://zcode-db/<sessionId>）
function zcodeDbSources() {
  if (!zdbAvailable()) return [];
  return zdbQuery('SELECT id FROM session ORDER BY time_created ASC LIMIT 5000').map((r) => ZDB_CURSOR_PREFIX + r.id);
}

// 把一个会话的对话消息按时间序取出：只认 user / assistant 的 text part。
// 过滤掉 metadata.source = 'todo_reminder' 这类系统注入（visibility: model-only），
// 它们不是用户真实输入，传上去是噪音。
function zdbSessionMessages(sid) {
  const rows = zdbQuery(`
    SELECT m.time_created AS ts,
           json_extract(m.data, '$.role') AS role,
           p.data AS part
      FROM message m
      JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
       AND json_extract(m.data, '$.role') IN ('user','assistant')
       AND json_extract(p.data, '$.type') = 'text'
       AND COALESCE(json_extract(m.data, '$.metadata.visibility'), '') <> 'model-only'
     GROUP BY p.id
     ORDER BY m.time_created ASC, p.time_created ASC`, [sid]);

  const out = [];
  for (const r of rows) {
    let text = '';
    try {
      const j = JSON.parse(r.part || '');
      text = String((j && j.text) || '').trim();
    } catch (_) { continue; }
    if (!text) continue;
    // 与其它来源口径一致：系统提醒类内容跳过
    if (text.startsWith('<system-reminder>') || text.startsWith('<task-notification>')) continue;
    const role = r.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: text, ts: new Date(Number(r.ts) || Date.now()).toISOString() });
  }
  return out;
}

// 会话总消息数（游标水位）
function zdbMsgCount(sid) {
  const r = zdbQuery('SELECT COUNT(*) AS c FROM message WHERE session_id = ?', [sid]);
  return (r[0] && Number(r[0].c)) || 0;
}

const SOURCES = {
  'zcode': { list: zcodeSources, parse: parseZCodeLine },
  'zcode-rollout': { list: rolloutSources, parse: parseRolloutLine },
  'claude-code': { list: claudeSources, parse: parseClaudeLine },
  // 虚拟来源：不走"读文件行"通路，由 scanAndUpload / runBackfill 特判处理
  'zcode-db': { list: zcodeDbSources, parse: null, virtual: true },
};

// 虚拟来源（sqlite）的会话 id 解析
function zdbSidOf(key) {
  return String(key || '').replace(ZDB_CURSOR_PREFIX, '');
}

/* ---------- 增量游标 ---------- */

function loadCursors() {
  try { return JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveCursors(c) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CURSORS_PATH, JSON.stringify(c, null, 2)); } catch (_) { }
}

// 读文件新增字节段，返回新增完整行
function readNewLines(file, fromByte) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= fromByte) return { lines: [], size };
    const buf = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buf, 0, buf.length, fromByte);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // 最后一段可能是不完整行：按最后一个 \n 截断，余下字节留给下一轮
    let consumed = fromByte;
    const complete = lines.slice(0, -1);
    consumed += Buffer.byteLength(lines.slice(0, -1).map((l) => l + '\n').join(''), 'utf8');
    return { lines: complete.filter((l) => l.trim()), size, consumed };
  } finally { fs.closeSync(fd); }
}

/* ---------- 本地队列（NAS 离线时积压，恢复后补传） ---------- */

function enqueue(cfg, payload) {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const files = fs.readdirSync(QUEUE_DIR);
    if (files.length >= QUEUE_MAX) { log(`queue full (${files.length}), drop oldest`); files.sort()[0] && fs.unlinkSync(path.join(QUEUE_DIR, files[0])); }
    const name = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(QUEUE_DIR, name), JSON.stringify(payload));
  } catch (e) { log(`enqueue failed: ${e.message}`); }
}

async function flushQueue(cfg, api, state) {
  let names = [];
  try { names = fs.readdirSync(QUEUE_DIR).sort(); } catch (_) { return 0; }
  let pushed = 0;
  for (const n of names) {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, n), 'utf8'));
      const r = await uploadBatch(cfg, api, payload, state);
      if (r) { fs.unlinkSync(path.join(QUEUE_DIR, n)); pushed++; } else break; // 仍离线则停
    } catch (_) { }
  }
  return pushed;
}

/* ---------- 上传 ---------- */

function sliceMessages(messages) {
  return messages.map((m) => ({ ...m, content: m.content.length > MSG_MAX_CHARS ? m.content.slice(0, MSG_MAX_CHARS) : m.content }));
}

// agent 名兜底：来源名派生（面板缺 agent 时尝试自动创建，失败静默）
async function ensureAgent(cfg, api, source, state) {
  if (!cfg.upload.createAgentIfMissing || state.agentCreated[source]) return;
  state.agentCreated[source] = true;
  try {
    await api('/agent/create', { method: 'POST', body: { team_id: cfg.teamId, name: `daemon-${source}`, description: `自动创建：${source} 会话采集` } });
    log(`agent auto-create attempted: daemon-${source}`);
  } catch (_) { }
}

// 解析当前调用者的 user_id（面板按 user key 鉴权，/chat-memory/my-agents 返回的
// uploaded_by_user_id 即 owner 用户）。服务端 /skill/conversation/add 要求 user_id 非空，
// 配置里没有 userId 时必须在这里兜底解析一次（缓存到 state.userId，一次成功终身复用）。
async function ensureUserId(cfg, api, state) {
  if (cfg.userId || state.userId) return;
  try {
    const r = await api('/chat-memory/my-agents', { method: 'POST', body: { team_id: cfg.teamId || undefined } });
    const items = (r.json && r.json.data && r.json.data.items) || [];
    const mine = items.find((x) => x && x.agent_id === cfg.agentId) || items[0];
    const uid = mine && (mine.uploaded_by_user_id || mine.owner_user_id);
    if (uid) { state.userId = String(uid); log(`user_id resolved: ${state.userId}`); }
  } catch (_) { }
}

async function uploadBatch(cfg, api, payload, state) {
  try {
    const r = await api('/chat-memory/import', { method: 'POST', body: payload });
    // 判据统一走 classifyPanel 结论（r.ok），不再看 HTTP 状态码区间 ——
    // 面板会用 "HTTP 400 + message:MISSING_BLOCK_ID/INVALID_INSTANCE" 表达失败，
    // 旧写法 `status>=200&&status<300` 会漏掉这类（虽然 400 本就不在区间内，
    // 但 404 与"HTTP 200 + 非零业务码"会被误判成成功写入）。
    if (r.ok) {
      // 入队 L1 抽取：服务端契约要求 user_id 非空 + messages 全量回传；失败必须留痕，不可静默
      const q = await api('/skill/conversation/add', {
        method: 'POST',
        body: { user_id: cfg.userId || state.userId || '', team_id: payload.team_id, agent_id: payload.agent_id, session_id: payload.session_id, messages: payload.messages },
      });
      if (!q.ok) {
        log(`extract enqueue rejected HTTP ${q.status} ${q.v.key || ''}: ${String((q.json && q.json.message) || q.raw || '').slice(0, 200)}`);
      }
      return true;
    }
    // 可重试：网络层失败 / 5xx / 面板内部错误 / 服务不可用
    if (r.v.retriable || r.status === 0 || r.status >= 500) return false;
    const msg = (r.json && r.json.message) || '';
    if (/agent/i.test(msg)) { await ensureAgent(cfg, api, payload._source || 'zcode', state); return false; }
    // 给日志带上中文可操作提示，别让用户只看到裸的 HTTP 400
    log(`upload rejected HTTP ${r.status}${r.v.key ? ' ' + r.v.key : ''}: ${panelSummary(r.v) || msg.slice(0, 200)}`);
    return 'skip'; // 4xx / 404 不可恢复：放弃本批
  } catch (e) {
    log(`upload error: ${e.message}`);
    return false;
  }
}

/* ---------- 采集上传主流程 ---------- */

async function scanAndUpload(cfg, api, state) {
  const miss = missingConfig(cfg);
  // 采集开关状态与下轮采集时刻都要如实回填给 /health：
  // 控制台守护卡片的「采集上传」行**只**依赖 uploadSources（"开启 N 个来源 / 已关闭"），
  // 早先 /health 不返回该字段 → 该行永远显示 "—"，用户没法判断"守护在线但采集关了 = 零上行"。
  try {
    state.uploadSources = Object.assign({}, (cfg.upload && cfg.upload.enabledSources) || {});
    // 本轮结束后隔一个采集周期再跑下一轮（守护进程与进程内兜底共用同一口径）
    state.nextScanAt = new Date(Date.now() + (SCAN_INTERVAL_MS || 120000)).toISOString();
    saveStatus({ nextScanAt: state.nextScanAt });
  } catch (_) { }
  if (miss) { log(`config incomplete: ${miss}`); return { pushed: 0 }; }
  // user_id 兜底：配置未填 userId 时，先解析一次（conversation/add 契约要求非空）
  await ensureUserId(cfg, api, state);
  const cursors = loadCursors();
  let pushed = 0;

  for (const [source, def] of Object.entries(SOURCES)) {
    if (!cfg.upload.enabledSources[source]) continue;
    let files;
    try { files = def.list(); } catch (_) { continue; }

    // 虚拟来源（zcode-db）：没有文件，游标键是 sessionId，水位是消息条数
    if (def.virtual) {
      for (const key of files) {
        const sid = zdbSidOf(key);
        const cur = cursors[key];
        let cnt = 0;
        try { cnt = zdbMsgCount(sid); } catch (_) { continue; }
        if (!cur) { cursors[key] = { size: cnt, source, seeded: true }; continue; }
        if (cnt <= (cur.size || 0)) continue;          // 无新增
        let msgs = [];
        try { msgs = zdbSessionMessages(sid); } catch (_) { continue; }
        // 只补发"新增的那部分"：水位之前的已经传过
        const fresh = msgs.slice(Math.max(0, cur.size || 0));
        cursors[key] = { size: cnt, source, seeded: true };
        if (!fresh.length) continue;
        const payload = {
          team_id: cfg.teamId,
          agent_id: cfg.agentId,
          session_id: `${source}-${sid}`.slice(0, 120),
          messages: sliceMessages(fresh),
          _source: source,
        };
        const r = await uploadBatch(cfg, api, payload, state);
        if (r === true) { pushed++; state.lastPush = new Date().toISOString(); saveStatus({ lastPush: state.lastPush }); }
        else if (r === false) enqueue(cfg, payload);
      }
      continue;
    }

    for (const file of files) {
      const cur = cursors[file];
      let size;
      try { size = fs.statSync(file).size; } catch (_) { continue; }

      // 首次发现：按当前大小做种子，不回传历史
      if (!cur) { cursors[file] = { size, source, seeded: true }; continue; }
      if (size < cur.size) { cursors[file] = { size, source, seeded: true }; continue; } // 文件轮转/缩短：重置种子
      if (size === cur.size) continue;

      const { lines, consumed } = readNewLines(file, cur.size);
      const msgs = [];
      for (const line of lines) {
        try { msgs.push(...def.parse(line)); } catch (_) { }
      }
      cursors[file] = { size: consumed != null ? consumed : cur.size, source, seeded: true };
      if (!msgs.length) continue;

      const session = path.basename(file).replace(/\.jsonl$/, '') + '-' + path.basename(path.dirname(file));
      const payload = {
        team_id: cfg.teamId,
        agent_id: cfg.agentId,
        session_id: `${source}-${session}`.slice(0, 120),
        messages: sliceMessages(msgs.map((m) => ({ ...m, ts: new Date().toISOString() }))),
        _source: source,
      };
      const r = await uploadBatch(cfg, api, payload, state);
      if (r === true) { pushed++; state.lastPush = new Date().toISOString(); saveStatus({ lastPush: state.lastPush }); }
      else if (r === false) enqueue(cfg, payload);
      // r === 'skip'：4xx 放弃
    }
  }
  saveCursors(cursors);
  if (pushed) log(`scan: pushed ${pushed} session batches`);
  return { pushed };
}

/* ---------- 可上传清单（供控制台"手动选择上传"弹窗） ----------
 * 把三个来源的内容按「agent」归组，每组给出：名称、来源、条目数、消息数、最近时间。
 * 供弹窗列出可勾选项；勾选后把选中的 agent id 传回 /api/backfill 的 targets。
 */
function agentInventory(cfg) {
  const cursors = loadCursors();
  const backfilled = loadBackfilled();
  const groups = new Map();   // key -> group

  const put = (key, patch) => {
    const g = groups.get(key) || {
      key, name: '', source: patch.source, items: 0, msgs: 0,
      lastTs: 0, backfilledItems: 0, cursorItems: 0,
    };
    Object.assign(g, patch);
    groups.set(key, g);
  };

  // ① sqlite 会话库：按 zcode 工作目录（= 项目）归组，这才是用户心里的"agent"
  if (zdbAvailable()) {
    const rows = zdbQuery(`
      SELECT s.id AS sid, s.title AS title, s.directory AS dir,
             COALESCE(s.time_updated, s.time_created) AS upd,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs
        FROM session s ORDER BY upd DESC`);
    for (const r of rows) {
      const dir = String(r.dir || '').replace(/[\\/]+$/, '');
      const name = dir.split(/[\\/]/).pop() || '未命名';
      const key = 'zcode:' + (dir || name);
      const g = groups.get(key) || {
        key, name, source: 'zcode', items: 0, msgs: 0, lastTs: 0,
        backfilledItems: 0, cursorItems: 0, dir,
      };
      g.items++;
      g.msgs += Number(r.msgs) || 0;
      g.lastTs = Math.max(g.lastTs, Number(r.upd) || 0);
      if (backfilled[ZDB_CURSOR_PREFIX + r.sid]) g.backfilledItems++;
      if (cursors[ZDB_CURSOR_PREFIX + r.sid]) g.cursorItems++;
      groups.set(key, g);
    }
  }

  // ② 文件来源：按"来源 + 会话目录"归组
  for (const [src, def] of Object.entries(SOURCES)) {
    if (def.virtual) continue;
    let files = [];
    try { files = def.list(); } catch (_) { continue; }
    for (const f of files) {
      const dir = path.dirname(f);
      const key = src + ':' + dir;
      const g = groups.get(key) || {
        key, name: path.basename(dir) || src, source: src, items: 0, msgs: 0,
        lastTs: 0, backfilledItems: 0, cursorItems: 0, dir,
      };
      g.items++;
      let st = null; try { st = fs.statSync(f); } catch (_) { }
      if (st) {
        g.msgs += Math.max(1, Math.round(st.size / 3072));
        g.lastTs = Math.max(g.lastTs, st.mtimeMs);
      }
      if (backfilled[f]) g.backfilledItems++;
      if (cursors[f]) g.cursorItems++;
      groups.set(key, g);
    }
  }

  const items = Array.from(groups.values())
    .filter((g) => g.items > 0)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map((g) => ({
      key: g.key, name: g.name, source: g.source, dir: g.dir || '',
      items: g.items, msgs: g.msgs, lastTs: g.lastTs,
      pending: Math.max(0, g.items - g.backfilledItems),
      backfilledItems: g.backfilledItems,
    }));

  return {
    ok: true,
    items,
    total: {
      groups: items.length,
      items: items.reduce((n, g) => n + g.items, 0),
      pending: items.reduce((n, g) => n + g.pending, 0),
      msgs: items.reduce((n, g) => n + g.msgs, 0),
    },
    sources: Object.keys(SOURCES),
    backfilledFiles: Object.keys(backfilled).length,
  };
}

/* ---------- 本地缓存固定块（persona + skill 目录） ---------- */

function mkCache(cfg, api) {
  const cache = {
    skills: '',
    ts: 0,
    async refresh() {
      if (Date.now() - cache.ts < CACHE_TTL_MS) return;
      try {
        const s = await api('/skill/list', { method: 'POST', body: { team_id: cfg.teamId } });
        if (s.ok && s.json && s.json.data) {
          const items = s.json.data.items || s.json.data || [];
          const names = Array.isArray(items) ? items.map((x) => x && (x.name || x.skill_name)).filter(Boolean).slice(0, 30) : [];
          cache.skills = names.length ? names.join('、') : '';
        }
        cache.ts = Date.now();
      } catch (_) { cache.ts = Date.now(); } // 失败也记账，避免每轮打 NAS
    },
  };
  return cache;
}

/* ---------- recall 组装 ---------- */

function hasIntent(q) {
  const lower = q.toLowerCase();
  return INTENT_WORDS.some((w) => lower.includes(w));
}

async function buildRecall(cfg, api, cache, query) {
  const parts = [];
  if (cache.skills) parts.push(`【团队技能目录】${cache.skills}`);
  if (!cfg.panelUrl || !cfg.userKey) return parts.join('\n');

  // recallAlways=true：每条消息都检索（不做意图过滤）；否则仅回忆类提问触发
  const always = cfg.recallAlways === true || String(cfg.recallAlways) === 'true';
  if (query && (always || hasIntent(query))) {
    try {
      const r = await requestRaw(cfg.panelUrl + PANEL_API_PREFIX + '/chat-memory/search', {
        method: 'POST', timeout: RECALL_TIMEOUT_MS - 100,
        headers: { 'Content-Type': 'application/json', 'X-Tdai-Service-Id': cfg.serviceId || 'default', 'X-Tdai-User-Key': cfg.userKey },
        body: { query: String(query).slice(0, 500), top_k: 5, block_id: cfg.blockId || 'chat-memory', team_id: cfg.teamId || undefined, agent_id: cfg.agentId || undefined },
      });
      // 走统一判定：recall 路径早先也只看 HTTP 2xx，一个 404（端点变更）会被当成功但解析出空 items，
      // 表现为"记忆检索永远为空"却查不出原因。
      const rv = classifyPanel({ status: r.status, raw: r.body });
      if (rv.ok) {
        const items = (rv.json && rv.json.data && rv.json.data.items) || [];
        if (items.length) {
          const lines = items.map((it) => {
            const text = (it.content || it.text || it.summary || '').toString();
            return `- ${text.slice(0, 400)}`;
          });
          parts.unshift(`【相关团队记忆】\n${lines.join('\n')}`);
        }
      }
    } catch (_) { /* 静默降级 */ }
  }
  return parts.join('\n\n');
}

/* ---------- 控制台 API：配置读写 / 连接测试 / Agent 接入状态 / 更新检查 ---------- */

// UserPromptSubmit hook 检测（与 pet/src/register.js 的 hookState、core/clients.js 同口径）。
// 返回 { present, legacy }：present = 确实挂了本工具的 hook（新旧写法都算）；
// legacy = 旧写法（tdai-daemon.js/.cjs + node.exe），建议关→开切到本应用。
//
// ⚠️ 本文件必须保持**单文件自包含**（要能被 SEA 打包成独立 exe，不能 require 外部模块），
// 所以这里不能直接 require core/clients.js —— 常量只能内联一份。
// 代价是存在"三处字面量"的漂移风险，因此 test/clients-consistency.test.js 里
// 专门断言 daemon 的 HOOK 常量与 core/clients.js 完全一致；改一处必须改三处。
const HOOK_MARK = 'tdai-hook.cmd';
const HOOK_LEGACY_MARKS = ['tdai-daemon.js', 'tdai-daemon.cjs'];
function hookStateOf(file) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { present: false, legacy: false }; }
  const arr = (s && s.hooks && s.hooks.UserPromptSubmit) || [];
  const text = JSON.stringify(arr);
  const present = text.includes(HOOK_MARK) || HOOK_LEGACY_MARKS.some((m) => text.includes(m));
  return { present, legacy: present && !text.includes(HOOK_MARK) };
}

// agent 接入状态：fs 检测各客户端配置（installed=已接入 / absent=客户端未安装 / missing=未接入）
//
// ⚠️ 本函数的客户端清单必须与 core/clients.js 保持一致，但本文件不能 require 它
// （单文件自包含，要能 SEA 打包）。故这里用**表驱动**内联一份最小清单：
// 只要客户端集合变化，必须同时改 core/clients.js 与下面这张表 ——
// test/clients-consistency.test.js 的 ⑨ 组会逐个断言两边覆盖的客户端完全一致。
// （早先这里是 5 段手写 if，漏了 Trae 与 DeepSeek Harness：
//   网页控制台只显示 4 个客户端，桌面应用显示 6 个 —— 用户看到的接入状态是残的。）
function agentStatus() {
  const home = os.homedir();
  const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

  // MCP 条目是否已写入该客户端配置：kind 决定判定方式（与 core/clients.js 的语义对齐）
  const mcpInstalled = (kind, file, opts) => {
    const o = opts || {};
    if (kind === 'toml') {
      const t = readText(file);
      return t == null ? 'absent' : (t.includes(`[${o.tomlSection || 'mcp_servers.tdai'}]`) ? 'installed' : 'missing');
    }
    if (kind === 'dsh-patch') {
      // patch 层：只要有 profile 的 cordis.patch.yml 里含标记即算已接入
      let profiles = [];
      try { profiles = fs.readdirSync(file).filter((n) => n !== 'node_modules'); } catch (_) { return 'absent'; }
      const mark = o.patchMark || 'dsh-mcp-client';
      for (const p of profiles) {
        const t = readText(path.join(file, p, 'cordis.patch.yml'));
        if (t && t.includes(mark)) return 'installed';
      }
      return 'missing';
    }
    if (kind === 'yaml') {
      // Hermes：块定位判定（与 register.js 的写入标记同源：2 空格缩进的子键）
      const t = readText(file);
      if (t == null) return 'absent';
      return new RegExp('^\\s{2}' + (o.yamlLeaf || 'tdai') + ':', 'm').test(t) ? 'installed' : 'missing';
    }
    if (kind === 'opencode') {
      // OpenCode：字段 'mcp'，且 command 是数组 —— 用"存在且 command 为数组"当已接入判据
      const c = readJSON(file);
      if (c == null) return 'absent';
      const parts = String(o.pointer || '/mcp/tdai').split('/').filter(Boolean);
      let cur = c;
      for (const p of parts) { if (!cur || typeof cur !== 'object') return 'missing'; cur = cur[p]; }
      return cur && Array.isArray(cur.command) ? 'installed' : 'missing';
    }
    // json / json-nested：按 pointer 取值（父路径缺失即视为未接入）
    const c = readJSON(file);
    if (c == null) return 'absent';
    const parts = String(o.pointer || '/mcpServers/tdai').split('/').filter(Boolean);
    const leaf = parts.pop();
    let cur = c;
    for (const p of parts) { if (!cur || typeof cur !== 'object') return 'missing'; cur = cur[p]; }
    return cur && cur[leaf] ? 'installed' : 'missing';
  };

  // 客户端清单（与 core/clients.js 对齐；含 probe 用于"客户端是否装了"）
  // ⚠️ 本列表是 core/clients.js 的**内联副本**（SEA 单文件要求，不能 require）。
  //    改一边必须改另一边 —— `test/clients-consistency.test.js` ⑨ 会拦漂移。
  //    路径分段用 CLIENT_PATHS 的同一种写法（'x/y/z' 正斜杠），方便逐字比对。
  const CLIENTS_MIN = [
    { name: 'ZCode CLI', kind: 'json-nested', probe: path.join(home, '.zcode'), file: path.join(home, '.zcode', 'cli', 'config.json'), pointer: '/mcp/servers/tdai', hookFile: path.join(home, '.zcode', 'cli', 'config.json') },
    { name: 'Claude Code', kind: 'json', probe: path.join(home, '.claude.json'), file: path.join(home, '.claude.json'), pointer: '/mcpServers/tdai', hookFile: path.join(home, '.claude', 'settings.json') },
    { name: 'Cursor', kind: 'json', probe: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json'), pointer: '/mcpServers/tdai' },
    { name: 'Codex', kind: 'toml', probe: path.join(home, '.codex', 'config.toml'), file: path.join(home, '.codex', 'config.toml'), tomlSection: 'mcp_servers.tdai' },
    { name: 'Trae', kind: 'json', probe: path.join(home, '.trae'), file: path.join(home, '.trae', 'mcp.json'), pointer: '/mcpServers/tdai' },
    { name: 'DeepSeek Harness', kind: 'dsh-patch', probe: path.join(home, '.dsh'), file: path.join(home, '.dsh', 'profiles'), patchMark: 'dsh-mcp-client' },
    { name: 'CodeBuddy', kind: 'json', probe: path.join(home, '.codebuddy'), file: path.join(home, '.codebuddy', '.mcp.json'), pointer: '/mcpServers/tdai' },
    { name: 'WorkBuddy', kind: 'json', probe: path.join(home, '.workbuddy-ai'), file: path.join(home, '.workbuddy-ai', 'mcp.json'), pointer: '/mcpServers/tdai' },
    { name: 'OpenCode', kind: 'opencode', probe: path.join(home, '.config', 'opencode'), file: path.join(home, '.config', 'opencode', 'opencode.json'), pointer: '/mcp/tdai' },
    { name: 'Hermes', kind: 'yaml', probe: path.join(home, '.hermes'), file: path.join(home, '.hermes', 'config.yaml'), yamlTop: 'mcp_servers', yamlLeaf: 'tdai' },
    { name: 'OpenClaw', kind: 'json-nested', probe: path.join(home, '.openclaw'), file: path.join(home, '.openclaw', 'openclaw.json'), pointer: '/mcp/servers/tdai' },
    { name: 'Pi', kind: 'json', probe: path.join(home, '.pi'), file: path.join(home, '.pi', 'agent', 'mcp.json'), pointer: '/mcpServers/tdai' },
  ];

  const items = [];
  for (const cl of CLIENTS_MIN) {
    // 客户端目录/文件不存在 → absent（未装该客户端），与桌面端口径一致
    if (!fs.existsSync(cl.probe)) { items.push({ name: cl.name, status: 'absent' }); continue; }
    const st = mcpInstalled(cl.kind, cl.file, cl);
    const rec = { name: cl.name, status: st };
    // hook 状态只对有 hook 的客户端显示（ZCode CLI / Claude Code）
    // 注：「旧写法」= 直接 `node daemon.js hook`，对**源码/CLI 用户**其实是正确的形态
    // （他们的 register-all.cjs 就是这么写的）；提示"建议切换"是给 exe 用户看的
    // （exe 用户该走 .cmd 包装的 tdai-hook.cmd）。守护进程无法判断用户属于哪一类，
    // 故统一给出中性提示，不误报为"未注入"。
    if (cl.hookFile) {
      const hs = hookStateOf(cl.hookFile);
      if (hs.present) rec.detail = hs.legacy ? 'hook 已注入（脚本写法，exe 用户建议关→开切换）' : 'hook 已注入';
    }
    items.push(rec);
  }

  // 指令文件（档 B 兜底）：与 register.js 的 INSTR_TARGETS 同源（.zcode/AGENTS.md + .claude/CLAUDE.md）
  const inst1 = readText(path.join(home, '.zcode', 'AGENTS.md'));
  const inst2 = readText(path.join(home, '.claude', 'CLAUDE.md'));
  items.push({ name: '全局指令文件', status: (inst1 && inst1.includes('tdai-memory:begin')) || (inst2 && inst2.includes('tdai-memory:begin')) ? 'installed' : 'missing' });

  return items;
}

// 更新检查：GitHub 最新 release vs 当前版本
async function updateCheck() {
  try {
    const r = await requestRaw(REPO_API, { timeout: 8000, headers: { 'User-Agent': 'tdai-daemon' } });
    if (r.status !== 200) return { latest: null, current: APP_VER, upToDate: null };
    const j = JSON.parse(r.body);
    const latest = (j.tag_name || '').replace(/^v/, '');
    const gt = (a, b) => {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
      return false;
    };
    return { latest: latest || null, current: APP_VER, upToDate: latest ? !gt(latest, APP_VER) : null, downloadUrl: j.html_url || null };
  } catch (_) {
    return { latest: null, current: APP_VER, upToDate: null }; // 离线静默：null = 未知
  }
}

// 配置读（脱敏 userKey）写（白名单字段，跑前备份）
function readPublicConfig(cfg) {
  const key = cfg.userKey || '';
  return {
    panelUrl: cfg.panelUrl || '',
    teamId: cfg.teamId || '',
    agentId: cfg.agentId || '',
    taskId: cfg.taskId || '',
    blockId: cfg.blockId || '',
    userKeyMasked: key ? key.slice(0, 7) + '***' + key.slice(-4) : '',
    hasUserKey: !!key,
    uploadSources: cfg.upload && cfg.upload.enabledSources ? cfg.upload.enabledSources : {},
    recallAlways: cfg.recallAlways === true || String(cfg.recallAlways) === 'true',
  };
}

function writeConfig(body) {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { }
  const whitelist = ['panelUrl', 'userKey', 'teamId', 'agentId', 'taskId', 'blockId'];
  for (const k of whitelist) {
    if (typeof body[k] === 'string' && body[k].trim()) disk[k] = body[k].trim();
  }
  // recallAlways：布尔可写（记忆策略开关），字符串 'true'/'false' 也可
  if (typeof body.recallAlways === 'boolean') disk.recallAlways = body.recallAlways;
  else if (body.recallAlways === 'true' || body.recallAlways === 'false') disk.recallAlways = body.recallAlways === 'true';
  fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
  try { fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak'); } catch (_) { }
  fs.writeFileSync(CFG_PATH, JSON.stringify(disk, null, 2));
  return loadConfig();
}

// 控制台页：SEA 内嵌资源优先，开发态回退磁盘
function consolePage() {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      const asset = sea.getAsset('console.html');
      return Buffer.from(asset).toString('utf8'); // getAsset 返回 ArrayBuffer
    }
  } catch (_) { }
  try { return fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8'); } catch (_) { return '<h1>console.html 缺失</h1>'; }
}

/* ---------- HTTP 服务（:8100） ---------- */

// 本地服务的所有 POST body 收敛到一个小上限：这是 127.0.0.1 的内部接口，
// 没有理由接收大 body；无限累积字符串既浪费内存也给了本机进程打爆守护的机会。
const LOCAL_BODY_MAX = 256 * 1024;

// 统一的 body 读取：限长 + 超限即断 + 解析失败给明确错误（不再静默吞掉）
function readBody(req, res, limit) {
  return new Promise((resolve) => {
    const max = limit || LOCAL_BODY_MAX;
    let body = '';
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      body += c;
      if (body.length > max) {
        aborted = true;
        log(`local body too large (>${max}B) on ${req.url}`);
        try { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请求体过大' })); } catch (_) { }
        try { req.destroy(); } catch (_) { }
        resolve({ ok: false, error: 'too large' });
      }
    });
    req.on('error', () => { if (!aborted) { aborted = true; resolve({ ok: false, error: 'request error' }); } });
    req.on('end', () => { if (!aborted) resolve({ ok: true, body }); });
  });
}

function jsonRes(res, code, obj) {
  try {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  } catch (_) {
    try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"ok":false,"error":"serialize failed"}'); } catch (_) { }
  }
}

function mkState() {
  // lastPush 优先从持久化的 status.json 恢复（守护重启/升级后，"最近上传"不能归零）
  const saved = loadStatus();
  return {
    startedAt: new Date().toISOString(), hookCalls: 0,
    lastPush: saved.lastPush || '', nextScanAt: saved.nextScanAt || '',
    agentCreated: {}, queue: 0, nas: null,
    // 下轮采集时刻的权威来源：由采集循环每轮结束写入（见 scanAndUpload / markNextScan）。
    // 早先只有 main() 内的定时器回调写它，而 main() 里 setInterval 第一次触发要等满
    // 一个 SCAN_INTERVAL_MS，期间 /health 一直在吐 status.json 里的陈旧值。
    uploadSources: null,
  };
}

function startServer(cfg, api, cache, state) {
  const server = http.createServer(async (req, res) => {
    // URL 解析失败的请求（畸形 path）必须在 try 之外先兜住，否则连 400 都发不出去
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (_) { try { res.writeHead(400); res.end(); } catch (_) { } return; }
    try {
      if (u.pathname === '/' || u.pathname === '/console') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(consolePage());
        return;
      }
      if (u.pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(readPublicConfig(cfg)));
        return;
      }
      if (u.pathname === '/api/config/save' && req.method === 'POST') {
        // 用 readBody 统一兜底：早先 req.on('end') 里的 async 回调一旦在 catch 之外抛出
        // （例如 writeConfig 之外的操作），异常会逃逸出外层 try/catch，导致响应永不返回。
        const rb = await readBody(req, res);
        if (!rb.ok) return;
        try {
          const nc = writeConfig(JSON.parse(rb.body || '{}'));
          Object.assign(cfg, { panelUrl: nc.panelUrl, userKey: nc.userKey, teamId: nc.teamId, agentId: nc.agentId, taskId: nc.taskId, blockId: nc.blockId || cfg.blockId });
          jsonRes(res, 200, { ok: true, config: readPublicConfig(loadConfig()) });
        } catch (e) {
          jsonRes(res, 400, { ok: false, error: (e && e.message) || String(e) });
        }
        return;
      }
      if (u.pathname === '/api/test-connection' && req.method === 'POST') {
        const t0 = Date.now();
        let nas = false, auth = false, hint = '';
        let code, codeKey, kind;
        if (cfg.panelUrl && cfg.userKey) {
          try {
            // ⚠️ 必须打 /chat-memory/my-agents（检索面端点，**真的校验 userKey**）。
            //   实测：/skill/list 与 /meta/auth/verify 对坏 key 都返回 HTTP 200 + code:0，
            //   用它们探活会让 auth 恒为 true —— "连接正常"但检索/上传全静默失败。
            //   口径与 core/tdai-core.js health()、pet main.js testConn 必须一致。
            const r = await api('/chat-memory/my-agents', { method: 'POST', body: { team_id: cfg.teamId || undefined }, timeout: 8000 });
            const v = r.v;
            // nas = 面板这家服务活着（拿到 4xx/404 也算活着）；auth = 真鉴权通过
            nas = r.ok || (v.status >= 100 && v.status < 500);
            auth = r.ok;
            hint = auth ? '' : (panelSummary(v) || '');
            code = v.code; codeKey = v.key || ''; kind = v.kind || '';
          } catch (e) { hint = `面板不可达 (${e.message})`; }
        } else hint = '请先填写 panelUrl 和 userKey';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ nas, auth, latencyMs: Date.now() - t0, hint, code, codeKey, kind }));
        return;
      }
      if (u.pathname === '/api/agents-status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items: agentStatus() }));
        return;
      }
      if (u.pathname === '/api/update-check') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(await updateCheck()));
        return;
      }
      if (u.pathname === '/health') {
        let queueLen = 0;
        try { queueLen = fs.readdirSync(QUEUE_DIR).length; } catch (_) { }
        // nas = 面板是否可达（4xx/404 也算可达）；auth = 真鉴权通过。
        // /skill/list 对坏 key 返回 200/code:0，**不能**用来判 auth（曾经就是这么错的）。
        let nas = null, auth = null;
        if (cfg.panelUrl && cfg.userKey) {
          try {
            const r = await api('/chat-memory/my-agents', { method: 'POST', body: { team_id: cfg.teamId || undefined }, timeout: 5000 });
            nas = r.ok || (r.v.status >= 100 && r.v.status < 500);
            auth = r.ok;
          } catch (_) { nas = false; auth = false; }
        }
        // uploadSources：控制台守护卡片「采集上传」行的唯一依据。
        // 优先用 state 里由采集循环回填的值（反映真实运行态）；state 尚未回填时
        // 直接从当前配置现算 —— 老守护不返回该字段、这里也绝不返回 undefined。
        const uploadSources = state.uploadSources
          || Object.assign({}, (cfg.upload && cfg.upload.enabledSources) || {});
        // nextScanAt：优先 state（采集循环每轮回填），退回持久化值；都没有则按"现在 + 一个周期"估算
        const nextScanAt = state.nextScanAt || loadStatus().nextScanAt || '';
        // zdb：ZCode 会话库来源（虚拟来源）的可用性。
        // ⚠️ 必须暴露：守护跑在 Electron 内嵌 Node（< 22.16）时该来源**永远采不到**，
        //   早先静默 return []，用户只看到"线上对话停在某时刻"，界面上零线索。
        jsonRes(res, 200, {
          local: true, nas, auth, configOk: !missingConfig(cfg), version: APP_VER,
          hookCalls: state.hookCalls, lastPush: state.lastPush, queueLen,
          uptimeSince: state.startedAt, nextScanAt, uploadSources,
          zdb: zdbStatus(),
        });
        return;
      }
      if (u.pathname === '/recall') {
        state.hookCalls++;
        const q = u.searchParams.get('q') || '';
        const text = await buildRecall(cfg, api, cache, q);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end((text || '').slice(0, RECALL_CLIP));
        return;
      }
      if (u.pathname === '/push' && req.method === 'POST') {
        const r = await scanAndUpload(cfg, api, state);
        const q = await flushQueue(cfg, api, state);
        // 手动 push 也算"刚采集过"：把下轮采集时刻顺延一个周期，
        // 否则控制台倒计时会停在 push 之前的旧值上（看起来像卡住）。
        try {
          state.nextScanAt = new Date(Date.now() + (SCAN_INTERVAL_MS || 120000)).toISOString();
          saveStatus({ nextScanAt: state.nextScanAt });
        } catch (_) { }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ pushed: r.pushed, queueFlushed: q }));
        return;
      }
      // 可上传清单：控制台"一键上传本地记忆"弹窗用它列出可选 agent
      if (u.pathname === '/api/backfill/inventory') {
        let inv;
        try { inv = agentInventory(cfg); } catch (e) { inv = { ok: false, error: (e && e.message) || String(e) }; }
        jsonRes(res, inv.ok ? 200 : 500, inv);
        return;
      }
      if (u.pathname === '/api/backfill' && req.method === 'POST') {
        const rb = await readBody(req, res);
        if (!rb.ok) return;
        let opts = {};
        try { opts = JSON.parse(rb.body || '{}'); } catch (_) { }
        if (!opts || typeof opts !== 'object') opts = {};
        // startBackfill 自身会同步返回，但 runBackfill 是异步跑的：
        // 这里显式再包一层 catch，任何同步抛出都不至于让响应悬空。
        let r;
        try {
          r = startBackfill(cfg, api, state, {
            source: opts.source || '',
            filter: opts.filter || '',
            targets: Array.isArray(opts.targets) ? opts.targets : [],
          });
        } catch (e) {
          r = { ok: false, error: (e && e.message) || String(e) };
        }
        jsonRes(res, r.ok ? 200 : 409, r);
        return;
      }
      if (u.pathname === '/api/backfill') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(backfillStatus()));
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) {
      log(`http error: ${e.message}`);
      try { res.writeHead(500); res.end(); } catch (_) { }
    }
  });
  // 端口被占用（本机已有 daemon/exe 在跑）时 reject，交给调用方降级，不直接崩溃
  return new Promise((resolve, reject) => {
    const onListenError = (e) => reject(e);
    server.once('error', onListenError);
    server.listen(RECALL_PORT, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      // 运行时错误不能只写日志：客户端异常断连（ECONNRESET/EPIPE）在这里高频出现，
      // 抛出去就是未捕获异常 → 整个守护进程退出。全部收敛为日志。
      server.on('error', (e) => { try { log(`server error: ${e && e.code} ${e && e.message}`); } catch (_) { } });
      server.on('clientError', (e, socket) => {
        try { log(`client error: ${e && e.code}`); } catch (_) { }
        try { socket.destroy(); } catch (_) { }
      });
      log(`daemon listening on http://127.0.0.1:${RECALL_PORT}`);
      resolve(server);
    });
  });
}

/* ---------- hook 子命令：stdin / --q → /recall → stdout ---------- */

async function runHook() {
  let q = '';
  const argv = process.argv.slice(3);
  const qi = argv.indexOf('--q');
  if (qi >= 0) q = argv[qi + 1] || '';
  if (!q && !process.stdin.isTTY) {
    q = await new Promise((resolve) => {
      const chunks = []; let done = false;
      const finish = () => { if (!done) { done = true; try { process.stdin.destroy(); } catch (_) { } resolve(Buffer.concat(chunks).toString('utf8')); } };
      process.stdin.on('data', (c) => { chunks.push(c); });
      process.stdin.on('end', finish);
      setTimeout(finish, 300); // hook 场景 stdin 可能不关，限时收数
    });
    try { const j = JSON.parse(q); q = j.prompt || j.user_prompt || j.input || q; } catch (_) { }
  }
  q = q.trim();
  try {
    const r = await requestRaw(`http://127.0.0.1:${RECALL_PORT}/recall?q=${encodeURIComponent(q)}`, { timeout: RECALL_TIMEOUT_MS });
    if (r.status === 200 && r.body) process.stdout.write(r.body);
  } catch (_) { /* 静默：hook 失败绝不阻塞对话 */ }
}

/* ---------- 历史回传（backfill）：CLI 子命令与控制台按钮共用 ---------- */
// 正常采集只回传「首次发现之后」的增量，历史内容须用本流程补。
// 已回传文件记入 backfill.json 防重复（重复运行/连点按钮不会重复上传）。

const BACKFILL_PATH = path.join(DATA_DIR, 'backfill.json');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const bfJob = { running: false, startedAt: '', source: '', filter: '', targets: [], files: 0, filesDone: 0, msgs: 0, current: '', error: '', doneAt: '' };

// 跨重启保留的运行状态：最近上传时间 + 下轮采集时刻。
// 守护重启/升级后，控制台"最近上传"不能又变回"尚未上传"、"下次采集"不能归零。
function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveStatus(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const cur = loadStatus();
    fs.writeFileSync(STATUS_PATH, JSON.stringify(Object.assign(cur, patch || {}), null, 2));
  } catch (_) { }
}

function loadBackfilled() {
  try { return JSON.parse(fs.readFileSync(BACKFILL_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveBackfilled(m) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BACKFILL_PATH, JSON.stringify(m, null, 2)); } catch (_) { }
}

function backfillStatus() {
  return Object.assign({}, bfJob, { backfilledFiles: Object.keys(loadBackfilled()).length });
}

// targets 来自控制台弹窗勾选的 agent key，形如 "zcode:~/projects/demo-app" / "claude-code:<dir>"。
// key 空数组 = 不限制（= 全部上传）。
//
// 统一语义：target = "<来源>:<目录>"。命中规则 = 目录完全相同，或互为子路径。
// 这样既支持"整个项目目录"，也支持"某个子目录"，不会因为路径分隔符差异而漏配。
function normDir(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
function targetsMatchDir(targets, src, dir) {
  if (!targets || !targets.length) return true;
  const d = normDir(dir);
  for (const t of targets) {
    const s = String(t);
    const i = s.indexOf(':');
    const tSrc = i < 0 ? '' : s.slice(0, i);
    const tVal = i < 0 ? s : s.slice(i + 1);
    if (tSrc && tSrc !== src) continue;
    if (!tVal) return true;                    // 只写了来源：整源放行
    const v = normDir(tVal);
    if (!d) continue;
    if (d === v || d.startsWith(v + '/') || v.startsWith(d + '/')) return true;
  }
  return false;
}

async function runBackfill(cfg, api, state, { source = '', filter = '', targets = [] } = {}) {
  const backfilled = loadBackfilled();
  const targetList = Array.isArray(targets) ? targets.filter(Boolean) : [];
  const sources = source ? [source] : Object.keys(SOURCES);
  bfJob.running = true; bfJob.startedAt = new Date().toISOString();
  bfJob.source = source || 'all'; bfJob.filter = filter; bfJob.targets = targetList;
  bfJob.files = 0; bfJob.filesDone = 0; bfJob.msgs = 0; bfJob.current = ''; bfJob.error = ''; bfJob.doneAt = '';
  try {
    for (const src of sources) {
      const def = SOURCES[src];
      if (!def) { bfJob.error = `未知来源: ${src}`; continue; }
      let files = [];
      try { files = def.list().filter((f) => !filter || f.includes(filter)); } catch (_) { }
      bfJob.files += files.length;

      // 虚拟来源（zcode-db）：按 sessionId 取全量消息，一次性回传
      if (def.virtual) {
        // 目标筛选需要工作目录，这里一次性把 session -> directory 映射取出来
        let dirOf = {};
        if (targetList.length) {
          for (const r of zdbQuery('SELECT id, directory FROM session')) dirOf[r.id] = String(r.directory || '');
        }
        for (const key of files) {
          if (bfJob.error) break;
          if (backfilled[key]) { bfJob.filesDone++; continue; }
          const sid = zdbSidOf(key);
          // 勾选过滤：目标是 "zcode:<工作目录>"，与 session.directory 比对
          if (targetList.length && !targetsMatchDir(targetList, src, dirOf[sid] || '')) { bfJob.filesDone++; continue; }
          bfJob.current = sid;
          let msgs = [];
          try { msgs = zdbSessionMessages(sid); } catch (_) { continue; }
          if (msgs.length) {
            for (let i = 0; i < msgs.length; i += 50) {
              const payload = {
                team_id: cfg.teamId,
                agent_id: cfg.agentId,
                session_id: `backfill-${src}-${sid}`.slice(0, 120),
                messages: sliceMessages(msgs.slice(i, i + 50)),
                _source: src,
              };
              const r = await uploadBatch(cfg, api, payload, state);
              if (r === 'skip') { bfJob.error = `${sid} 上传被拒绝（4xx），放弃该会话`; break; }
              bfJob.msgs += payload.messages.length;
            }
          }
          if (!bfJob.error) {
            backfilled[key] = { msgs: msgs.length, at: new Date().toISOString() };
            saveBackfilled(backfilled);
            bfJob.filesDone++;
          }
          log(`backfill[db]: ${sid} → ${msgs.length} msgs`);
        }
        continue;
      }

      for (const file of files) {
        if (bfJob.error) break;
        if (targetList.length && !targetsMatchDir(targetList, src, path.dirname(file))) { bfJob.filesDone++; continue; }
        if (backfilled[file]) { bfJob.filesDone++; continue; } // 已回传过：跳过
        bfJob.current = path.basename(file);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        const msgs = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { msgs.push(...def.parse(line)); } catch (_) { }
        }
        if (msgs.length) {
          const session = path.basename(file).replace(/\.jsonl$/, '') + '-' + path.basename(path.dirname(file));
          for (let i = 0; i < msgs.length; i += 50) {
            const payload = {
              team_id: cfg.teamId,
              agent_id: cfg.agentId,
              session_id: `backfill-${src}-${session}`.slice(0, 120),
              messages: sliceMessages(msgs.slice(i, i + 50).map((m) => ({ ...m, ts: new Date().toISOString() }))),
              _source: src,
            };
            const r = await uploadBatch(cfg, api, payload, state);
            if (r === 'skip') { bfJob.error = `${path.basename(file)} 上传被拒绝（4xx），放弃该文件`; break; }
            bfJob.msgs += payload.messages.length; // true=已传，false=已入本地队列待补
          }
        }
        if (!bfJob.error) {
          backfilled[file] = { msgs: msgs.length, at: new Date().toISOString() };
          saveBackfilled(backfilled);
          bfJob.filesDone++;
        }
        log(`backfill: ${path.basename(file)} → ${msgs.length} msgs`);
      }
    }
  } finally {
    bfJob.running = false; bfJob.current = ''; bfJob.doneAt = new Date().toISOString();
  }
  return { files: bfJob.filesDone, total: bfJob.files, msgsUploaded: bfJob.msgs, error: bfJob.error };
}

// 异步启动（供 HTTP / 控制台按钮）：立即返回，进度走 backfillStatus()
function startBackfill(cfg, api, state, opts) {
  if (bfJob.running) return { ok: false, error: '已有回传任务在进行中，请等它跑完' };
  runBackfill(cfg, api, state, opts || {}).catch((e) => { bfJob.error = e.message || String(e); bfJob.running = false; });
  return { ok: true, startedAt: bfJob.startedAt };
}

/* ---------- 入口 ---------- */

async function main() {
  const sub = process.argv[2] || '';
  if (sub === 'hook') return runHook();

  const cfg = loadConfig();
  const api = mkApi(cfg);
  const state = mkState();
  const cache = mkCache(cfg, api);

  if (sub === 'push') {
    const r = await scanAndUpload(cfg, api, state);
    const q = await flushQueue(cfg, api, state);
    console.log(JSON.stringify({ pushed: r.pushed, queueFlushed: q }));
    return;
  }
  if (sub === 'health') {
    let queueLen = 0; try { queueLen = fs.readdirSync(QUEUE_DIR).length; } catch (_) { }
    console.log(JSON.stringify({ configOk: !missingConfig(cfg), hookCalls: state.hookCalls, queueLen }, null, 2));
    return;
  }
  if (sub === 'backfill') {
    // 全量回传历史：backfill [source] [filter]。source 缺省 = 全部来源；已回传文件自动跳过。
    const source = process.argv[3] || '';
    const filter = process.argv[4] || '';
    if (source && !SOURCES[source]) { console.error('未知来源: ' + source + '（可选: ' + Object.keys(SOURCES).join(' | ') + '）'); process.exit(2); }
    const r = await runBackfill(cfg, api, state, { source, filter });
    console.log(JSON.stringify(r));
    return;
  }
  if (sub && sub !== 'serve') {
    console.error('用法: tdai-daemon [serve|push|hook|health|backfill [source] [filter]]');
    process.exit(2);
  }

  // serve：HTTP 服务 + 采集循环
  await startServer(cfg, api, cache, state);
  await cache.refresh();
  const loop = async () => {
    try {
      await scanAndUpload(cfg, api, state);
      await flushQueue(cfg, api, state);
      await cache.refresh();
    } catch (e) { log(`loop error: ${e.message}`); }
  };
  // 采集循环的心跳：本轮结束后记下"下轮采集时刻"，持久化（重启后倒计时不断档）
  const markNextScan = () => {
    state.nextScanAt = new Date(Date.now() + SCAN_INTERVAL_MS).toISOString();
    saveStatus({ nextScanAt: state.nextScanAt });
  };
  await loop();
  markNextScan();
  setInterval(() => { loop().then(markNextScan).catch(() => { }); }, SCAN_INTERVAL_MS);
}

if (require.main === module) main().catch((e) => { log(`fatal: ${e.message}`); process.exitCode = 1; });

// 供 Electron 应用（pet/src/guard.js）复用：同一份实现，不做二次开发
module.exports = {
  loadConfig, missingConfig, mkApi, mkCache, mkState, startServer,
  scanAndUpload, flushQueue, enqueue, buildRecall, hasIntent,
  runBackfill, startBackfill, backfillStatus, ensureUserId,
  agentStatus, updateCheck, consolePage, readPublicConfig, writeConfig,
  parseZCodeLine, parseClaudeLine, parseRolloutLine, sliceMessages, readNewLines,
  zcodeDbSources, zdbSessionMessages, zdbMsgCount, zdbAvailable, zdbStatus,
  agentInventory, targetsMatchDir,
  SOURCES, ZDB_CURSOR_PREFIX, ZCODE_DB, ZDB_MIN_NODE,
  APP_VER, RECALL_PORT, CFG_PATH, DATA_DIR, QUEUE_DIR, LOG_PATH, SCAN_INTERVAL_MS,
  // 面板响应判定的内联副本：导出仅为让 test/clients-consistency.test.js 能逐字段
  // 与 core/panel-codes.js 比对（防"改了 core 忘了 daemon"的漂移）。
  PANEL_HINTS, PANEL_CODE_CLASS, PANEL_API_PREFIX, classifyPanel, panelSummary, codeKeyOf,
};
