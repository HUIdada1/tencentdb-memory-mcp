---
name: tdai-memory
description: TD 团队记忆检索（NAS TencentDB Agent Memory）。当用户问"我们之前关于 X 是怎么做的 / 上次怎么处理 / 还记得吗"等回忆类问题时使用；也用于查团队技能、Wiki 文档、代码图谱。
---

# TD 团队记忆检索

通过本地 CLI 检索 NAS 上的团队记忆库（对话记忆 L1/L2/L3、技能、Wiki、代码图谱）。配置在 `~/.zcode/tdai-mcp.json`（panelUrl/userKey/teamId/agentId），密钥不出本机。

## 何时用

- 用户提到「之前」「上次」「我们怎么做的」「还记得」等回忆类表述 → 先 `tdai.my_agents` 拿过滤维度，再 `tdai.memory_search` 检索，基于结果回答并标注来源，**不要凭猜测回答历史问题**
- 需要团队技能 / Wiki / 代码图谱 → `tdai.skill_list` / `tdai.wiki_search` / `tdai.codegraph_search`

## 怎么用（CLI 模式，无 MCP 时兜底）

```bash
node <本仓库>/mcp/tdai-mcp.js run tdai.memory_search --json '{"query":"登录 XSS 怎么修的"}'
node <本仓库>/mcp/tdai-mcp.js run tdai.skill_list --json '{}'
node <本仓库>/mcp/tdai-mcp.js list   # 全部工具
```

支持 MCP 的客户端优先走 MCP（`register-all.cjs` 一键注册，工具名同上）；本 CLI 是无 MCP 客户端的兜底。

## 注意

- NAS 离线返回「记忆库不可达」时如实告知，不要编造记忆内容
- 检索结果为空时说明"记忆库中暂无相关记录"，不要装作查过
