// tdai-core.js — TD AI 记忆库·零依赖客户端（检索/健康/上传共用）
// 用法：const core = require('./tdai-core'); const c = core.create();
// 环境：Node ≥16（内置 https）；Node ≥18 走 fetch。零 npm 依赖。
// 配置仅读本机 ~/.zcode/tdai-mcp.json（env 同权覆盖）；密钥不出本机，无硬编码资产 ID。
//
// ⚠️ 面板 API 前缀是 `/api/v1`（业务面），**不是**上游文档里的 `/v3`。
//    2026-09-22 实测（真实面板）：
//      POST /api/v1/skill/list        → 200 {"code":0,...}
//      POST /v3/skill/list            → 404 Not Found
//      POST /v3/chat-memory/search    → 404 Not Found
//      GET  /v3                       → 200（返回前端 SPA 的 index.html）
//    → `/v3` 是**前端路由**，与会话记忆业务面是两回事。别把这里"对齐"成 /v3。
//    真值常量在 core/panel-codes.js 的 API_PREFIX（daemon 有内联副本，测试会校验一致）。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
// 面板响应判定（业务码/HTTP 码/中文提示）唯一真源，与 daemon 内联版本语义一致
const panel = require('./panel-codes.js');

const CFG_PATH = path.join(os.homedir(), '.zcode', 'tdai-mcp.json');
const RESULT_LIMIT = 6144; // 单条结果截断 ≤6KB
const REQ_TIMEOUT = 15000;
const MAX_RES_BYTES = 8 * 1024 * 1024;  // 单次响应体硬上限 8MB（防面板异常返回打爆内存）

/* ---------- 配置 ---------- */

// 覆盖顺序：代码传入 > env > 本地配置文件。team/agent/task 等资产 ID 一律来自配置，不硬编码。
function loadConfig(overrides) {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { /* 文件缺省 */ }
  const env = {
    panelUrl: process.env.TDAI_PANEL_URL,
    userKey: process.env.TDAI_USER_KEY,
    userId: process.env.TDAI_USER_ID,
    teamId: process.env.TDAI_TEAM_ID,
    agentId: process.env.TDAI_AGENT_ID,
    taskId: process.env.TDAI_TASK_ID,
    serviceId: process.env.TDAI_SERVICE_ID,
    blockId: process.env.TDAI_BLOCK_ID,
  };
  const cfg = Object.assign(
    { panelUrl: '', userKey: '', userId: '', teamId: '', agentId: '', taskId: '', serviceId: 'default', blockId: '' },
    disk, Object.fromEntries(Object.entries(env).filter(([, v]) => v)), overrides || {}
  );
  cfg.panelUrl = String(cfg.panelUrl || '').replace(/\/+$/, '');
  cfg.teamId = cfg.teamId || cfg.defaultTeamId || '';
  return cfg;
}

function missingConfig(cfg) {
  const miss = [];
  if (!cfg.panelUrl) miss.push('panelUrl');
  if (!cfg.userKey) miss.push('userKey');
  return miss.length ? `请在 ${CFG_PATH}（或环境变量）写入: ${miss.join(', ')}` : '';
}

/* ---------- 记忆块与分层 ---------- */

// 面板按 (block_id, layer) 两维取数，块 ID 形如 'chat_memory-<team_id>-<agent_id>'。
// 裸 agent_id（与配置一致时）自动拼成完整块 ID；显式 block_id 优先。
function toBlockId(cfg, { block_id, agent_id } = {}) {
  const raw = block_id || agent_id || cfg.blockId || cfg.agentId || '';
  if (!raw) return '';
  if (raw.startsWith('chat_memory-')) return raw;
  if (cfg.teamId && raw === cfg.agentId) return `chat_memory-${cfg.teamId}-${raw}`;
  return raw;
}

const LAYERS = ['L0', 'L1', 'L2', 'L3'];
function normLayer(layer, dflt) {
  const v = String(layer || dflt || '').toUpperCase();
  return LAYERS.includes(v) ? v : '';
}

/* ---------- HTTP ---------- */

function requestRaw(urlStr, { method = 'GET', headers = {}, body = null, timeout = REQ_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('URL 非法: ' + urlStr)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: Object.assign({ 'Accept': 'application/json' }, headers),
        timeout,
      }, (res) => {
        const chunks = [];
        // 响应上限：面板异常返回超大内容时不许把内存吃光（检索结果本就有 6KB 截断）
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_RES_BYTES) { try { req.destroy(new Error('response too large')); } catch (_) { } return; }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => reject(e));
      });
    } catch (e) {
      reject(e);
      return;
    }
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    try {
      if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } catch (e) { reject(e); }
  });
}

