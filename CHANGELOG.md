# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **发版约定**：版本号必须在 `package.json`、`pet/package.json`、`daemon/tdai-daemon.js` 的
> `APP_VER`、`mcp/tdai-mcp.js` 的 `SERVER_VER` **四处同步**（CI 会校验）。
> tag 一经发布永久不可复用，新版本号必须严格高于当前最新 tag。

## [Unreleased]

## [0.5.12] - 2026-09-22

### Added
- **Agent 客户端覆盖 6 → 12**（`core/clients.js` 单一真源）。新增 6 家，全部按官方文档核对过
  真实配置路径与格式：
  | 客户端 | 配置文件 | 关键差异 |
  |---|---|---|
  | CodeBuddy | `~/.codebuddy/.mcp.json` | 与 Claude Code 同形，但位于独立目录（`.mcp.json` 优先于 `settings.json`） |
  | WorkBuddy | `~/.workbuddy-ai/mcp.json` | 标准 `mcpServers` |
  | OpenCode | `~/.config/opencode/opencode.json` | **字段名是 `mcp` 不是 `mcpServers`**；`command` 是**数组**（`["node","/path/mcp.js"]`），没有 `args` |
  | Hermes | `~/.hermes/config.yaml` | **YAML，且 MCP 配置在主干 `config.yaml` 里**（无独立 mcp 文件），顶层键 `mcp_servers` |
  | OpenClaw | `~/.openclaw/openclaw.json` | 嵌套结构 `mcp.servers` |
  | Pi | `~/.pi/agent/mcp.json` | 标准 `mcpServers` |
- 新增两种写入形态 `kind: 'yaml'` 与 `kind: 'opencode'`，`register.js` / `register-all.cjs` /
  daemon 内联 `CLIENTS_MIN` 三处同步实现
- `core/clients.js` 导出 **`CLIENT_PATHS`**（规范化的 probe/file 路径分段），供 daemon 交叉核对，
  避免"清单改了、守护内联没改"
- `test/clients-extended.test.js`（65 项）— 12 个客户端逐一做**真实读写往返**：写入 → 探测为
  `installed` → 卸载 → 探测为 `missing`，含 YAML 缩进解析与 OpenCode 数组命令形态
- `test/panel-contract.test.js`（41 项）— **本地起 HTTP 服务精确复刻真面板**，跑真实
  `core.health()` / `memorySearch` / `memoryLayers` 与**真实 spawn 的 daemon 进程**。
  显式覆盖"防静默成功"路径，并刻意保留 `/skill/list` 对坏 key 也返回 200 这个陷阱用例

### Fixed
- **面板业务码判定漏掉"字符串形态的 code"**。真面板部分端点返回
  `{"code":"MISSING_INSTANCE_ID"}`（字符串而非数字），旧 `classify()` 只在
  `typeof code === 'number'` 时才读它 → 常量丢失、提示退化成"面板返回 HTTP 400"。
  现在依次检查 `code`（字符串）/ `message` / `error` **三处**。
  **`core/panel-codes.js` 与 `daemon/tdai-daemon.js` 的内联副本都修**（实测两处同名 bug）
- **opencode 的 `command` 是数组**，按 `args` 拼字符串写进去会导致该客户端读不到 MCP 配置；
  已按数组形态写入，`mcpInstalled()` 也改为校验 `Array.isArray(command)`
- **Hermes 的 YAML 注册会写到错误的父级**：若 `mcp_servers:` 后面还有 `tts:` 等兄弟键，
  直接 append 到文件末尾会让 `tdai:` 被解析成 **`tts.tdai`** —— MCP 静默不可见。
  已改为**插入到 `mcp_servers` 块内部**；卸载侧对称修正（扫到缩进 ≤ 叶子缩进的兄弟键即停，
  否则会把后续所有顶层键一起吃掉）

### Changed
- 测试文件命名**统一为 `*.test.js`**：`metrics-smoke` / `flow-integration` / `e2e-live` /
  `renderer-dom` / `console-structure` / `console-behavior` / `preview-verify` 七个文件改名
  （`git mv` 保历史），`package.json`、测试互引与文档引用全部同步
