# ZCode × TencentDB Agent Memory 接入全记录与方案

> 文档日期：2026-09-21
> 内容：本次对话（ZCode 接入腾讯云记忆库）的完整过程记录、需求清单、当前状态、以及待实施的方案 B 设计文档。
> ⚠️ 本文档含敏感信息（user_key、资产 ID），仅限本机参考，请勿外传。

---

## 一、背景与需求演进（按时间顺序）

| # | 用户要求 | 状态 |
|---|---|---|
| 1 | 把 ZCode 接入已部署在飞牛 NAS 上的 TencentDB 记忆库（面板 http://muhuihao.top:8125） | ✅ 已完成验证（后按 #7 清理了本地件） |
| 2 | 上传 ZCode 本地历史（会话 + 技能）到记忆库，让多 Agent 共享 | ✅ 已完成（数据保留在 NAS） |
| 3 | 不想手动双击 bat 启动本地网关 → 改为自动 | ✅ 已完成（登录自启，随后清理） |
| 4 | 不想手动选「TD记忆」渠道 → 日常使用后台自动上传 | ✅ 已完成（后台守护，随后清理） |
| 5 | 咨询：proxy 上游是否固定 / Wiki 与 Code_Graph 用途 / 如何继续使用这套 | ✅ 已答复（见下） |
| 6 | 要求：本地 ZCode 用别的渠道聊天，远程自动连接记忆库并"推送 + 调用"记忆 | 📋 分析完成，指向方案 B |
| 7 | 删除本次对话在本地加的所有东西 | ✅ 已执行（NAS 上数据保留） |
| 8 | 按方案 B 做一个**通用**记忆工具 MCP，先出方案、仔细调研 | 📋 方案已产出（见第五节），**待用户确认后开工** |
| 9 | 把本次对话与要求写成完整 md 文档放桌面 | ✅ 本文档 |

---

## 二、环境与关键资产（事实登记）

### 2.1 NAS 侧（TencentDB Agent Memory 三件套）

