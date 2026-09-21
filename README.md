# TD 记忆守护（TencentDB Memory MCP）

腾讯云 TencentDB 记忆库的无感接入工具集：**MCP Server**（Agent 按需检索）+ **后台守护进程**（自动采集上传 + 本地 recall 注入服务）。零 npm 依赖，纯 Node ≥16，密钥不出本机。

- 仓库：https://github.com/HUIdada1/tencentdb-memory-mcp
- 发版（exe 下载）：https://github.com/HUIdada1/tencentdb-memory-mcp/releases
- 架构：**Push（扫本地会话文件增量上传）与 Pull（hook 强制注入 / MCP 按需检索）彻底解耦**，与用哪个模型服务商聊天完全无关，不经过 NAS proxy（8096）。

## 目录结构

```
├─ core/tdai-core.js             # 零依赖客户端：配置加载、面板 API 封装、只读检索 + 会话导入
├─ daemon/tdai-daemon.js         # 守护进程（单文件自包含，可打包 SEA exe）
│   ├─ serve（默认）              #   HTTP :8100（控制台 + recall/push/health + 配置 API）+ 2 分钟采集上传循环
│   ├─ push                      #   立即采集上传一轮
│   ├─ hook                      #   recall hook 入口（stdin/--q → /recall → stdout）
│   └─ health                    #   健康状态
│   └─ console.html              #   本地控制台页（GET http://127.0.0.1:8100/）
├─ mcp/tdai-mcp.js               # MCP server（stdio，tdai_* 只读工具）+ CLI 双模式
├─ pet/                          # Electron 桌宠应用（NSIS 安装版 + 便携版 + electron-updater 热更新）
├─ register-all.cjs              # 一键注册：全客户端 MCP + Claude Code hook + 指令文件 + 可选自启
├─ skills/tdai-memory/SKILL.md   # ZCode skill 兜底（无 MCP 客户端走 CLI）
├─ .github/workflows/release.yml # 发版流水线（Node SEA 单文件 exe → GitHub Releases）
├─ sea-config.json               # SEA 打包配置（内嵌 console.html）
└─ package.json                  # 版本号（发版用）
```

## 本地控制台

守护进程运行时打开 **http://127.0.0.1:8100/**，四个 tab：

| Tab | 内容 |
|---|---|
| 连接 | panelUrl / userKey / teamId / agentId / taskId / blockId 配置（每项带小问号悬浮解释）、**保存配置**、**链接测试**（面板可达性 + 认证） |
| Agent 接入 | **第一次使用引导**（Agent 怎么连：后台自动处理 / MCP 安装 / hook 信任说明）+ 各客户端接入状态实时检测（已接入 / 未接入 / 未安装） |
| 状态 | 守护进程 / NAS 可达性 / 配置完整性 / hook 调用次数 / 最近上传 / 离线队列（无数据显示 `-`） |
| 设置 | **检查更新**（线上最新 release vs 当前版本）+ 更新方式说明 |

配置在控制台保存后立即生效（写 `~/.zcode/tdai-mcp.json`，原文件备份为 `.bak`），userKey 只回显脱敏形式。

## 首次使用：Agent 怎么连？

分两种方式，**装一次就永久生效，之后每次对话都不用手动指定任何东西**：

1. **后台自动处理（推送 + 注入）**——守护进程启动后无需任何配置：自动采集各 Agent 的会话增量上传记忆库（Push）；登录自启用 `node register-all.cjs --autostart`。
2. **MCP 安装（Agent 主动检索）**——跑一次 `node register-all.cjs`：自动把记忆工具写进本机所有支持 MCP 的客户端配置（ZCode / Claude Code / Cursor / Codex），并追加全局指令文件（档 B 兜底）。之后每个新会话自动携带记忆工具，模型需要时自主调用（Pull）。

Claude Code 额外注入 `UserPromptSubmit` hook：每次提问前自动检索相关记忆并注入上下文，真正无感（不依赖模型主动调用）。**首次使用时客户端会提示「信任」该 hook，点一次即可**；未信任时 hook 静默不执行，MCP + 指令文件仍兜底。

**接入状态提示**：控制台「Agent 接入」tab 实时显示每个客户端的接入状态（已接入 / 未接入 / 未安装客户端），未接入的给出 `register-all.cjs` 一键修复提示。

## 快速开始

### 1. 配置

写 `~/.zcode/tdai-mcp.json`（资产 ID 从面板获取；env `TDAI_PANEL_URL` 等同权覆盖）：

```json
{
  "panelUrl": "http://<nas-host>:8125",
  "userKey": "sk-mem-...",
  "teamId": "team-...",
  "agentId": "agt-..."
}
```

### 2. 一键注册（幂等，跑前自动备份）

```bash
node register-all.cjs              # MCP 全客户端 + Claude Code hook + 指令文件
node register-all.cjs --autostart  # 同时写启动文件夹 VBS，登录自启守护进程
node register-all.cjs --no-hook --no-instructions  # 只注册 MCP
```

注册内容：

