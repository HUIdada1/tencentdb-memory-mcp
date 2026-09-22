---
name: Bug 报告
about: 报告一个可复现的问题
title: '[Bug] '
labels: ['bug']
assignees: ''
---

<!--
⚠️ 提交前请先删除本段说明。
⚠️ 不要把 userKey / token / 内网地址贴进来（请用 sk-mem-*** 打码）。
-->

## 环境

- 使用形态（勾一个）：
  - [ ] 桌面应用（`TDMemoryGuard-Setup-x.y.z.exe` 安装版 / 便携版）
  - [ ] 命令行守护（`tdai-daemon-vX.Y.Z-win-x64.exe`，SEA 单文件）
  - [ ] 从源码运行（`node daemon/tdai-daemon.js`）
- 应用版本（`设置 → 关于` 或 exe 文件名）：
- 操作系统：Windows 版本号
- Node 版本（源码运行 / 桌面应用请写；exe 用户可留空）：
- 涉及的 Agent 客户端：ZCode CLI / Claude Code / Cursor / Codex / Trae / DeepSeek Harness

## 现象

<!-- 一句话说清"本来应该怎样，实际怎样" -->

## 复现步骤

1.
2.
3.

## 期望结果

## 实际结果

## 日志与截图

<!--
哪里拿日志：
- 桌面应用：总览页「实时日志」区（可截图）；
  运行数据目录 `~/.zcode/tdai-daemon/daemon.log`
- 命令行守护：控制台输出，或 `~/.zcode/tdai-daemon/daemon.log`
- 网页控制台：http://127.0.0.1:8100/ 的「状态」tab
请贴相关行（含时间戳），不要把整个日 bundle 贴进来。
-->

```
在此粘贴日志
```

## 自查清单

- [ ] 已确认不是"客户端未装"或"未点一键接入"（`设置 → Agent 接入` 看得到状态）
- [ ] 已确认 `~/.zcode/tdai-mcp.json` 里的 panelUrl / userKey / teamId / agentId 填写正确
      （`设置 → 记忆库连接 → 链接测试` 能过）
- [ ] 已尝试重启应用 / 重启守护进程后仍复现
- [ ] 若为"会话列表看不到最近的对话"：已检查 Node 版本是否 ≥22.16.0
      （低版本会降级成只扫归档目录，界面会有黄色警告横幅）
