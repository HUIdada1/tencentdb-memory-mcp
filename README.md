# TD 记忆守护（TencentDB Memory MCP）

腾讯云 TencentDB 记忆库的无感接入工具集：**Agent 按需检索（MCP）** + **后台自动采集上传与注入（守护进程）**。零 npm 依赖（守护进程/MCP 侧），纯 Node，密钥不出本机。

> **Node 版本要求**（按形态分列，别装错）
>
> | 形态 | 要求 | 原因 |
> |---|---|---|
> | **桌面应用**（`pet/`，exe 安装版） | Node **≥22.16.0** | 会话扫描用内置 `node:sqlite` 读 ZCode 会话库；低版本会**静默降级**成只扫归档文件目录，你会看到几个月前的旧会话 |
> | 守护进程 / MCP / core / CLI | Node **≥16.0.0** | 零依赖、内置 `http`/`https`/`fetch`（16 无原生 fetch 时自动走 http 模块） |
>
> 装桌面应用的用户**不需要自己装 Node**（安装包已内置 Electron 运行时）。这一条只影响**从源码跑 `pet/`** 的开发者。

- 仓库：https://github.com/HUIdada1/tencentdb-memory-mcp
- 发版（exe 下载）：https://github.com/HUIdada1/tencentdb-memory-mcp/releases
- 架构：**Push（扫本地会话文件增量上传）与 Pull（hook 强制注入 / MCP 按需检索）彻底解耦**，与用哪个模型/服务商聊天无关，不经过 NAS proxy（8096）。

## 两种使用形态

| 形态 | 适合谁 | 首次接入怎么做 |
|---|---|---|
| **桌面应用**（`TDMemoryGuard-Setup-x.y.z.exe`，NSIS 安装版 / 便携版） | 只想点几下就用的人 | 应用内 **设置 → 记忆库连接**（填 4 项）→ **设置 → Agent 接入 → 一键接入**。应用**内置守护进程**，不需要额外装任何东西（不需要 Node、不需要源码） |
| **命令行守护**（`tdai-daemon-vX.Y.Z-win-x64.exe`，Node SEA 单文件） | 服务器/无界面环境、或只想跑后台 | 跑一次 `node register-all.cjs`（源码）或手动写各客户端配置；exe 自带网页控制台 |

两者**共用同一份配置** `~/.zcode/tdai-mcp.json` 与同一套运行时数据 `~/.zcode/tdai-daemon/`，可同时存在：谁先占用 `127.0.0.1:8100` 谁提供检索服务，另一个自动降级、不做重复采集（桌面应用界面会显示「外部进程」）。

> 📖 **第一次装？看 [INSTALL.md](INSTALL.md)** —— 面板侧准备、三条安装路径、配置字段速查、9 条常见问题（含会话只显示旧数据、链路测试失败、双守护等）。

## 目录结构

```
├─ core/tdai-core.js             # 零依赖客户端：配置加载、面板 API 封装、只读检索 + 会话导入
├─ daemon/tdai-daemon.js         # 守护进程（单文件自包含，可打包 SEA exe，也可被桌面应用 require 复用）
│   ├─ serve（默认）              #   HTTP :8100（控制台 + recall/push/health + 配置 API）+ 2 分钟采集上传循环
│   ├─ push / hook / health      #   立即上传一轮 / recall hook 入口 / 健康状态
│   └─ console.html              #   网页控制台（GET http://127.0.0.1:8100/）
├─ mcp/tdai-mcp.js               # MCP server（stdio，tdai_* 只读工具）+ CLI 双模式
├─ pet/                          # Electron 桌面应用（控制台 + 内置守护 + 一键接入 + 热更新）
│   ├─ src/main.js               #   主进程：窗口/托盘/IPC/配置真源/守护宿主
│   ├─ src/guard.js              #   应用内守护宿主（复用 daemon 模块，端口冲突自动降级）
│   ├─ src/register.js           #   Agent 接入：状态检测 + 一键注册（纯 Node，可单测）
│   ├─ src/console.html/js/css   #   控制台界面（总览/记忆/技能/Wiki/图谱/设置）
│   └─ src/updater.js            #   更新模块（安装版热更新 / 便携版比对 latest.yml）
├─ register-all.cjs              # 源码用户一键注册：全客户端 MCP + Claude Code hook + 指令文件 + 可选自启
├─ test/                         # 功能校验：daemon 端到端 / 接入模块 / UI 静态一致性
├─ skills/tdai-memory/SKILL.md   # ZCode skill 兜底（无 MCP 客户端走 CLI）
├─ .github/workflows/release.yml # 发版流水线：双产物（Electron 应用 + SEA daemon exe）
└─ sea-config.json               # SEA 打包配置（内嵌 console.html）
```

## 首次使用：Agent 怎么连？