- `INSTALL.md` 写入目标表由 6 家扩到 12 家，并说明三种形态差异；角色表同步
- `CONTRIBUTING.md`：套件数 17 → 19；新增"测试文件必须 `*.test.js`"约定

### Verified
- `npm run test:ci` → **EXIT=0**，19 个套件 / **858 条断言** / 0 失败（`test:ci` 22 步）
- 新增门禁：`docs-consistency.test.js` ⑩b 锁死命名约定；`clients-consistency.test.js` ⑩
  用同一批 12 组响应体逐字段比对 core 与 daemon 两份判定，双副本漂移不再可能静默发生

## [0.5.11] - 2026-09-22

### Fixed
- **面板响应判定会把「真失败」判成「成功」**（本轮最严重）。对真实面板实测发现，
  面板不是「HTTP 状态码即结论」：
  - `HTTP 400` + 业务码 `MISSING_INSTANCE_ID` / `MISSING_USER_KEY` / `INVALID_INSTANCE` /
    `MISSING_BLOCK_ID` / `INVALID_LAYER`
  - `HTTP 404` 纯文本（**无 JSON**，端点不存在或方法不对）

  旧 `api()` 只看 `status===401/403` 与 `status>=500`，上述形态**全部被当成功返回**
  → 上游"上传成功"实则零写入，且查不出原因。现已按业务码优先判定，七类分流
  （`ok` / `auth` / `input` / `not-found` / `server` / `unreachable` / `unknown`）
- **三处「链接测试」永远测不出 userKey 失效**。实测 `/skill/list` 与 `/meta/auth/verify`
  对**坏 userKey** 都返回 `HTTP 200 + code:0`（**不校验**）；只有检索面接口
  （`/chat-memory/*`）会真校验并回 `401 INVALID_USER_KEY`。而三处实现都打 `/skill/list`
  且写 `auth = nas` → `auth` 恒等于"面板可达"，界面显示"连接正常"但所有检索与上传
  静默失败。探活端点统一改为 `/chat-memory/my-agents`，`nas`（面板活着，含 4xx）
  与 `auth`（真鉴权通过）分开判定
- **recall 路径**（`buildRecall`）同样只看 HTTP 2xx：端点变更导致的 404 会被当成功但解析出空
  `items`，表现为"记忆检索永远为空"却毫无线索
- **顶栏连接 pill 把 401 说成「连接失败」** → 用户会跑去改面板地址（越改越乱）。
  现在按 `panelAuthFail` 分文案：「认证失败（去重新签发 userKey）」vs「连接失败（地址/网络）」

### Added
- **`core/panel-codes.js`** — 面板响应判定的**唯一真源**：业务码常量、14 条中文可操作提示、
  语义分类、`codeKeyOf()`、`classify()`、`summarize()`，以及 `API_PREFIX`
- `test/panel-codes.test.js`（107 项）— 真值表驱动（含"HTTP 200 承载业务码"这类陷阱形态）；
  断言 daemon 的**内联副本**与唯一真源逐字一致；回归锁定"探活必须打真校验 key 的端点"
- `package.json` 新增 `test:panel`；`test:all` / `test:ci` 纳入新套件

### Changed
- `core/tdai-core.js`：`api()` 改用 `classify()`；`ok()` / `err()` 支持第三参携带面板判定结果；
  `health()` 的 `auth` 与 `nas` 解耦；顶部注释写明 `/v3` 是前端路由（防后人"对齐"成 `/v3`）
- `daemon/tdai-daemon.js`：内联 `PANEL_HINTS` / `PANEL_CODE_CLASS` / `classifyPanel()` /
  `PANEL_API_PREFIX`（SEA 单文件自包含要求，测试会校验与 core 一致）；
  `mkApi()` 返回 `v` 与 `ok`；`uploadBatch` / skill 缓存 / recall / `/health` /
  `/api/test-connection` 全部改判 `ok`；`/health` 新增 `auth` 字段
- `pet/src/main.js`：`_onHttp` 新增 `panelAuthFail`（401/403）并透出到快照与 IPC
- `pet/src/console.js`：链接测试三态提示（成功 / 面板可达但认证未通过 / 连接失败）；
  顶栏 pill 区分认证失败
