#!/usr/bin/env node
// tdai-mcp.js — TD AI 记忆工具 · MCP 服务器(stdio) + CLI 双模式
// 无参运行 = MCP 服务器 (JSON-RPC 2.0 over stdio, NDJSON)
// node tdai-mcp.js run <tool> [--json '{...}'] = 一次性 CLI
// 零依赖。Node ≥16。

'use strict';
const path = require('path');
const readline = require('readline');
const core = require(path.join(__dirname, '..', 'core', 'tdai-core.js'));

const SERVER_NAME = 'tdai-memory';
const SERVER_VER = '0.5.16';   // 与 package.json / daemon APP_VER 同步（发版流水线会校验）

/* ---------- 工具目录（inputSchema 用 JSON Schema） ---------- */

const TOOLS = [
  {
    name: 'tdai.health',
    description: 'TD 记忆库健康检查：面板连通性 + 知识面状态。NAS 离线时返回中文可读错误。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (c) => c.health(),
  },
  {
    name: 'tdai.my_agents',
    description: '查看面板里当前用户可见的 Agent 列表（检索前拿维度过滤用）。',
    inputSchema: {
      type: 'object', properties: { team_id: { type: 'string' } }, additionalProperties: false,
    },
    run: (c, a) => c.myAgents(a),
  },
  {
    name: 'tdai.memory_search',
    description: '检索团队对话记忆。layer=L0 搜对话原文，L1~L3 搜抽取后的记忆片段。当用户问"我们之前关于 X 是怎么做的"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词' },
        top_k: { type: 'number', default: 5, maximum: 20 },
        layer: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3'], description: '记忆层，默认 L0（对话原文）' },
        agent_id: { type: 'string', description: 'Agent ID，默认取配置' },
        block_id: { type: 'string', description: '记忆块 ID（chat_memory-<team>-<agent>），默认按配置拼出' },
      },
      required: ['query'], additionalProperties: false,
    },
    run: (c, a) => c.memorySearch(a),
  },
  {
    name: 'tdai.memory_layers',
    description: '查看记忆分层概览（L0=对话原文，L1~L3=抽取记忆的条数）；传 layer 参数可看该层明细分页。',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3'], description: '不传返回四层计数概览' },
        limit: { type: 'number', default: 50 },
        offset: { type: 'number', default: 0 },
        agent_id: { type: 'string', description: 'Agent ID，默认取配置' },
        block_id: { type: 'string', description: '记忆块 ID，默认按配置拼出' },
      },
      additionalProperties: false,
    },
    run: (c, a) => c.memoryLayers(a),
  },
  {
    name: 'tdai.team_assets',
    description: '团队资产总览：用户/Agent/Task/Skill/记忆计数。',
    inputSchema: {
      type: 'object', properties: { team_id: { type: 'string' } }, additionalProperties: false,
    },
    run: (c, a) => c.teamAssets(a),
  },
  {
    name: 'tdai.skill_list',
    description: '列出团队技能（SKILL.md 集合）。',
    inputSchema: {
      type: 'object', properties: { team_id: { type: 'string' } }, additionalProperties: false,
    },
    run: (c, a) => c.skillList(a),
  },
  {
    name: 'tdai.skill_get',
    description: '读取单个技能正文与资源。skill_id 与 name 至少给一个。',
    inputSchema: {
      type: 'object',
      properties: { skill_id: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
      anyOf: [{ required: ['skill_id'] }, { required: ['name'] }],
    },
    run: (c, a) => c.skillGet(a),
  },
  {
    name: 'tdai.wiki_search',
    description: '检索团队 Wiki 文档。必须先指定 wiki_id（形如 wiki-…，可在面板「知识库 → Wiki」查看）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        wiki_id: { type: 'string', description: 'Wiki ID（必填，形如 wiki-…）' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query', 'wiki_id'], additionalProperties: false,
    },
    run: (c, a) => c.wikiSearch(a),
  },
  {
    name: 'tdai.wiki_read',
    description: '读取 Wiki 单页正文。必须指定 wiki_id（形如 wiki-…），并给出 page_id 或 refs 之一。',
    inputSchema: {
      type: 'object',
      properties: {
        wiki_id: { type: 'string', description: 'Wiki ID（必填，形如 wiki-…）' },
        page_id: { type: 'string', description: '页面 ID' },
        refs: { type: 'array', items: { type: 'string' }, description: '页面引用列表（与 page_id 至少给一个）' },
      },
      required: ['wiki_id'], additionalProperties: false,
      anyOf: [{ required: ['page_id'] }, { required: ['refs'] }],
    },
    run: (c, a) => c.wikiRead(a),
  },
  {
    name: 'tdai.codegraph_search',
    description: '检索代码图谱节点（函数/类/文件级符号）。必须先指定 code_graph_id（形如 cg-…，可在面板「知识库 → 代码图谱」查看）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        code_graph_id: { type: 'string', description: '代码图谱 ID（必填，形如 cg-…）' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query', 'code_graph_id'], additionalProperties: false,
    },
    run: (c, a) => c.codegraphSearch(a),
  },
  {
    name: 'tdai.codegraph_explore',
    description: '从某节点出发探索邻域（调用/被调用/引用）。必须先指定 code_graph_id（形如 cg-…）。',
    inputSchema: {
      type: 'object',
      properties: {
        code_graph_id: { type: 'string', description: '代码图谱 ID（必填，形如 cg-…）' },
        node_id: { type: 'string' },
        depth: { type: 'number', default: 1 },
      },
      required: ['code_graph_id'], additionalProperties: false,
    },
    run: (c, a) => c.codegraphExplore(a),
  },
];