/* ---------- 统一结果封装 ---------- */

// extra.panel = core/panel-codes.js classify() 的结论（业务码/hint/kind），
// 供调用方做 UI 分类（例如把 kind==='auth' 渲染成"去改配置"）；不带也不影响既有调用方。
function ok(data, hint, extra) { return Object.assign({ ok: true, data, hint: hint || '' }, extra || {}); }
function err(message, hint, extra) { return Object.assign({ ok: false, error: message, hint: hint || '' }, extra || {}); }
function clip(s, n = RESULT_LIMIT) {
  s = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + `\n…[截断, 共 ${s.length} 字符]` : s;
}

/* ---------- 客户端 ---------- */

function create(overrides) {
  const cfg = loadConfig(overrides);
  // 可选：每次 HTTP 往返的观察者（供桌宠控制台做实时流量计量）。
  // 缺省 noop，对既有调用方完全透明。传入方式：create({ ..., _onHttp: fn })。
  const onHttp = typeof (overrides && overrides._onHttp) === 'function' ? overrides._onHttp : null;
  const onHttpStart = typeof (overrides && overrides._onHttpStart) === 'function' ? overrides._onHttpStart : null;

  function headers(extra) {
    return Object.assign({
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': cfg.serviceId || 'default',
      'X-Tdai-User-Key': cfg.userKey,
    }, extra || {});
  }

  async function api(pathname, { method = 'GET', body = null, extraHeaders = {}, timeout = REQ_TIMEOUT } = {}) {
    const miss = missingConfig(cfg);
    if (miss) return err('未完成配置', miss);
    const url = cfg.panelUrl + panel.API_PREFIX + pathname;
    const t0 = Date.now();
    // 上行字节 = 请求体长度（真实写出前即可精确得知）
    let reqBytes = 0;
    try {
      reqBytes = body == null ? 0
        : Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    } catch (_) { reqBytes = 0; }   // 循环引用等不可序列化入参：交给 requestRaw 去报错，计量不参与
    if (onHttpStart) { try { onHttpStart({ url, method, reqBytes }); } catch (_) {} }

    let r;
    try {
      r = await requestRaw(url, { method, headers: headers(extraHeaders), body, timeout });
    } catch (e) {
      if (onHttp) { try { onHttp({ url, method, reqBytes, resBytes: 0, status: 0, ms: Date.now() - t0, error: e.code || e.message }); } catch (_) {} }
      return err('记忆库不可达', `请检查面板 ${cfg.panelUrl} 端口/公网开闸 (${e.code || e.message})`);
    }
    // 下行字节 = 响应体真实长度；reqBytes 为上行真实长度
    if (onHttp) {
      try { onHttp({ url, method, reqBytes, resBytes: Buffer.byteLength(r.body || '', 'utf8'), status: r.status, ms: Date.now() - t0 }); } catch (_) {}
    }
    // r 理论上不会是 null，但请求层任何改动都可能让它变成 undefined；
    // 这里显式兜底，避免下游出现 "Cannot read properties of null" 这种难查的崩溃。
    if (!r || typeof r.status !== 'number') return err('面板响应异常', '响应结构不符合预期（未拿到 status）');

    // 判定收敛到 core/panel-codes.js。**不再只看 HTTP 状态码** ——
    // 实测面板用 "HTTP 400 + code:400 + message:MISSING_BLOCK_ID" 表达参数错误，
    // 旧实现把它当成功，导致上游"上传成功"实则零写入（最隐蔽的一类 bug）。
    const v = panel.classify(r);
    // 把判定结果一并带回（err/ok 的第三个字段），供上层做 UI 分类展示
    if (!v.ok) return err(panel.summarize(v), v.hint || clip(r.body, 800), { panel: v });
    return ok(v.json == null ? { raw: r.body } : v.json, `HTTP ${r.status}`, { panel: v });
  }

  /* ---- 只读工具 ---- */

  return {
    cfg,

    // 健康检查：面板可达性 + **真实鉴权**探活。
    //
    // ⚠️ 2026-09-22 实测修正（旧注释与旧实现都是错的，别再改回去）：
    //   实测各端点对 userKey 的校验态度**不一致**：
    //     POST /api/v1/skill/list            + 坏 key → HTTP 200 {"code":0}  ← **不校验！**
    //     POST /api/v1/meta/auth/verify      + 坏 key → HTTP 200 {"code":0,"valid":true} ← **也不校验！**
    //     POST /api/v1/chat-memory/my-agents + 坏 key → HTTP 401 {"code":401,"message":"INVALID_USER_KEY"} ← ✅ 真校验
    //     POST /api/v1/chat-memory/search    + 坏 key → HTTP 401 {"code":401}   ← ✅ 真校验
    //     POST /api/v1/chat-memory/layer     + 坏 key → HTTP 401 {"code":401}   ← ✅ 真校验
    //   旧实现打 `/skill/list` 并写 `auth = nas` → **auth 恒等于"面板可达"**，
    //   永远发现不了 key 失效：用户看到"连接正常"，实际所有检索/上传都在静默失败。
    //   （本文件更早的版本甚至用 `/meta/auth/verify`，同样测不出 —— 名字有误导性。）
    //   → 探活必须打 `/chat-memory/my-agents`：它是检索面端点，**真的会校验**，
    //     且已经携带 team_id，顺带验证 teamId 是否有效（坏 serviceId 会回 400 INVALID_INSTANCE）。
    //
    //   口径（与 daemon /api/test-connection、pet main.js testConn **必须一致**）：
    //     nas  = 面板这家服务活着（HTTP 有响应，含 4xx/404）
    //     auth = classify() 判定为成功（v.ok），即 key 真实有效
    //   ⚠️ `nas !== auth` 是**正常且必要**的：面板活着但 key 错了必须能区分出来。
    //      别再写 `auth = nas`（那是本次修掉的 bug）。
    async health() {
      const t0 = Date.now();
      const miss = missingConfig(cfg);
      if (miss) return ok({ nas: false, auth: false, panelUrl: cfg.panelUrl, hint: miss, kind: 'config', codeKey: '' });
      const a = await api('/chat-memory/my-agents', {
        method: 'POST',
        body: { team_id: cfg.teamId || undefined },
        timeout: 8000,
      });
      // api() 在**网络层失败**时返回的 err() 不带 panel（没拿到响应，无从判定），
      // 这里补一个 unreachable 结论，让 UI 的 kind 分支不会拿到空串。
      const v = a.panel || { kind: 'unreachable', status: 0, code: undefined, key: '', hint: '' };
      const nas = a.ok || (v.status >= 100 && v.status < 500);  // 拿到 4xx/404 也算"面板活着"
      const auth = !!a.ok;
      return ok({
        panelUrl: cfg.panelUrl,
        nas,
        auth,
        latencyMs: Date.now() - t0,
        // 面板活着但 key 不行时，hint 要能直接告诉用户去改哪里
        hint: auth ? '' : (a.hint || a.error || ''),
        code: v.code,
        codeKey: v.key || '',
        kind: v.kind || 'unreachable',
      });
    },

    // 面板侧我可见的 agent 列表（检索前拿 block_id / 维度过滤用）
    async myAgents() {
      return api('/chat-memory/my-agents', { method: 'POST', body: { team_id: cfg.teamId || undefined } });
    },

    // 会话记忆检索。layer=L0 检索对话原文，L1~L3 检索抽取后的记忆片段。
    async memorySearch({ query, top_k = 5, layer, agent_id, block_id } = {}) {
      if (!query) return err('缺少 query');
      const blockId = toBlockId(cfg, { block_id, agent_id });
      if (!blockId) return err('缺少记忆块：请配置 agentId+teamId，或显式传 block_id/agent_id');
      const lay = normLayer(layer, 'L0');
      if (!lay) return err('layer 仅支持 L0/L1/L2/L3');
      return api('/chat-memory/search', {
        method: 'POST',
        body: {
          query: String(query),
          limit: Math.min(Number(top_k) || 5, 20),
          block_id: blockId,
          layer: lay,
        },
      });
    },

    // 记忆分层：不传 layer 返回四层计数概览；传 layer 返回该层明细分页。
    async memoryLayers({ layer, limit = 50, offset = 0, team_id, agent_id, block_id } = {}) {
      const blockId = toBlockId(cfg, { block_id, agent_id });
      if (!blockId) return err('缺少记忆块：请配置 agentId+teamId，或显式传 block_id/agent_id');
      const once = (lay, lim, off) => api('/chat-memory/layer', {
        method: 'POST',
        body: {
          block_id: blockId,
          layer: lay,
          team_id: team_id || cfg.teamId || undefined,
          limit: Math.min(Math.max(Number(lim) || 50, 1), 200),
          offset: Math.max(Number(off) || 0, 0),
        },
      });
      if (layer) {
        const lay = normLayer(layer);
        if (!lay) return err('layer 仅支持 L0/L1/L2/L3');
        return once(lay, limit, offset);
      }
      const layers = ['L0', 'L1', 'L2', 'L3'];
      const rs = await Promise.all(layers.map((lay) => once(lay, 1, 0)));
      const bad = rs.find((r) => !r.ok);
      if (bad) return bad;
      const counts = {};
      let total = 0;
      layers.forEach((lay, i) => {
        // api() 包装后：r.data = 面板响应 {code, message, data:{total,...}}
        const n = (rs[i].data && rs[i].data.data && rs[i].data.data.total) || 0;
        counts[lay === 'L0' ? 'L0_messages' : lay] = n;
        total += n;
      });
      return ok({ block_id: blockId, counts, total }, 'L0=对话原文，L1~L3=抽取记忆');
    },

    // 团队资产总览
    async teamAssets({ team_id } = {}) {
      return api('/chat-memory/team-assets', {
        method: 'POST',
        body: { team_id: team_id || cfg.teamId || undefined },
      });
    },

    // 技能目录
    async skillList({ team_id } = {}) {
      return api('/skill/list', {
        method: 'POST',
        body: { team_id: team_id || cfg.teamId || undefined },
      });
    },

    // 技能详情
    async skillGet({ skill_id, name } = {}) {
      if (!skill_id && !name) return err('需要 skill_id 或 name');
      return api('/skill/get', {
        method: 'POST',
        body: skill_id ? { skill_id } : { name, team_id: cfg.teamId || undefined },
      });
    },

    // Wiki 检索（服务端契约：wiki_id 必填）
    async wikiSearch({ query, wiki_id, top_k = 5 } = {}) {
      if (!query) return err('缺少 query');
      if (!wiki_id) return err('缺少 wiki_id', '面板 Wiki 检索必须指定 wiki_id（wiki-…）。可在面板「知识库 → Wiki」查看已分配的 wiki ID，或先在设置里配置。');
      return api('/knowledge/wiki/search', {
        method: 'POST',
        body: { wiki_id, query: String(query), limit: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId || undefined },
      });
    },

    // Wiki 页读取（服务端契约：wiki_id + refs/page_id）
    async wikiRead({ wiki_id, page_id, refs } = {}) {
      if (!wiki_id) return err('缺少 wiki_id', '读取 Wiki 页必须先指定 wiki_id（wiki-…）。');
      const refList = Array.isArray(refs) && refs.length ? refs : (page_id ? [page_id] : []);
      if (!refList.length) return err('缺少 page_id 或 refs');
      return api('/knowledge/wiki/page/read', {
        method: 'POST',
        body: { wiki_id, refs: refList },
      });
    },

    // 代码图谱检索（服务端契约：code_graph_id 必填）
    async codegraphSearch({ query, code_graph_id, top_k = 5 } = {}) {
      if (!query) return err('缺少 query');
      if (!code_graph_id) return err('缺少 code_graph_id', '代码图谱检索必须指定 code_graph_id（cg-…）。可在面板「知识库 → 代码图谱」查看已分配的图谱 ID，或先在设置里配置。');
      return api('/knowledge/code-graph/search', {
        method: 'POST',
        body: { code_graph_id, query: String(query), limit: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId || undefined },
      });
    },

    // 代码图谱邻域（服务端契约：code_graph_id 必填）
    async codegraphExplore({ code_graph_id, node_id, depth = 1 } = {}) {
      if (!code_graph_id) return err('缺少 code_graph_id', '代码图谱探索必须指定 code_graph_id（cg-…）。');
      return api('/knowledge/code-graph/explore', {
        method: 'POST',
        body: { code_graph_id, node_id: node_id || null, depth: Math.min(Number(depth) || 1, 3), team_id: cfg.teamId || undefined },
      });
    },

    /* ---- 写入（守护进程采集上传用） ---- */

    // 会话导入：messages 为 [{role, content, ts}]，单条 ≤8192 字符（调用方先切片）
    async sessionImport({ team_id, agent_id, session_id, messages } = {}) {
      return api('/chat-memory/import', {
        method: 'POST',
        body: {
          team_id: team_id || cfg.teamId,
          agent_id: agent_id || cfg.agentId,
          session_id,
          messages,
        },
      });
    },

    // 会话入队触发 L1 抽取 / 技能抽取。服务端契约要求 user_id + messages（仅传会话引用会被 400 拒绝）。
    async conversationAdd({ user_id, team_id, agent_id, session_id, messages } = {}) {
      return api('/skill/conversation/add', {
        method: 'POST',
        body: {
          user_id: user_id || cfg.userId,
          team_id: team_id || cfg.teamId,
          agent_id: agent_id || cfg.agentId,
          session_id,
          messages,
        },
      });
    },
  };
}

module.exports = { create, loadConfig, requestRaw, ok, err, clip, CFG_PATH, missingConfig, panel };