- `INSTALL.md` Q2「链接测试失败」重写为三态表格，并解释"为什么 key 失效能单独报出来"

### Verified
- 面板 API 前缀实测（真实面板）：`/api/v1/*` 全部可用；`/v3/skill/list`、`/v3/chat-memory/search`、
  `/v3/meta/auth/verify` **全部 404**；`GET /v3` 返回前端 SPA 的 `index.html`
  → **`/v3` 是前端路由而非 API 前缀**，本项目走 `/api/v1` 正确，**不需要版本协商**

## [0.5.10] - 2026-09-22

### Added
- `core/clients.js` — Agent 客户端清单**单一真源**。桌面端 `pet/src/register.js` 与源码端
  `register-all.cjs` 共用同一份定义（key / 显示名 / 探测路径 / 配置文件 / 写入格式），
  杜绝"一边加了客户端、另一边没加"造成的接入状态错报
- `test/clients-consistency.test.js`（75 项）— 钉死上述单一真源：两端不得再本地定义 `CLIENTS`、
  不得硬编码客户端路径字面量，并断言守护进程内联的常量/路径/客户端集合与清单完全一致
- `test/sqlite-degrade.test.js`（28 项）— 会话权威源（`node:sqlite`）不可用时**必须可见**
- `.github/workflows/ci.yml` — 每次 push / PR 跑全量测试（16 个套件）+ 硬编码纪律门禁
- `LICENSE`（MIT）、`CONTRIBUTING.md`、`INSTALL.md`、`CHANGELOG.md`、Issue 模板
- `README.md` 版本要求表（按形态分列）、贡献指引、许可证与免责声明
- 根 `package.json`：`license` / `repository` / `homepage` / `bugs` / `engines` 字段
- 新增 npm script：`test:ci`（发版与 CI 门禁）、`test:clients`、`test:sqlite`

### Fixed
- **源码版 `register-all.cjs` 每次运行都会重复写入 hook**：幂等判据用
  `JSON.stringify(arr).includes(DAEMON)` 比较，而 Windows 路径的 `\` 在 JSON 串里是 `\\`，
  永远不命中 → hook 静默翻倍（每次提问注入两次记忆）。改用 JSON 转义后的形态比对
- **源码版 `register-all.cjs` 的 MCP 注册不幂等**：只看"条目是否存在"，
  于是每次运行都重写并留一份 `.bak`，备份目录被无意义堆满。改为内容比对，一致即跳过
- **守护进程（网页控制台）的 Agent 接入状态漏报两个客户端**：
  `agentStatus()` 是 5 段手写 if，漏了 **Trae** 与 **DeepSeek Harness** ——
  桌面应用显示 6 个客户端、网页控制台只显示 4 个。改为表驱动，与清单对齐
- **`pet/package.json` 的 `license` 为 `UNLICENSED`**，与 README 宣称的 MIT 矛盾 → 改为 MIT
- **`node:sqlite` 不可用时静默降级**：低版本 Node / 未编译该模块的 Electron 下，
  "实时会话"只统计归档文件目录，界面会显示"最新会话停在几个月前"却毫无提示。
  现在 `sqliteStatus()` 报告 `kind`（`no-module`/`no-db`/`query-error`）+ 原因 + 修复建议，
  由控制台 `#sess-warn` 横幅显示
- **README 的 Node 版本口径自相矛盾**：文首写"纯 Node ≥16"、文末写"推荐 Node ≥18"，
  而会话扫描实际需要 ≥22.16。改为按形态分列的版本表 + `engines` 声明
- `release.yml` 的"冒烟自检"只跑 4 条（12 个测试套件里 8 个从不执行）→ 升级为全量 `test:ci`

### Changed
- `pet/src/register.js`：`CLIENTS` / `INSTR` / `INSTR_MARK` / `INSTR_TARGETS` / `HOOK_MARK` /
  `HOOK_LEGACY_MARKS` 全部改从 `core/clients.js` 引入