| 服务 | 端口 | 公网状态 | 用途 |
|---|---|---|---|
| 面板 (Memory Hub) | 8125 | ✅ 对外（现已被用户暂时关闭） | 团队记忆控制面板；同时也是**检索 API 网关**（/api/v1/*） |
| Memory Core | 8420 | ❌ 未对外暴露 | 记忆读写/认证/skill 数据面 |
| Knowledge | 8424 | ❌ 未对外暴露 | Wiki / Code-Graph 服务 |
| Proxy | 8096 | ✅ 对外（现已被暂时关闭） | LLM 请求代理（注入+归档），上游在 NAS 内网可达 |

- Proxy 上游由 NAS 上 `deploy/global-images/.env` 的 `PROXY_UPSTREAM_URL / _API_KEY / _MODEL` 决定（**可自定义**，改完重启容器生效；模型名原样转发）。从实测响应含 `cost_cny`、`billing_pending`、`trace_id` 判断，上游大概率指向用户自建 sub2api 网关（muhuihao.top:25225 账号池）。
- 连接方式：面板 API 全走 `X-Tdai-Service-Id: default` + `X-Tdai-User-Key: sk-mem-...` 认证头，路径 `/api/v1/<action>`。

### 2.2 记忆库资产（NAS 面板内，保留至今）

| 资产 | ID |
|---|---|
| 用户 huihui（system_admin） | usr-zcdxzdq0o1 |
| User Key | `sk-mem-Yjhssg20010303` |
| Team「HUI」 | team-zcv52tgzwg |
| Agent「通用开发助手」 | agt-zc6vu8z5ks |
| Task「ZCode 日常开发」 | task-zdlxl0mp4h |
| Skill | 28 个（25 个本地导入 + 3 个由导入会话自动抽取） |
| 会话记忆 | 9 个历史会话 322 条消息，已入库并触发 L1 抽取 |

### 2.3 本机环境

- ZCode 桌面端：`E:\ZCode\ZCode.exe`（3.12.2 预览通道），界面代码在 `resources/app.asar`；用户数据在 `C:\Users\HUIDADA\.zcode\`。
- Node：`E:\nvm\v22.22.0\node.exe`（另有 C:\nvm4w\nodejs\node.exe 为 v16）；本机无 tsx。
- ZCode CLI 会话数据：`~/.zcode/cli/agents/<sess>/<agent>/transcript.jsonl`（任何渠道都会落，活跃保留 9 个，旧文件被客户端轮转清理）。
- ZCode 技能目录：`~/.zcode/skills/<name>/SKILL.md`。
- ZCode CLI MCP 注册：`~/.zcode/cli/config.json` 的 `mcp.servers`（dbx 为现成参照，格式 `{type:"stdio", command, args}`）。
- ZCode 桌面端 MCP：设置 →「MCP 服务器」（可新建/从外部 Agent 导入），内置 StdioClientTransport，写盘结构同为 `mcp.servers`。

---

## 三、完成历程

### 3.1 ZCode 接入 Memory Proxy（已验证可行）

**方案**：ZCode 的 OpenAI provider 无法发自定义请求头，而 proxy 的 header 预选需要 `x-team-id/x-agent-id/x-task-id/x-conversation-id` 四件套 → 本地零依赖 Node 网关做 header 注入：`ZCode(127.0.0.1:8099/dsh/default/v1) → 网关 → muhuihao.top:8096`。

**步骤**：
1. 验证面板 API 面：`/api/v1/meta/auth/verify`、`team/list`、`task/create/update` 等（用面板 JS 提取）；
2. 面板补齐资产：建 Task「ZCode 日常开发」；
3. 写网关 gw.js + 配置 gw.json，注入四件套 header，conversation-id 空闲 5 分钟自动轮换，流式全透传；
4. 写 ZCode provider「TD记忆」（baseUrl=http://127.0.0.1:8099/dsh/default/v1，apiKey=sk-mem-...，模型 deepseek-v4-flash-0731）写入 provider_config.json/config.json（先备份）；
5. 端到端验证：直连 prompt_tokens=84 → 走网关带身份=3600；探测确认 system prompt 含资产标签；流式正常。

### 3.2 历史数据导入（NAS 数据保留至今）

- 官方 `agents/asset-import.ts` 只支持 7 家客户端、需要 tsx，且解析不了 ZCode transcript 格式 → 自研零依赖 `zcode-import.cjs`。
- 解析映射：用户输入=`turn_started.payload.input`；助手正文=`model_complete.payload.content`（stopReason=tool-calls 时为中间态）+ `turn_complete.payload.response`（最终答复）；工具调用=`tool_call_scheduled`。
- 上传端点（与官方一致）：`/api/v1/skill/create`、`/chat-memory/import`、`/skill/conversation/add`。
- 结果：**25 个 skill + 9 个会话（322 条消息）全部入库**；面板 skill/list 实为 28 个——多出的 3 个（jiangxiraoze-app-frontend、shangqiu-luru-frontend-conventions、shangqiu-daping-gis-map）是**导入会话触发 core 自动抽取**的技能，实证「会话导入→技能抽取」链路有效。
- 补传两个超限 skill：design-taste-frontend（正文 87KB>50KB → 截 47KB + 余文放 references/supplement.md）；xiaotao-win-flow（1.18MB>1MB → 重写 frontmatter + 贪心收纳 79/81 个资源文件）。

### 3.3 自动化：登录自启 + 后台自动上传（已按用户要求清除了本地件）

- 计划任务（schtasks）需管理员权限被拒 → 改**启动文件夹**方案：`run-hidden.vbs` 复制为 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TD记忆网关.vbs`，登录即隐藏窗口启动以下两个进程：
  1. `gw.js`（本地 header 注入网关，8099）；
  2. `mem-uploader.cjs`（对话后台自动上传守护，每 2 分钟扫 transcript.jsonl 增量，按字节偏移推进，只上传含 turn_complete 的完整轮次；首次发现按当前大小做种子不回传历史）。
- 该方案让"不选 TD记忆 渠道"也能自动积累记忆；仅失去对话过程中的实时注入/检索。

### 3.4 本地清理（已执行完毕）

删除内容：tdai-gateway 目录、`~/agents` 副本、tmp 临时文件、v2 配置备份、启动文件夹 VBS、provider_config.json/config.json 中的「TD记忆」条目（两文件已验证无残留、JSON 合法）、长期记忆文件及索引行；停止 gw.js 与 mem-uploader 进程（端口已无监听）。
保留内容：**NAS 上的全部数据**（28 个 skill、9 个会话记忆、Task 资产）未动；ZCode 原有配置其余部分未动。

---

## 四、关键事实与坑位速查（后续实施直接引用）

### 4.1 面板 API 全集（从面板前端 JS 提取，8125 同源）

- `meta/`：auth/verify、team|agent|task 的 list/get/create/update/delete、team-member/*、user/*、user-key/*、config/user/*
- `chat-memory/`（记忆面）：**search**、layer、team-assets、agent-fixed、my-agents、allocate、unbind、create、patch-scope、import、layer-update
- `knowledge/`（知识面）：health、wiki/create|list|get|ingest|delete|graph|page/ls|page/read|page/rm|**search**|raw/*、code-graph/create|list|register-meta|sync|delete|**search**|**explore**|get、connectors/pull
- `skill/`：create、list（skill/get 待验证）
- ⚠️ search/layer/team-assets/explore 等端点的**请求体结构尚未实测**（NAS 关停中）——方案 B 的 Phase 0 需逐一探针冻结。

### 4.2 坑位清单

| 坑 | 解法/结论 |
|---|---|
| Git Bash 内联 curl -d 传中文按 GBK 发出导致乱码入库 | printf 到 UTF-8 文件 + `--data-binary @file` |
| ZCode 无法发自定义请求头 | 本地 header 注入网关（或走 MCP 工具路线） |
| core 单条消息 >8192 字符 → 400 | 切片 ≤8192 |
| skill 正文 >50KB → 42203 | 截正文 + 余文放 references |
| skill 整体 >1MB | 贪心收纳资源文件 |
| skill 资源缺 `encoding` 字段 → 40001 | 资源项必须带 `encoding:"utf-8"` |
| skill frontmatter 含冒号 → 服务端 YAML 解析失败 | 重写为引号包裹的 name+description |
| VBS ws.Run 引号嵌套 → node 静默起不来 | 无空格纯路径 cmd 串，不引嵌套；改脚本后必须重新 cp 到启动文件夹 |
| schtasks 需管理员（拒绝访问） | 改启动文件夹方案 |
| wmic 取 CommandLine 不可靠 | PowerShell Get-CimInstance 或 netstat 端口反查 PID |
| 本机 Node 16 无 fetch/tsx | 零依赖 CJS 或直接用 E:\nvm\v22.22.0 |
| proxy 上游看似"固定" | 实为 .env 配置，可改可重启；模型名原样转发 |

---

## 五、方案 B 设计文档：通用「TD AI 记忆工具」MCP（当前待办，等确认开工）

### 5.0 一句话结论

做一个**零依赖的单文件 Node stdio MCP 服务器**（约 250 行），注册进 ZCode 后，**任何渠道**的对话里模型都能按需远程查 NAS 记忆库（对话记忆 / Wiki / 代码图谱 / 技能）。同一脚本兼作 CLI，不支持 MCP 的客户端也能用 Skill/Bash 调用。推送（会话归档）+ 调用（本工具）+ 聊天（原渠道）三者彻底解耦。

### 5.1 架构

```
任意渠道对话(ZCode 选任何供应商)
      │ 模型需要记忆时自主调用
      ▼
tdai-mcp (本地 stdio 进程, 按需拉起, 不常驻)
      │ HTTPS X-Tdai-User-Key
      ▼
NAS 面板 8125 /api/v1/chat-memory/*  /api/v1/knowledge/*  /api/v1/skill/*
```

不碰 proxy(8096)、不碰渠道、不需要常驻守护；与面板 UI 同源同权。

### 5.2 工具清单（只读为原则，单端点单职责）

| MCP 工具 | 端点 | 参数 | 返回 |
|---|---|---|---|
| tdai.memory_search | chat-memory/search | query, top_k, team_id?, agent_id? | 相关记忆片段（含来源/时间） |
| tdai.memory_layers | chat-memory/layer | team_id?, agent_id? | L1/L2/L3 资产概览 |
| tdai.team_assets | chat-memory/team-assets | team_id | 团队资产总览 |
| tdai.skill_list / tdai.skill_get | skill/list, skill/get | name? / skill_id | 技能目录 / 内容 |
| tdai.wiki_search / tdai.wiki_read | knowledge/wiki/search, wiki/page/read | query / page_id | 文档命中 / 页内容 |
| tdai.codegraph_search / tdai.codegraph_explore | code-graph/search, /explore | query / node_id? | 图谱命中 / 邻域 |
| tdai.health | knowledge/health + 面板探测 | — | 各服务健康状态 |

约束：全部只读（写入仍由会话归档链路负责）；单结果截断 ≤6KB、默认 top_k=5；NAS 离线返回中文可读错误（"记忆库不可达，请检查 NAS/网络"），逼模型如实反馈而非编造。

### 5.3 实现要点

- 单文件 `tdai-mcp.js`：手写 JSON-RPC 2.0 over stdio（initialize / tools/list / tools/call / ping），NDJSON；**零 npm 依赖**（Node 22 内建 fetch，降级 http 模块）。
- 双模式：无参 = MCP 服务器；`node tdai-mcp.js run <tool> --json '{...}'` = 一次性 CLI。
- 配置 `~/.zcode/tdai-mcp.json`：panelUrl / userKey / 默认 team/agent（env 同权覆盖）；key 仅存本地。
- 统一结果封装：`{ok, data, hint}`。

### 5.4 接入注册（三路，体现"通用"）

1. **ZCode CLI**：`cli/config.json` 的 `mcp.servers` 加 `tdai` 条目（照抄 dbx 格式：`{type:"stdio", command:"E:\\nvm\\v22.22.0\\node.exe", args:[脚本路径]}`）→ 重启会话生效；
2. **ZCode 桌面端**：设置 → MCP 服务器 → 新建（node 路径 + 脚本路径），或"从外部 Agent 导入" `.mcp.json`；
3. **其他客户端**：根目录生成标准 `.mcp.json`（Claude Code / Cursor 一行接入）+ **ZCode skill 兜底**（`~/.zcode/skills/tdai-memory/`：SKILL.md + CLI 说明）。

### 5.5 风险与待验证项（Phase 0，NAS 开闸后 30 分钟）

- `search/layer/team-assets/explore` 等端点请求体结构未知 → 一组 curl 探针实测、冻结 schema；
- `skill/get` 是否存在待验证；
- 8125 公网可达性由用户控制，离线场景必须优雅报错。

### 5.6 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| Phase 0 | NAS 开闸 → 端点探针实测，冻结 schema | 各端点拿到真实响应样例 |
| Phase 1 | 服务器核心 + 记忆面 3 工具 + health | stdio 起动正常、tools/list 正确 |
| Phase 2 | 技能 + Wiki + CodeGraph 工具 + 离线降级 | 与 curl 同参结果一致 |
| Phase 3 | 注册进 ZCode 双端 + .mcp.json/skill 兜底 + 文档 | **任意渠道**对话中问"查下我们之前关于 X 的记忆"，模型自主调用并给出证据回答 |

工作量：约 1 个工作日（Phase 1+2 编码 0.5 天可离线先行；Phase 3 注册验收 0.5 天；Phase 0 依赖 NAS 开闸）。

---

## 五点八、实施修订（2026-09-21 下午，开工确认）

### 架构裁决（最终）

| 层 | 选型 | 说明 |
|---|---|---|
| 业务/后端层 | **方案 B**（零依赖单文件 Node stdio MCP，~250 行） | 只在 exec 时拉起，零常驻；tools/memory/skill/wiki/codegraph 只读接入；推送仍走原归档链；推/拉/聊天三解耦 |
| 客户端壳 | **Electron 自案 UI** | 一个进程双人格：① TD Memory Pet（桌面同步萌物） ② Mini Console / HUD（遥测+对话检索） |
| 打包 | `electron-npm` → 单文件 exe | 单进程不输出多余 loader,dll；logo.png 1024px 直喂 exe/favicon/tray |
| AI 角色 | 本地马（profiles.json,无在线成本） + 可自选接 DeepSeek/OpenAI | 面板默认 OFF |

### 目录与包装

```
腾讯记忆链接/
  core/            # tdai-core.js   零依赖检索引擎（纯 Node ≥16,fetch 负负下退 http）
  mcp/             # tdai-mcp.js    stdio MCP 服务器（JSON-RPC 2.0,NDJSON）
  pet/             # Electron 源码：main/ preload/ renderer/(HTML+CSS+JS)
  assets/          # logo.png → logo.ico / favicon.svg / tray.png
  .mcp.json        # 标准 MCP 注册片段（Claude/Cursor 一行接入）
  skills/tdai-memory/SKILL.md  # ZCode skill 兜底（无 MCP 时走 CLI）
```

### 三个不可变事

1. NAS 8125 公网开闸由用户手动控制（Phase 0 探针依赖在这里），MCP 取得不可达时返回中文可读错误，不编造。
2. 密钥 (`sk-mem-`) 仅存本机 `~/.zcode/tdai-mcp.json` 与 exe `config.json`，零上传零外发。
3. exe 不代替 ZCode/Claude：只做「本地查看/检索/遥测/托管」；仍是 MCP 服务器供别处调用。

---

## 六、当前状态与下一步

- **当前状态**：NAS 服务已被用户暂时关闭（8125/8096 不可达）；本地所有本次对话产物已清理；NAS 上记忆数据（skill/会话/Task）完好。
- **下一步（待用户确认）**：开工方案 B 的 Phase 1–3（不依赖 NAS，可立即开始）；NAS 打开后跑 Phase 0 探针校准，全线启用。
- 遗留说明：若 ZCode 重启后「TD记忆」渠道重新出现（桌面端退出时把内存态写回配置文件），彻底退出 ZCode 后告知即可再清一次。