/* ---------- stdio MCP 服务器 ---------- */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function mcpText(payload) {
  // MCP 规范：tool result 是 content 数组
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text: core.clip(text) }] };
}

async function handle(client, msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params && params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VER },
      });
    case 'notifications/initialized':
    case 'initialized':
      return; // 无 id，通知不回
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === (params && params.name));
      if (!t) return replyErr(id, -32602, `未知工具 ${params && params.name}`);
      try {
        const r = await t.run(client, params.arguments || {});
        return reply(id, mcpText(r));
      } catch (e) {
        return reply(id, mcpText(core.err(`工具异常: ${e.message}`)));
      }
    }
    default:
      if (id !== undefined) replyErr(id, -32601, `方法未实现: ${method}`);
  }
}

async function serveMCP() {
  const client = core.create();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch (_) { return; }
    try { await handle(client, msg); } catch (e) {
      if (msg.id !== undefined) replyErr(msg.id, -32603, e.message);
    }
  });
  // 保活：stdin 不关就一直跑
}

/* ---------- CLI 模式 ---------- */

async function runCLI(argv) {
  const client = core.create();
  const cmd = argv[0];
  if (cmd === 'list') {
    console.log(JSON.stringify(TOOLS.map(({ name, description }) => ({ name, description })), null, 2));
    return;
  }
  if (cmd === 'run') {
    const toolName = argv[1];
    const jIdx = argv.indexOf('--json');
    let args = {};
    if (jIdx > -1 && argv[jIdx + 1]) {
      try { args = JSON.parse(argv[jIdx + 1]); } catch (e) {
        console.error('--json 解析失败:', e.message); process.exit(2);
      }
    }
    const t = TOOLS.find((x) => x.name === toolName);
    if (!t) { console.error(`未知工具 ${toolName}，用 list 查看`); process.exit(2); }
    const r = await t.run(client, args);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'probe') {
    // Phase 0 探针：全工具一遍，冻结响应样例。
    // 占位值按**参数名**推导（早先是硬编码的 page_id/node_id 三元表达式，
    // schema 一改就悄悄喂错参数，探针结果失去意义）。
    const placeholder = (k) => {
      if (k === 'query') return '测试';
      if (k === 'wiki_id') return 'wiki-probe';
      if (k === 'code_graph_id') return 'cg-probe';
      if (k === 'skill_id') return 'skill-probe';
      if (k === 'name') return 'probe';
      if (k === 'block_id' || k === 'agent_id' || k === 'team_id' || k === 'page_id' || k === 'node_id') return 'probe';
      if (Array.isArray(k)) return [];
      return 'probe';
    };
    const results = {};
    for (const t of TOOLS) {
      const sch = t.inputSchema || {};
      const required = (sch.required || []).slice();
      // anyOf 里的"至少给一个"字段也要喂占位值，否则探针会拿到
      // "缺少 X" 这类参数校验错误，看起来像接口坏了（实际是探针没给参数）。
      for (const branch of (sch.anyOf || [])) {
        const r = (branch && branch.required) || [];
        if (r.length && !r.some((k) => required.includes(k))) required.push(r[0]);
      }
      const args = Object.fromEntries(required.map((k) => [k, placeholder(k)]));
      try { results[t.name] = await t.run(client, args); }
      catch (e) { results[t.name] = { ok: false, error: (e && e.message) || String(e) }; }
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.error(`用法:
  node tdai-mcp.js                 # MCP 服务器 (stdio)
  node tdai-mcp.js list            # 列出工具
  node tdai-mcp.js run <tool> --json '{...}'
  node tdai-mcp.js probe           # Phase 0 全端点探针`);
  process.exit(cmd ? 2 : 0);
}

/* ---------- 入口 ---------- */

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) serveMCP().catch((e) => { console.error(e); process.exit(1); });
  else runCLI(argv).catch((e) => { console.error(e); process.exit(1); });
}