- `pet/src/register.js`：hook 配置文件映射原本硬编码 4 遍（`hookState` / `register` /
  `registerOneClient` / `unregisterOneClient`），统一收敛为 `hookTargets(home)`
- `pet/src/register.js`：JSON 条目定位改为按 `pointer` 通用推导，
  去掉 `cls.pointer === '/mcp/servers/tdai'` 的 ZCode 字符串特例
- `pet/src/register.js`：TOML 段名 / dsh 幂等标记改走 `cls.tomlSection` / `cls.patchMark`
- `pet/src/register.js` / `register-all.cjs`：卸载 hook 时同时清理新旧两种写法

## [0.5.9] - 2026-09-22

### Fixed
- **守护停止后仍有"上传流量"**（三处来源全部封堵）：① 停止后每 10s 的 `daemonPing()`
  打 `:8100/health` 必然失败却被计入请求数；② 探活失败把 240B"请求头开销"算进上行累计
  （字节从未发出）；③ `startPolling()` 在启动序列里排在 `guardEnabled` 判断之前，
  无条件先跑一轮 `pollHealth`
- **停止态界面误报"已连接"**：连接判定依赖 30s 延迟 TTL，停止后最后一次探活仍在 TTL 内 → 亮绿灯
- **停止态"运行时长"继续走秒**、倒计时停在"即将采集…"（未清 `scanAnchor`）
- **首屏渲染抢在偏好加载之前**：`S.guardEnabled` 初值 `true`，异步 `prefsLoad()` 回填真实值；
  停止态用户首帧会按"守护运行中"渲染且不会再纠正
- **流量计量量纲混用**：`upPeak`/`downPeak`（bytes/s 速率）被 `meter()` 的单笔字节数抬高，
  导致 5MB 请求显示成 `4.77 MB/s`、仪表量程被抬到 5e6 而指针永远贴 0。
  新增 `upPeakBytes`/`downPeakBytes` 承载单笔字节数
- **流量方向误判**：`preload.js` 的 `classify()` 把 `POST /chat-memory/search`、
  `POST /skill/list`（实为**下行**只读检索）算作上行
- **上游健康判据三处不一致**：`core.health()` 里 `a.data.code === 401` 是死条件
  （`api()` 已把 401/403 收敛成 `err()`，认证失败就是 HTTP 401，不存在"HTTP 200 + 业务 401"形态）→
  统一为 `auth = nas`（HTTP 2xx）
- **hook 状态判据两处不一致**：桌面端查 `tdai-hook.cmd`、网页端查 `tdai-daemon`，
  同机出现"未注入/已注入"互相矛盾 → 抽出共用判据，legacy 标注"旧写法，建议切换"而不误报未注入
- **Agent 接入状态假阳性**：指令文件只写 `.zcode/AGENTS.md` + `.claude/CLAUDE.md`，
  检测却多查一个从不写入的 `.claude/AGENTS.md` —— Claude Code 用户自带的同名文件
  会被误判成"已接入" → 抽 `INSTR_TARGETS` 单源
- **MCP 工具 schema 缺必填字段**：`wiki_id` / `code_graph_id` 未声明；
  `wiki_read` / `skill_get` 的 `anyOf` 在 CLI 路径下未被尊重
- **dsh-patch 卸载误删用户条目**：原按"命中区间内 `-` 开头的行都跳过"过滤，
  会连带吞掉用户在本块之后写的其它 `insert` 条目 → 改为结构化定位（begin 注释 → `ELECTRON_RUN_AS_NODE` 行）
- **外部守护模式停止后误报"本地服务已暂停"**：本应用无权结束外部守护进程，
  端口仍由它服务 → `guard.stop()` 记 `stoppedExternal`，界面区分"已退出（外部守护在跑）"/"已停止"
- **更新检查永久锁死**：`checkForUpdates()` 的 promise 拒绝且未触发 `error` 事件时，
  状态永远卡在 `checking` → 补兜底
- `localBackfill` 定时器无上限 → 加 30 分钟硬顶

## [0.5.8] - 2026-09-22

