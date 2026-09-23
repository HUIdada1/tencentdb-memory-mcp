# 安装与接入指南

面向**第一次使用**的人。三条安装路径选一条，再按"面板侧准备 → 本机配置 → Agent 接入"三步走完。

> 只想快速跑起来 → 看 [快速开始](#三桌面应用推荐路径)。遇到问题 → 直接跳 [常见问题](#七常见问题)。

---

## 一、先理解三个角色

装之前先分清"谁在做什么"，后面的步骤才不会拧：

| 角色 | 是什么 | 你需要做什么 |
|---|---|---|
| **记忆库面板** | 腾讯云 TencentDB 记忆库的 Web 控制台（你团队的地址，形如 `http://<host>:8125`） | 在面板上建团队/Agent，拿到 4 个 ID 与一个 User Key |
| **本工具**（本项目） | 跑在你机器上的采集与检索程序 | 装它、填配置、点一键接入 |
| **Agent 客户端** | ZCode CLI / Claude Code / Cursor / Codex / Trae / DeepSeek Harness / CodeBuddy / WorkBuddy / OpenCode / Hermes / OpenClaw / Pi | 本工具会自动把 `tdai` 记忆工具写进它的配置 |

数据流是**双向**的，但两条链路互相独立：

- **Push**（自动上传）：本工具每 2 分钟扫本地会话文件，把增量传到面板 → 你**不用做任何事**
- **Pull**（自动检索）：Agent 提问时，由 hook 注入相关记忆 / 或模型主动调 `tdai.*` 工具

> ⚠️ 本工具**不碰 LLM 链路**：不改 `ANTHROPIC_BASE_URL`、不做反向代理、不经过 NAS proxy。
> 所以换模型、换服务商都不影响它。

---

## 二、三条安装路径，选一条

| 路径 | 适合谁 | 要不要装 Node | 接入方式 |
|---|---|---|---|
| **A. 桌面应用**（推荐） | 只想点几下就用 | **不需要**（安装包内置 Electron） | 应用内一键接入 |
| **B. 命令行守护 exe** | 服务器 / 无界面环境 | **不需要** | 手动写各客户端配置，或用源码版脚本 |
| **C. 从源码运行** | 要改代码 / 参与开发 | 需要（见下表） | `node register-all.cjs` |

### Node 版本要求（按路径分列，别装错）

| 路径 | 最低 Node | 原因 |
|---|---|---|
| A. 桌面应用（安装包） | 不需要 | Electron 运行时已内置 |
| A'. 桌面应用（**源码**跑 `pet/`） | **≥22.16.0** | 会话扫描用内置 `node:sqlite` 读 ZCode 会话库。低版本会**静默降级**成只扫归档目录 → 你只能看到几个月前的旧会话（界面有黄色警告横幅提示） |
| B. 命令行守护 exe | 不需要 | 已编译进 exe |
| C. 源码运行（`core`/`daemon`/`mcp`/`register-all.cjs`） | **≥16.0.0** | 零依赖，内置 `http`/`https`；16 无原生 `fetch` 时自动走 http 模块 |

---

## 三、桌面应用（推荐路径）

### 步骤 0 · 面板侧准备（先做这步，后面要用到 4 个 ID）

在记忆库面板上：

1. **建团队**（Team）→ 记下 `teamId`，形如 `team-zn0elw0289`
2. 在团队下**建 Agent** → 记下 `agentId`，形如 `agt-zoav7zxdz0`
3. 给这个 Agent 创建一个**业务用户**并签发 **User Key** → 记下 `userKey`，形如 `sk-mem-...`
4. 确认面板地址（`panelUrl`），形如 `http://<host>:8125`

> 4 个值：`panelUrl` / `userKey` / `teamId` / `agentId`。`taskId` 与 `blockId` 通常不用填。
> `blockId` 留空时按 `chat_memory-<teamId>-<agentId>` 自动拼接，与面板默认一致。

### 步骤 1 · 装应用

从 [Releases](https://github.com/HUIdada1/tencentdb-memory-mcp/releases) 下载二选一：

| 文件 | 特点 |
|---|---|
| `TDMemoryGuard-Setup-x.y.z.exe` | NSIS 安装版。**支持应用内热更新**（启动 60 秒后首查 + 每小时一查） |
| `TDMemoryGuard-x.y.z-portable.exe` | 便携版。不写注册表；更新时跳转 Releases 手动下载 |

> **`appId`（`com.tdai.pet`）不可更改** —— NSIS 升级按它派生 GUID 识别旧版本，改了会让老用户升级路径断裂。

### 步骤 2 · 填配置

打开应用 → 顶栏 **设置** → 左栏 **记忆库连接** → 填入 4 个值 → 点 **保存配置**。

- 保存会写 `~/.zcode/tdai-mcp.json`，并自动备份一份 `.bak`
- 然后点 **链接测试**：面板可达 + User Key 认证两项都要过。失败时看提示里的具体原因

### 步骤 3 · 一键接入 Agent

顶栏 **Agent 接入** → 点 **一键接入**。

它会：

- 把 `tdai` 记忆工具写进本机**已安装**的客户端配置（未安装的自动跳过）
- 给 Claude Code 与 ZCode CLI 注入 `UserPromptSubmit` hook（提问前自动检索记忆）
- 追加全局指令文件 `~/.zcode/AGENTS.md`、`~/.claude/CLAUDE.md`
- **重复点击是幂等的**，不会重复写入

> 注册命令用的是**应用自身**（以 `ELECTRON_RUN_AS_NODE` 模式跑包内的 `mcp/tdai-mcp.js`）——
> 所以换电脑、没装 Node、没有源码都能用。

### 步骤 4 · （Claude Code 用户）点一次「信任」

Claude Code 首次执行 hook 时会弹提示，**点一次「信任」**即可。
未信任时 hook 静默不执行，此时 **MCP + 指令文件仍然兜底**，功能不会全丢。

### 步骤 5 · 确认在跑

- 总览页应看到：连接正常、守护运行中、会话列表有数据
- 关窗后应用**在托盘继续运行**；想要开机无感 → 设置 → 通用 → 勾「开机自启」

---

## 四、命令行守护 exe（服务器 / 无界面）

1. 从 Releases 下载 `tdai-daemon-vX.Y.Z-win-x64.exe`（Node SEA 单文件，零依赖）
2. 手写配置 `~/.zcode/tdai-mcp.json`（内容见 [第五节](#五配置文件参考)）
3. 跑起来：`tdai-daemon.exe`（无参 = 启动服务 + 采集循环）
4. 打开 **http://127.0.0.1:8100/** 用网页控制台，四个 tab：
   **连接**（配置 + 链接测试）/ **Agent 接入**（引导 + 状态）/ **状态**（守护/NAS/队列/版本）/ **设置**（检查更新）
5. 各 Agent 客户端的配置需要**手写**（网页控制台的「Agent 接入」页会显示当前状态与目标路径）

其它子命令：

```bash
tdai-daemon.exe serve     # 默认：HTTP :8100 + 采集上传循环
tdai-daemon.exe push      # 立即上传一轮
tdai-daemon.exe hook      # recall hook 入口（给其它工具调用）
tdai-daemon.exe health    # 打印健康状态后退出
```

---

## 五、从源码运行

```bash
git clone https://github.com/HUIdada1/tencentdb-memory-mcp.git
cd tencentdb-memory-mcp
npm ci --prefix pet        # 只有桌面应用与测试需要
```

### 5.1 写配置

`~/.zcode/tdai-mcp.json`（**唯一真源**，守护进程 / MCP / hook / 桌面应用共用）：

```json
{
  "panelUrl": "http://<nas-host>:8125",
  "userKey": "sk-mem-...",
  "teamId": "team-...",
  "agentId": "agt-..."
}
```

### 5.2 一键注册（幂等，跑前自动备份）

```bash
node register-all.cjs                              # MCP 全客户端 + Claude Code/ZCode hook + 指令文件
node register-all.cjs --autostart                  # 同时写启动文件夹 VBS，登录自启守护进程
node register-all.cjs --no-hook --no-instructions   # 只注册 MCP
```

写入位置：

| 目标 | 文件 | 条目位置 |
|---|---|---|
| ZCode CLI | `~/.zcode/cli/config.json` | `mcp.servers.tdai` |
| Claude Code | `~/.claude.json` | `mcpServers.tdai` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.tdai` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.tdai]` |
| Trae | `~/.trae/mcp.json` | `mcpServers.tdai` |
| DeepSeek Harness | `~/.dsh/profiles/<profile>/cordis.patch.yml` | `insert` 条目 |
| CodeBuddy | `~/.codebuddy/.mcp.json` | `mcpServers.tdai` |
| WorkBuddy | `~/.workbuddy-ai/mcp.json` | `mcpServers.tdai` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.tdai`（`command` 为数组） |
| Hermes | `~/.hermes/config.yaml` | `mcp_servers.tdai`（YAML） |
| OpenClaw | `~/.openclaw/openclaw.json` | `mcp.servers.tdai` |
| Pi | `~/.pi/agent/mcp.json` | `mcpServers.tdai` |
| Claude Code hook | `~/.claude/settings.json` | `hooks.UserPromptSubmit` |
| ZCode hook | `<项目根>/.zcode/config.json` | `hooks.events.UserPromptSubmit`（**工作区级**） |
| 全局指令文件 | `~/.zcode/AGENTS.md`、`~/.claude/CLAUDE.md` | `tdai-memory:begin` 标记块 |

> **三个形态差异要点**（写错了客户端会直接不认这个服务器）：
> - **OpenCode** 的字段名是 `mcp`（不是 `mcpServers`），且 `command` 必须写成**数组**
>   （如 `["node", "/path/tdai-mcp.js"]`），没有独立的 `args`。
> - **Hermes** 用 YAML，MCP 配置写在**主配置 `~/.hermes/config.yaml`** 的 `mcp_servers` 下
>   （它没有独立的 mcp 配置文件）。注意别与 `auxiliary.mcp` 混淆 —— 那是"辅助模型的
>   MCP 工具调度"设置，不是服务器定义。
> - **CodeBuddy** 优先写 `~/.codebuddy/.mcp.json`（`mcp.json` 已废弃、`.codebuddy.json` 为旧版）。
>
> ⚠️ **ZCode 的 hook 与 Claude Code 不同构，位置和层级都不同**（2026-09-23 踩过）：
> 1. **位置**：CC 在用户级 `~/.claude/settings.json`；ZCode 只从**工作区**读
>    `<项目根>/.zcode/config.json`（或 `<项目根>/zcode.json`）。所以 `register-all.cjs`
>    需要 `--workspace <项目根>` 才能装 ZCode 的 hook。
> 2. **层级**：CC 是 `hooks.UserPromptSubmit`；ZCode 是 `hooks.events.UserPromptSubmit`
>    —— 多了 `events` 这一层。
> 3. **绝不能往 ZCode 的用户级写 hooks**：`~/.zcode/cli/config.json` 的 schema 是
>    `.strict()` 的，多一个键就报 `Unrecognized key`，并且**整份用户配置作废**。
>    后果不是"hook 不生效"而已 —— `plugins.enabledPlugins` 也会读不到，
>    表现为**插件开关点了就弹回、无法启用**。本工具会在接入时自动清理这个非法残留。

### 5.3 启动守护

```bash
node daemon/tdai-daemon.js         # :8100 服务 + 采集上传循环
node daemon/tdai-daemon.js push    # 手动触发一轮
```

### 5.4 桌面应用（开发）

```bash
cd pet && npm start
```

---

## 六、配置文件参考

### `~/.zcode/tdai-mcp.json` — 配置真源

| 字段 | 必填 | 说明 |
|---|---|---|
| `panelUrl` | ✅ | 记忆库面板地址，如 `http://<host>:8125`（尾部斜杠会被去掉） |
| `userKey` | ✅ | 业务用户 User Key，如 `sk-mem-...`（**密钥不出本机**） |
| `teamId` | 建议 | 团队 ID，如 `team-...` |
| `agentId` | 建议 | Agent ID，如 `agt-...` |
| `taskId` | 否 | 任务 ID |
| `serviceId` | 否 | 默认 `default` |
| `blockId` | 否 | 留空按 `chat_memory-<teamId>-<agentId>` 自动拼接 |
| `recallAlways` | 否 | `true` = 每条消息都召回（默认只在命中回忆类表述时召回） |
| `upload.enabledSources` | 否 | 采集源开关，默认开启 `zcode`、`zcode-db`、`zcode-rollout`、`claude-code`、`codex`、`cursor`、`trae`、`deepseek-harness`、`codebuddy`、`workbuddy`、`opencode`、`hermes`、`openclaw`、`pi`；可按来源写 `false` 关闭 |
| `upload.createAgentIfMissing` | 否 | 默认 `true` |

**环境变量可覆盖同名配置**（优先级：代码传入 > env > 配置文件）：

`TDAI_PANEL_URL` · `TDAI_USER_KEY` · `TDAI_USER_ID` · `TDAI_TEAM_ID` · `TDAI_AGENT_ID` ·
`TDAI_TASK_ID` · `TDAI_SERVICE_ID` · `TDAI_BLOCK_ID` · `TDAI_DAEMON_PORT`（默认 8100）

### `~/.zcode/tdai-app.json` — 应用偏好

主题、开机自启、自动检查更新。删掉即恢复默认。

### `~/.zcode/tdai-daemon/` — 运行时数据

| 文件 | 用途 |
|---|---|
| `cursors.json` | 增量游标（字节偏移）。**删除即重置**，下次按当前文件大小重新种子 |
| `queue/` | NAS 离线时的本地队列（上限 200 条），恢复后自动补传 |
| `daemon.log` | 守护日志（排查问题先看它） |
| `status.json` | 守护状态快照 |
| `backfill.json` | 历史回传进度 |

> 整个 `~/.zcode/tdai-daemon/` 目录**可以直接删** —— 只丢采集进度，不丢记忆库里的数据。

### 端口

| 端口 | 谁在用 |
|---|---|
| **127.0.0.1:8100** | 本工具的本地服务（控制台 + `/recall` + `/push` + `/health`）。可用 `TDAI_DAEMON_PORT` 改 |
| 面板端口（如 8125） | 记忆库面板，由 `panelUrl` 决定 |

---

## 七、常见问题

### Q1：装完看不见最近的会话，只有几个月前的

**最可能的原因**：Node 版本 < 22.16.0，内置 `node:sqlite` 不可用 → 会话扫描降级成只读归档目录
（`~/.zcode/cli/agents/*/transcript.jsonl`），而那里是滞后数据。

- **怎么看**：打开「实时会话」页，若有黄色警告横幅，就是这个问题（横幅会写明当前 Node 版本与最低要求）
- **怎么修**：升级 Node 到 ≥22.16.0 后重启应用；或直接用桌面应用安装包（内置运行时，不受影响）

> 说明：ZCode 新版的会话写在 `~/.zcode/cli/db/db.sqlite`（权威源），旧版写在
> `agents/*/transcript.jsonl`（现已严重滞后）。本工具优先读前者。

### Q2：「链接测试」失败

测试结果分**三态**，先看清是哪一态再动手 —— 「面板可达但认证未通过」说明地址是对的，**别去改地址**：

| 提示 | 原因 | 处理 |
|---|---|---|
| 连接失败 · 面板不可达 / ECONNREFUSED | `panelUrl` 写错、面板没起、或不在同一网络 | 浏览器直接打开 `panelUrl` 试；内网地址要确认本机能通 |
| 面板可达，但认证未通过 · `userKey` 失效 | Key 错、被吊销、或不属于该团队 | 到面板重新签发 userKey，复制后填回「设置 → 记忆库连接」 |
| 面板可达，但认证未通过 · serviceId 不认 | `serviceId` 与面板实例不一致 | 核对面板里的实例标识；没改过就填 `default` |
| 面板没有这个接口 | 面板版本与本工具不匹配 | 升级本工具；本项目走面板的 `/api/v1` 业务面 |
| 超时 | 网络慢 / 面板负载高 | 重试；确认没走代理 |

> ⚠️ **为什么 key 失效能单独报出来**（2026-09-22 实测修正的坑）：
> 面板各接口对 User Key 的校验态度**不一致** —— `/skill/list` 与 `/meta/auth/verify`
> 用错 Key 也返回 `HTTP 200 + code:0`，只有**检索面接口**（`/chat-memory/*`）会真校验并回
> `HTTP 401 + INVALID_USER_KEY`。所以本工具的探活固定打 `/chat-memory/my-agents`。
> 早先用 `/skill/list` 探活时 `auth` 恒等于"面板可达"，**永远发现不了 Key 失效** ——
> 界面显示"连接正常"，实际所有检索与上传都在静默失败。

### Q3：Agent 接入页显示「未接入」，点了也没用

1. 确认该客户端**确实装在本机**（未装的会显示「未装客户端」，属正常跳过）
2. 点「一键接入」后再看状态；若仍「未接入」，页面会列出**写入明细**（哪个文件、什么动作、成功还是失败）
3. Cursor / Trae 等客户端需要**重启**才会重新读配置
4. Claude Code 用户：确认在客户端里点过 hook 的「信任」

### Q4：显示「hook 已注入（旧写法，建议关→开切换）」

说明配置里挂的是**老版本写法**（直接把 `tdai-daemon.js` 交给 `node.exe` 跑）。
它**确实在生效**，但指向源码目录 —— 如果你后来改用 exe 版，那条路径就失效了。
处理：在「Agent 接入」页把该客户端**关掉再打开**（开关语义 = 完整重写一遍）。

> 如果你本来就是**源码用户**（`node register-all.cjs`），这个提示对你无害，可以忽略。

### Q5：两个守护同时在跑，会不会重复采集？

不会。谁先占用 `127.0.0.1:8100` 谁提供检索服务，另一个自动降级（不抢端口、不重复采集），
桌面应用界面会显示「外部进程」。

若端口上是一个**版本更低**的过期守护，本应用会自动接管它（结束旧进程再启动自己）。

### Q6：点了「停止守护」，为什么还有流量 / 为什么服务还在？

分两种情况：

- **应用内守护**：停止后采集与探活都会真正停掉，界面显示「已停止」
- **外部守护模式**：如果 :8100 上是**另一个**守护进程（比如手动跑的 daemon exe），
  本应用**无权结束它** —— 界面会显示「已退出（外部守护在跑）」，服务仍在提供。
  要彻底停，请去结束那个进程

### Q7：面板上数据没更新

1. 总览页看**待上传队列**是否堆积（`~/.zcode/tdai-daemon/queue/`）
2. 看守护卡片「采集上传」是否为「开启（N 个来源）」—— 若为「已关闭」，说明 `upload.enabledSources` 全是 false
3. 看 `~/.zcode/tdai-daemon/daemon.log` 是否有上传失败记录
4. 首见文件按**当前大小做种子**，**不回传历史** —— 想补历史用桌面应用的「回传」按钮

### Q8：Windows 上中文乱码

不要用 Git Bash 内联 `curl -d` 传中文（GBK 乱码）。脚本与工具内部全程 UTF-8。

### Q9：想彻底卸载

1. 桌面应用：用「设置 → Agent 接入」把各客户端**逐个关掉**（会自动清理配置条目与 hook），
   再卸应用
2. 删配置与运行数据：`~/.zcode/tdai-mcp.json`、`~/.zcode/tdai-app.json`、`~/.zcode/tdai-daemon/`
3. 手动清残留（如曾用源码版）：检查 `~/.zcode/AGENTS.md`、`~/.claude/CLAUDE.md` 里的
   `tdai-memory:begin` ~ `tdai-memory:end` 标记块，以及各客户端配置里的 `tdai` 条目

---

## 八、下一步

- 工作原理与架构 → [README.md](README.md)
- 版本变更 → [CHANGELOG.md](CHANGELOG.md)
- 参与开发 → [CONTRIBUTING.md](CONTRIBUTING.md)