// tdai-core.js — TD AI 记忆库·零依赖检索引擎
// 用法：const core = require('./tdai-core'); const c = core.create(cfg);
// 环境：Node ≥16（内置 https）；Node ≥18 走 fetch。零 npm 依赖。
// 仅本机读 ~/.zcode/tdai-mcp.json；密钥不出本机。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const CFG_PATH = path.join(os.homedir(), '.zcode', 'tdai-mcp.json');
const DEFAULT_PANEL = 'http://muhuihao.top:8125';
const DEFAULT_TEAM = 'team-zcv52tgzwg';
const DEFAULT_AGENT = 'agt-zc6vu8z5ks';
const DEFAULT_TASK = 'task-zdlxl0mp4h';
const RESULT_LIMIT = 6144; // 单条结果截断 ≤6KB
const REQ_TIMEOUT = 15000;

/* ---------- 配置 ---------- */

function loadConfig(overrides) {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { /* 文件缺省 */ }
  const env = {
    panelUrl: process.env.TDAI_PANEL_URL,
    userKey: process.env.TDAI_USER_KEY,
    teamId: process.env.TDAI_TEAM_ID,
    agentId: process.env.TDAI_AGENT_ID,
    taskId: process.env.TDAI_TASK_ID,
  };
  const cfg = Object.assign(
    { panelUrl: DEFAULT_PANEL, userKey: '', teamId: DEFAULT_TEAM, agentId: DEFAULT_AGENT, taskId: DEFAULT_TASK },
    disk, Object.fromEntries(Object.entries(env).filter(([, v]) => v)), overrides || {}
  );
  cfg.panelUrl = String(cfg.panelUrl || '').replace(/\/+$/, '');
  return cfg;
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
      'X-Tdai-Service-Id': 'default',
      'X-Tdai-User-Key': cfg.userKey,
    }, extra || {});
  }

  async function api(pathname, { method = 'GET', body = null, extraHeaders = {} } = {}) {
    if (!cfg.userKey) return err('未配置 userKey', `请在 ${CFG_PATH} 写入 userKey 后重试`);
    const url = cfg.panelUrl + '/api/v1' + pathname;
    let r;
    try {
      r = await requestRaw(url, { method, headers: headers(extraHeaders), body });
    } catch (e) {
      return err('记忆库不可达', `请检查 NAS 8125 端口/公网开闸 (${e.code || e.message})`);
    }
    if (r.status === 401 || r.status === 403) return err(`认证失败 HTTP ${r.status}`, 'userKey 可能失效');
    if (r.status >= 500) return err(`面板 5xx (${r.status})`, clip(r.body, 800));
    let json;
    try { json = JSON.parse(r.body); } catch (_) { json = { raw: r.body }; }
    return ok(json, `HTTP ${r.status}`);
  }

  /* ---- 工具实现（均为只读） ---- */

  return {
    cfg,

    // 健康检查：面板 + 知识面
    async health() {
      const t0 = Date.now();
      const a = await api('/meta/auth/verify');
      const b = await api('/knowledge/health');
      return ok({
        panelUrl: cfg.panelUrl,
        latencyMs: Date.now() - t0,
        auth: a.ok ? a.data : a,
        knowledge: b.ok ? b.data : b,
      });
    },

    // 会话记忆检索
    async memorySearch({ query, top_k = 5, team_id, agent_id } = {}) {
      if (!query) return err('缺少 query');
      return api('/chat-memory/search', {
        method: 'POST',
        body: {
          query: String(query),
          top_k: Math.min(Number(top_k) || 5, 20),
          team_id: team_id || cfg.teamId,
          agent_id: agent_id || cfg.agentId,
        },
      });
    },

    // L1/L2/L3 记忆分层概览
    async memoryLayers({ team_id, agent_id } = {}) {
      return api('/chat-memory/layer', {
        method: 'POST',
        body: { team_id: team_id || cfg.teamId, agent_id: agent_id || cfg.agentId },
      });
    },

    // 团队资产总览
    async teamAssets({ team_id } = {}) {
      return api('/chat-memory/team-assets', {
        method: 'POST',
        body: { team_id: team_id || cfg.teamId },
      });
    },

    // 技能目录
    async skillList({ team_id } = {}) {
      return api('/skill/list', {
        method: 'POST',
        body: { team_id: team_id || cfg.teamId },
      });
    },

    // 技能详情
    async skillGet({ skill_id, name } = {}) {
      if (!skill_id && !name) return err('需要 skill_id 或 name');
      return api('/skill/get', {
        method: 'POST',
        body: skill_id ? { skill_id } : { name, team_id: cfg.teamId },
      });
    },

    // Wiki 检索
    async wikiSearch({ query, top_k = 5 } = {}) {
      if (!query) return err('缺少 query');
      return api('/knowledge/wiki/search', {
        method: 'POST',
        body: { query: String(query), top_k: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId },
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
        body: { query: String(query), top_k: Math.min(Number(top_k) || 5, 20), team_id: cfg.teamId },
      });
    },

    // 代码图谱邻域
    async codegraphExplore({ node_id, depth = 1 } = {}) {
      return api('/knowledge/code-graph/explore', {
        method: 'POST',
        body: { node_id: node_id || null, depth: Math.min(Number(depth) || 1, 3), team_id: cfg.teamId },
      });
    },
  };
}

module.exports = { create, loadConfig, ok, err, clip, CFG_PATH };