### Added
- 过期守护进程自动接管：探测到端口上的守护版本低于自身时结束它再启动（绝不杀 `process.pid`/`ppid`）
- 记忆页双模式检索与 L1/L2/L3 分层分页（每页固定 10 条）
- 会话扫描改用 ZCode SQLite 会话库作为权威源（`~/.zcode/cli/db/db.sqlite`）

### Fixed
- 记忆页分层走服务端分页、检索走客户端切片（面板忽略 `offset`，`top_k` 上限 20）
- 切模式时未重置 `MEM.layer`，会静默把上一模式的层带过去
- 正文渲染取值链漏 `body` 字段，会把整条 JSON 当正文打印
- `SERVER_VER` 未同步（发版流水线版本校验补齐为四处）

## [0.5.7] - 2026-09-22

### Added
- ZCode 会话库 SQLite 采集源（`node:sqlite`，只读打开）
- 历史回传弹窗化（列出 agent 行、支持选择目标后再启动）

### Fixed
- 记忆分层渲染

## [0.5.6] - 2026-09-22

### Added
- 守护服务手动开关（开始/停止守护）
- 回传兜底：`localBackfill` 路径

### Fixed
- L1 抽取 `user_id` 传参
- Wiki / 代码图谱的 API 契约（路径与必填参数）

## [0.5.5] - 2026-09-22

### Added
- 客户端独立接入开关（逐个客户端启用/停用）
- 记忆策略切换
- 实时会话页动态识别来源（无需手动配置）

### Fixed
- 守护状态显示

## [0.5.4] - 2026-09-22

### Added
- 控制台 v3 皮肤（双主题液态毛玻璃、iOS 风格开关）— 圆角一律使用 CSS 变量（`scripts/verify-v3-skin.cjs` 强制）

### Fixed
- 全链路健壮性加固（守护离线、面板超时、配置缺省等路径）

## [0.5.3] - 2026-09-22

### Added
- `recallAlways`：每条消息都自动召回记忆
- Agent 接入扩展：Trae、DeepSeek Harness（`~/.dsh` cordis patch 层）、ZCode UserPromptSubmit hook

## [0.5.2] - 2026-09-21

### Added
- rollout 会话采集源
- 历史回传按钮与进度展示

### Fixed
- 防重复游标

## [0.5.1] - 2026-09-21

### Fixed
- `conversationAdd` 按服务端契约回传 `user_id` + `messages`
- 控制台连接状态判据

## [0.5.0] - 2026-09-21

### Added
- 控制台总览实时指标（上下行流量、请求计数、延迟）与会话监控

### Fixed
- ZCode 采集解析

## [0.4.1] - 2026-09-21

### Fixed
- 记忆检索与面板 API 路径不匹配

## [0.4.0] - 2026-09-21

### Added
- 桌面应用内置守护进程（无需单独装 Node / 源码）
- Agent 一键接入
- 控制台设置页分类重构（连接 / Agent 接入 / 更新 / 通用）

## [0.3.0] - 2026-09-21

### Added
- 本地控制台页（tab 分类 + 问号提示 + 链接测试 + Agent 接入状态 + 更新检查）

### Fixed
- 旧安装版的更新检查 404

## [0.2.2] - 2026-09-21

### Changed
- 版本号调整：因 v0.2.0 tag 已被早期形态占用，顺延版本号以保持 tag 唯一（v0.2.1 为同一次调整）

## [0.2.1] - 2026-09-21

### Changed
- 版本号顺延（与 0.2.2 同批；此版本号即为"tag 唯一性"占位，无独立功能变更）

## [0.2.0] - 2026-09-21

### Changed
- **去掉宠物模块**，改为零依赖单文件守护进程（可打包为 SEA exe）

## [0.1.0] - 2026-09-21

### Added
- 初始提交：MCP server（`tdai_*` 只读工具）+ 后台采集守护进程 + 网页控制台
- 设计稿对齐的液态毛玻璃控制台

---

[Unreleased]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.12...HEAD
[0.5.12]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.11...v0.5.12
[0.5.11]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.10...v0.5.11
[0.5.10]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.9...v0.5.10
[0.5.9]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/HUIdada1/tencentdb-memory-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HUIdada1/tencentdb-memory-mcp/releases/tag/v0.1.0