| 目标 | 动作 |
|---|---|
| ZCode CLI | `~/.zcode/cli/config.json` 的 `mcp.servers.tdai` |
| Claude Code | `~/.claude.json` 的 `mcpServers.tdai` + `settings.json` 的 `UserPromptSubmit` hook |
| Cursor | `~/.cursor/mcp.json` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.tdai]` |
| 全局指令文件 | `~/.zcode/AGENTS.md` / `~/.claude/CLAUDE.md` 追加记忆检索硬规则（幂等标记 `tdai-memory:begin`） |

> ZCode 的 hook 配置是**项目级**且需在客户端点一次「信任」；未信任时 hook 静默不执行，MCP + 指令文件（档 B）仍兜底。

### 3. 启动守护进程

```bash
node daemon/tdai-daemon.js        # serve：:8100 服务 + 采集上传循环
node daemon/tdai-daemon.js push   # 手动触发一轮采集上传
```

或用 `--autostart` 注册的 VBS（登录自启）。发版 exe 同样支持：`tdai-daemon.exe [serve|push|hook|health]`。

## 工作原理

### Push（自动上传，无感）

守护进程每 2 分钟扫描本地会话落盘文件：

| 客户端 | 路径 | 优先级 |
|---|---|---|
| ZCode CLI | `~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl` | P0 |
| Claude Code | `~/.claude/projects/<proj>/<sid>.jsonl` | P0 |

- **字节偏移增量游标**（持久化 `~/.zcode/tdai-daemon/cursors.json`），首见按当前大小做种子，**不回传历史**
- 只上传完整轮次；单条消息切片 ≤8192 字符（面板硬限制）
- NAS 离线进**本地队列**（`~/.zcode/tdai-daemon/queue/`，上限 200），恢复后自动补传，不丢数据
- 上传走面板 API：`/chat-memory/import` + `/skill/conversation/add`（触发 L1/技能抽取）
- `upload.enabledSources` 白名单控制哪些客户端入库；agent 缺失时按配置尝试自动创建（`daemon-<source>`）

### Pull（自动检索，无感）

两路并存，互为托底：

- **档 A · hook 强制注入（主）**：`UserPromptSubmit` hook（Claude Code 全局 / ZCode 项目级）调用本地 `:8100/recall`，**800ms 硬超时**（超时返回空，绝不阻塞对话）。意图门控：命中「之前/上次/还记得…」才做远程 search；未命中只注入缓存的技能目录固定块；单次注入 ≤2KB；NAS 离线静默降级。
- **档 B · MCP + 指令文件（兜底）**：`tdai-mcp.js` 注册进客户端配置后每次会话自动可用；指令文件写死触发规则。9 个只读工具：`tdai.health / my_agents / memory_search / memory_layers / team_assets / skill_list / skill_get / wiki_search / wiki_read / codegraph_search / codegraph_explore`（CLI 兜底：`node mcp/tdai-mcp.js run <tool> --json '{...}'`）。

### 托底判断

| 失效环节 | 行为 |
|---|---|
| NAS 离线 | 检索返回空静默降级；上传进本地队列补传 |
| hook 未信任 / :8100 挂 | 档 B（MCP + 指令文件）兜底 |
| userKey 失效 | `/health` 的 `nas:false` + `configOk` 可查 |
| MCP 客户端不可用 | skill 兜底 `skills/tdai-memory/SKILL.md` |

## 运行时数据

全部在 `~/.zcode/tdai-daemon/`：`cursors.json`（增量游标）、`queue/`（离线积压）、`daemon.log`。删除即重置。

## 发版

`pet/package.json` 与根 `package.json` 版本号同步递增 → GitHub Actions `Release` workflow（手动触发）→ 双产物发布到 GitHub Releases（参照 AgentHub 发版模式）：

- **Electron 宠物应用**（`npx electron-builder --win --publish always`）：NSIS 安装版 `TDMemoryPet-Setup-vX.Y.Z.exe` + 便携版 + `latest.yml`/blockmap（tag 与 Release 由 electron-builder 自动创建）
- **Node SEA 单文件守护进程** `tdai-daemon-vX.Y.Z-win-x64.exe`（构建前后各跑一轮冒烟自检，构建完成后上传到同一 Release）
- 发布后校验 `latest.yml` 可下载且版本匹配——安装版 electron-updater 与便携版的更新检查都依赖该资产

```bash
gh workflow run release.yml -f version=0.3.0
```

### 更新机制（同 AgentHub）

- **安装版**：electron-updater 启动 60 秒后首查 + 每小时一查，下载/安装均由用户触发（`autoDownload=false`）
- **便携版**：只读 `releases/latest/download/latest.yml` 比对版本并提示手动下载；exe 同目录放 `portable.flag` 可手动开启便携模式

## 注意事项

- Windows：脚本全程 UTF-8（Node `JSON.stringify`）；不要用 Git Bash 内联 `curl -d` 传中文（GBK 乱码）
- hook 场景 stdin 可能不关闭，daemon hook 子命令限时 300ms 收数
- 检索的 `block_id` 默认 `chat-memory`，可在配置里加 `"blockId"` 按面板实际取值覆盖
- 本机 Node 16 无 fetch 也能跑（内置 http/https），推荐 Node ≥18
