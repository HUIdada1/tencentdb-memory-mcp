// tdai-core.js — TD AI 记忆库·零依赖客户端（检索/健康/上传共用）
// 用法：const core = require('./tdai-core'); const c = core.create();
// 环境：Node ≥16（内置 https）；Node ≥18 走 fetch。零 npm 依赖。
// 配置仅读本机 ~/.zcode/tdai-mcp.json（env 同权覆盖）；密钥不出本机，无硬编码资产 ID。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const CFG_PATH = path.join(os.homedir(), '.zcode', 'tdai-mcp.json');
const RESULT_LIMIT = 6144; // 单条结果截断 ≤6KB
const REQ_TIMEOUT = 15000;

/* ---------- 配置 ---------- */

// 覆盖顺序：代码传入 > env > 本地配置文件。team/agent/task 等资产 ID 一律来自配置，不硬编码。
function loadConfig(overrides) {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { /* 文件缺省 */ }
  const env = {
    panelUrl: process.env.TDAI_PANEL_URL,
    userKey: process.env.TDAI_USER_KEY,
    teamId: process.env.TDAI_TEAM_ID,
    agentId: process.env.TDAI_AGENT_ID,
    taskId: process.env.TDAI_TASK_ID,
    serviceId: process.env.TDAI_SERVICE_ID,
  };
  const cfg = Object.assign(
    { panelUrl: '', userKey: '', teamId: '', agentId: '', taskId: '', serviceId: 'default' },
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

/* ---------- HTTP ---------- */

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
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/* ---------- 统一结果封装 ---------- */

function ok(data, hint) { return { ok: true, data, hint: hint || '' }; }
function err(message, hint) { return { ok: false, error: message, hint: hint || '' }; }
function clip(s, n = RESULT_LIMIT) {
  s = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + `\n…[截断, 共 ${s.length} 字符]` : s;
}

/* ---------- 客户端 ---------- */

function create(overrides) {
  const cfg = loadConfig(overrides);

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
    const url = cfg.panelUrl + '/api/v1' + pathname;
    let r;
    try {
      r = await requestRaw(url, { method, headers: headers(extraHeaders), body, timeout });
    } catch (e) {
      return err('记忆库不可达', `请检查面板 ${cfg.panelUrl} 端口/公网开闸 (${e.code || e.message})`);
    }
    if (r.status === 401 || r.status === 403) return err(`认证失败 HTTP ${r.status}`, 'userKey 可能失效');
    if (r.status >= 500) return err(`面板 5xx (${r.status})`, clip(r.body, 800));
    let json;
    try { json = JSON.parse(r.body); } catch (_) { json = { raw: r.body }; }
    return ok(json, `HTTP ${r.status}`);
  }

  /* ---- 只读工具 ---- */

  return {
    cfg,

    // 健康检查：面板可达性 + 检索面探活（真实端点，不再用 404 的 /meta/auth/verify）
    async health() {
      const t0 = Date.now();
      const miss = missingConfig(cfg);
      if (miss) return ok({ nas: false, auth: false, panelUrl: cfg.panelUrl, hint: miss });
      const a = await api('/skill/list', { method: 'POST', body: { team_id: cfg.teamId || undefined }, timeout: 8000 });
      return ok({
        panelUrl: cfg.panelUrl,
        nas: a.ok,
        auth: a.ok && !(a.data && a.data.code === 401),
        latencyMs: Date.now() - t0,
        hint: a.ok ? '' : (a.error || ''),
      });
    },

    // 面板侧我可见的 agent 列表（检索前拿 block_id / 维度过滤用）
    async myAgents() {
      return api('/chat-memory/my-agents', { method: 'POST', body: { team_id: cfg.teamId || undefined } });
    },

    // 会话记忆检索。block_id：面板检索的块标识，默认 'chat-memory'，可按面板实际取值覆盖。
    async memorySearch({ query, top_k = 5, team_id, agent_id, block_id } = {}) {
      if (!query) return err('缺少 query');
      return api('/chat-memory/search', {
        method: 'POST',
        body: {
          query: String(query),
          top_k: Math.min(Number(top_k) || 5, 20),
          block_id: block_id || cfg.blockId || 'chat-memory',
          team_id: team_id || cfg.teamId || undefined,
          agent_id: agent_id || cfg.agentId || undefined,
        },
      });
    },

    // L1/L2/L3 记忆分层概览
    async memoryLayers({ team_id, agent_id, block_id } = {}) {
      return api('/chat-memory/layer', {
        method: 'POST',
        body: {
          block_id: block_id || cfg.blockId || 'chat-memory',
          team_id: team_id || cfg.teamId || undefined,
          agent_id: agent_id || cfg.agentId || undefined,
        },
      });
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

    // Wiki 检索
    async wikiSearch({ query, top_k = 5 } = {}) {
      if (!query) return err('缺少 query');
      return api('/knowledge/wiki/search', {
        method: 'POST',
        body: { query: String(query), top_k: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId || undefined },
      });
    },

    // Wiki 页读取
    async wikiRead({ page_id } = {}) {
      if (!page_id) return err('缺少 page_id');
      return api('/knowledge/wiki/page/read', {
        method: 'POST',
        body: { page_id },
      });
    },

    // 代码图谱检索
    async codegraphSearch({ query, top_k = 5 } = {}) {
      if (!query) return err('缺少 query');
      return api('/knowledge/code-graph/search', {
        method: 'POST',
        body: { query: String(query), top_k: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId || undefined },
      });
    },

    // 代码图谱邻域
    async codegraphExplore({ node_id, depth = 1 } = {}) {
      return api('/knowledge/code-graph/explore', {
        method: 'POST',
        body: { node_id: node_id || null, depth: Math.min(Number(depth) || 1, 3), team_id: cfg.teamId || undefined },
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

    // 会话入队触发 L1 抽取 / 技能抽取
    async conversationAdd({ team_id, agent_id, session_id } = {}) {
      return api('/skill/conversation/add', {
        method: 'POST',
        body: {
          team_id: team_id || cfg.teamId,
          agent_id: agent_id || cfg.agentId,
          session_id,
        },
      });
    },
  };
}

module.exports = { create, loadConfig, requestRaw, ok, err, clip, CFG_PATH, missingConfig };