**装一次就永久生效**，之后每次对话都不用手动指定任何东西。三条路径，按你装的东西选一条：

1. **桌面应用用户（推荐）**：`设置 → Agent 接入 → 一键接入`。它会把 `tdai` 记忆工具写进本机**已安装**的客户端配置（ZCode CLI / Claude Code / Cursor / Codex），并追加全局指令文件（`~/.zcode/AGENTS.md`、`~/.claude/CLAUDE.md`）；未安装的客户端自动跳过，重复点击不会重复写入。
   注册用的命令是**应用自身**（`ELECTRON_RUN_AS_NODE` 模式跑打包内的 `mcp/tdai-mcp.js`），所以换电脑、没装 Node、没有源码都能用。
2. **后台自动（无需任何接入操作）**：桌面应用或 daemon exe 运行期间会自动采集各 Agent 的会话增量上传到记忆库，并在本机 `127.0.0.1:8100` 提供记忆检索服务（hook 用）。桌面应用关窗后仍在托盘运行，勾上「开机自启」即全程无感。
3. **源码/CLI 用户**：`node register-all.cjs`（MCP 全客户端 + Claude Code hook + 指令文件），`--autostart` 追加登录自启。

### 接入状态提示

`设置 → Agent 接入` 会实时检测并显示每个客户端的状态：

| 状态 | 含义 | 处理 |
|---|---|---|
| 已接入 | 配置里已有 `tdai`，且标注「本应用接入」或「由 xxx 接入」 | 无需操作 |
| 未接入 | 客户端已安装但没写配置 | 点「一键接入」即可 |
| 未装客户端 | 本机没有该客户端 | 自动跳过，无需理会 |

Claude Code 额外标注 **hook 已注入 / hook 未注入**：注入后每次提问前自动检索相关记忆并注入上下文（不依赖模型主动调用）。**首次使用时 Claude Code 会提示「信任」该 hook，点一次即可**；未信任时静默不执行，MCP + 指令文件仍兜底。

## 本地控制台

**桌面应用**：设置页分四类（每项带小问号悬浮解释）

| 分类 | 内容 |
|---|---|
| 记忆库连接 | panelUrl / userKey / teamId / agentId / taskId / blockId，**保存配置**（写 `.zcode/tdai-mcp.json`，备份 `.bak`）、**链接测试**（面板可达 + User Key 认证） |
| Agent 接入 | 首次使用引导 + 一键接入 + 各客户端接入状态 + 写入明细 |
| 更新 | 当前版本 / 检查更新 / 下载 / 重启安装 / 查看 Releases（安装版一键更新，便携版跳转手动下载） |
| 通用 | 主题、开机自启（后台静默）、自动检查更新、关于（版本 / 程序路径 / 配置文件） |

顶栏另有 总览（连接状态、延迟、守护状态、待上传队列、最近记忆、快速检索、运行信息）、记忆（检索 + L1/L2/L3 分层）、技能、Wiki、图谱。无数据一律显示 `-`。

**命令行守护**：运行后打开 **http://127.0.0.1:8100/**，四个 tab：连接（配置 + 链接测试）、Agent 接入（引导 + 状态）、状态（守护/NAS/队列/版本）、设置（检查更新）。

## 快速开始（源码）

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

