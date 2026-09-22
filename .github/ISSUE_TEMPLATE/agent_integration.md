---
name: 接入问题
about: 某个 Agent 客户端连不上、状态显示不对、hook 不生效
title: '[接入] '
labels: ['agent-integration']
assignees: ''
---

<!--
⚠️ 不要把 userKey / token / 内网地址贴进来。
-->

## 哪个客户端

- [ ] ZCode CLI
- [ ] Claude Code
- [ ] Cursor
- [ ] Codex
- [ ] Trae
- [ ] DeepSeek Harness
- [ ] 其它（请注明）：

## 你在哪里看到的

- [ ] 桌面应用 → 顶栏「Agent 接入」页
- [ ] 网页控制台 http://127.0.0.1:8100/ → 「Agent 接入」tab
- [ ] 客户端本身（对话里调不到 `tdai.*` 工具）

## 状态显示

<!-- 照抄界面上那一行，例如：「未接入 · hook 未注入」/「已接入 · 本应用接入」 -->

## 已尝试

- [ ] 点过「一键接入」
- [ ] 重启过（客户端 / 应用 / 守护进程）
- [ ] Claude Code：在客户端里点过 hook 的「信任」（首次必须点一次，未信任时静默不执行）
- [ ] 源码用户：跑过 `node register-all.cjs`

## 相关文件内容

<!--
请贴下面这些文件的内容（**先删掉 userKey 等敏感值**）：
- ZCode CLI：`~/.zcode/cli/config.json` 的 `mcp.servers.tdai` 与 `hooks.UserPromptSubmit` 部分
- Claude Code：`~/.claude.json` 的 `mcpServers.tdai` 部分 + `~/.claude/settings.json` 的 hook 部分
- Cursor：`~/.cursor/mcp.json`
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.tdai]` 段
- Trae：`~/.trae/mcp.json`
- DeepSeek Harness：`~/.dsh/profiles/<profile>/cordis.patch.yml`
- 指令文件：`~/.zcode/AGENTS.md`、`~/.claude/CLAUDE.md` 里 `tdai-memory:begin` 附近的块
-->

```json
在此粘贴（已打码）
```

## 环境

- 使用形态：桌面应用 / 命令行守护 / 源码运行
- 应用版本：
- Node 版本：