| 目标 | 动作 |
|---|---|
| ZCode CLI | `~/.zcode/cli/config.json` 的 `mcp.servers.tdai` |
| Claude Code | `~/.claude.json` 的 `mcpServers.tdai` + `settings.json` 的 `UserPromptSubmit` hook |
| Cursor | `~/.cursor/mcp.json` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.tdai]` |
| 全局指令文件 | `~/.zcode/AGENTS.md` / `~/.claude/CLAUDE.md` 追加记忆检索硬规则（幂等标记 `tdai-memory:begin`） |

### 3. 启动守护进程

```bash
node daemon/tdai-daemon.js        # serve：:8100 服务 + 采集上传循环
node daemon/tdai-daemon.js push   # 手动触发一轮采集上传
```

发版 exe 同样支持：`tdai-daemon.exe [serve|push|hook|health]`。

## 工作原理

### Push（自动上传，无感）

守护进程每 2 分钟扫描本地会话落盘文件：

| 客户端 | 路径 |
|---|---|
| ZCode CLI | `~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl` |
| Claude Code | `~/.claude/projects/<proj>/<sid>.jsonl` |

- **字节偏移增量游标**（持久化 `~/.zcode/tdai-daemon/cursors.json`），首见按当前大小做种子，**不回传历史**
- 只上传完整轮次；单条消息切片 ≤8192 字符（面板硬限制）
- NAS 离线进**本地队列**（`~/.zcode/tdai-daemon/queue/`，上限 200），恢复后自动补传，不丢数据
- 上传走面板 API：`/chat-memory/import` + `/skill/conversation/add`（触发 L1/技能抽取）

### Pull（自动检索，无感）

两路并存，互为托底：

- **档 A · hook 强制注入（主）**：`UserPromptSubmit` hook（Claude Code 全局 / ZCode 项目级）调用本地 `:8100/recall`，**800ms 硬超时**（超时返回空，绝不阻塞对话）。意图门控：命中「之前/上次/还记得…」才做远程 search；未命中只注入缓存的技能目录固定块；单次注入 ≤2KB；NAS 离线静默降级。
- **档 B · MCP + 指令文件（兜底）**：`tdai-mcp.js` 注册进客户端配置后每次会话自动可用；指令文件写死触发规则。11 个只读工具：`tdai.health / my_agents / memory_search / memory_layers / team_assets / skill_list / skill_get / wiki_search / wiki_read / codegraph_search / codegraph_explore`（CLI 兜底：`node mcp/tdai-mcp.js run <tool> --json '{...}'`）。

### 托底判断

| 失效环节 | 行为 |
|---|---|
| NAS 离线 | 检索返回空静默降级；上传进本地队列补传 |
| hook 未信任 / :8100 挂 | 档 B（MCP + 指令文件）兜底 |
| 桌面应用未运行 | 采集暂停（已采集的不丢）；重开即续传 |
| 两个守护同时在跑 | 后启动者自动降级（不抢端口、不重复采集） |
| userKey 失效 | `/health` 的 `nas:false` + 配置完整性可查 |
| MCP 客户端不可用 | skill 兜底 `skills/tdai-memory/SKILL.md` |

## 运行时数据

- 配置（唯一真源）：`~/.zcode/tdai-mcp.json`（守护进程 / MCP / hook / 桌面应用共用）
- 应用偏好：`~/.zcode/tdai-app.json`（主题 / 开机自启 / 自动检查更新）
- 运行数据：`~/.zcode/tdai-daemon/`（`cursors.json` 增量游标、`queue/` 离线积压、`daemon.log`）——删除即重置

## 测试

```bash
node test/functional.test.js   # 守护进程端到端（隔离 HOME + mock 面板，17 项）
node test/register.test.js     # Agent 接入模块（隔离 HOME，27 项）
node test/ui.test.js           # 控制台 UI 静态一致性（DOM/IPC/API 对齐，13 项）
```

## 发版

根 `package.json` / `pet/package.json` / `daemon` 内 `APP_VER` 三处版本号同步递增 → 触发 GitHub Actions `Release` workflow（手动）→ 双产物发布到同一 Release：

- **桌面应用**（`electron-builder --win --publish always`）：`TDMemoryGuard-Setup-x.y.z.exe`（NSIS 安装版，热更新）+ `TDMemoryGuard-x.y.z-portable.exe`（便携版）+ `latest.yml`/blockmap
- **守护进程** `tdai-daemon-vX.Y.Z-win-x64.exe`（SEA 单文件，构建前后各自检）

```bash
gh workflow run release.yml -f version=0.4.0
```

> `appId`（`com.tdai.pet`）**不可更改**：NSIS 升级按它派生 GUID 识别旧版本，改了会让老用户的升级路径断裂。应用显示名与快捷方式始终是「TD记忆守护」。

### 更新机制

- **安装版**：electron-updater 启动 60 秒后首查 + 每小时一查（可在设置里关），下载/安装均由用户触发（`autoDownload=false`）
- **便携版**：只读 `releases/latest/download/latest.yml` 比对版本并提示手动下载；exe 同目录放 `portable.flag` 可手动开启便携模式

## 注意事项

- Windows：脚本全程 UTF-8（Node `JSON.stringify`）；不要用 Git Bash 内联 `curl -d` 传中文（GBK 乱码）
- hook 场景 stdin 可能不关闭，daemon hook 子命令限时 300ms 收数
- 检索的 `block_id` 默认 `chat-memory`，可在配置里加 `"blockId"` 按面板实际取值覆盖
- 本机 Node 16 无 fetch 也能跑（内置 http/https）；守护进程/MCP 侧要求 Node ≥16，桌面应用（源码运行）要求 Node ≥22.16.0（见文首版本表）

## 贡献

欢迎 Issue / PR。提交前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)（提交信息规范、代码范围划分、测试要求）。

- 报 Bug 请用 [Issue 模板](.github/ISSUE_TEMPLATE/bug_report.md)，附上 `设置 → 关于` 里的版本号与「实时日志」里的相关行
- 跑一遍全量测试：`npm run test:all`
- 版本变更见 [CHANGELOG.md](CHANGELOG.md)

## 许可证

[MIT](LICENSE) © 2026 TD 记忆守护 contributors

本项目与腾讯云 TencentDB 官方仓库（[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)）**无隶属关系**，是社区侧的接入工具；「腾讯云」「TencentDB」等商标归其各自权利人所有。
