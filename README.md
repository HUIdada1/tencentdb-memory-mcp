# TD 记忆守护（TencentDB Memory MCP）

腾讯云 TencentDB 记忆库的完整接入工具集：**MCP Server**（供 ZCode 等 Agent 接入团队记忆）+ **桌面宠物 App**（Windows 托盘常驻的记忆守护与控制台）。

- 仓库：https://github.com/HUIdada1/tencentdb-memory-mcp
- 发版资产（exe 下载）：https://github.com/HUIdada1/tencentdb-memory-mcp/releases

## 目录结构

```
├─ core/tdai-core.js        # 记忆库核心客户端（面板连接、鉴权、各 API 封装）
├─ mcp/
│  ├─ tdai-mcp.js           # MCP Server（stdio），暴露 tdai_* 系列工具
│  └─ register-zcode.cjs    # 一键注册到 ZCode 的 MCP 配置
├─ pet/                     # 桌面宠物 App（Electron）
│  ├─ src/main.js           # 主进程：双窗口（Pet + Console）/ 托盘 / 设置 / 热更新接线
│  ├─ src/updater.js        # 自更新模块（安装版 electron-updater / 便携版 latest.yml 比对）
│  ├─ src/console.html/css/js  # 控制台 UI（双主题液态毛玻璃，样式对齐设计稿）
│  ├─ src/pet.html/js       # 桌宠小窗（透明置顶、状态点、消息气泡）
│  └─ src/preload.js        # contextBridge 白名单
├─ .github/workflows/release.yml  # 发版流水线（手动触发，构建并发布 exe）
└─ build/ assets/           # 图标资源
```

## MCP Server（ZCode 接入）

1. 安装依赖：`npm install`（无根级依赖，仅 Node 18+）。
2. 注册到 ZCode：`node mcp/register-zcode.cjs`，或手动在 MCP 配置里指向 `mcp/tdai-mcp.js`。
3. 可用工具：`tdai_health` / `tdai_memory_search` / `tdai_memory_layers` / `tdai_team_assets` / `tdai_skill_list` / `tdai_skill_get` / `tdai_wiki_search` / `tdai_wiki_read` / `tdai_codegraph_search` / `tdai_codegraph_explore`。

连接配置（面板地址 / User Key / Team ID 等）见 `mcp/tdai-mcp.js` 顶部说明。

## 桌面宠物 App

### 功能

- **双窗口**：桌宠小窗（透明置顶、可拖动、连接状态点、消息气泡）+ 控制台（总览 / 记忆 / 技能 / Wiki / 图谱 / 更新中心）。
- **健康轮询**：按设置间隔轮询记忆库健康状态，同步到桌宠状态点与控制台状态胶囊。
- **设置持久化**：`~/.tdai-pet/config.json`（连接、桌宠、外观主题、开机自启、更新开关、AI 人格）。
- **双主题**：深色 / 浅色 / 跟随系统，液态毛玻璃风格。

### 开发与调试

```bash
cd pet
npm install
npm start          # 开发模式（不写注册表、不检查更新）
```

### 本地打包

```bash
cd pet
npm run pack       # 仅打包到 ../dist/win-unpacked，本机验证
npm run dist       # 打包 NSIS 安装版 + 便携版到 ../release/
```

### 热更新机制

- **安装版（NSIS）**：electron-updater 拉取 GitHub Release 的 `latest.yml`；启动 60 秒后首次检查，之后每小时一次；更新中心可手动检查 / 下载 / 重启安装；下载与安装均由用户触发。
- **便携版（portable）**：只读 `latest.yml` 比对版本号，检测到新版提示到 Releases 页手动下载替换。

## 发版（exe 线上发布）

任何会话对项目说「发版」即按以下流程执行，不得跳步：

1. 升 `pet/package.json` 的 `version`（须严格高于远端最新 tag，tag 一经发布不可复用）。
2. 提交并推送 main：`git add -A && git commit -m "feat: …" && git push origin main`（仓库已配代理 `127.0.0.1:7897` 与中性身份）。
3. 触发 GitHub Actions **Release** workflow（workflow_dispatch 手动触发，网页或 API 均可），CI 在 windows-latest 上执行 `electron-builder --win --publish always`，自动创建 tag + Release（Setup exe / portable exe / blockmap / latest.yml）并校验发布结果。
4. 验证：`curl -sSL https://github.com/HUIdada1/tencentdb-memory-mcp/releases/latest/download/latest.yml | head -1` 应为新版本号。
5. 补 Release 更新说明（Markdown，勿写 HTML），客户端更新页将其作为更新日志展示。

## 相关文档

- `ZCode接入TencentDB记忆库-全记录与方案.md` — 接入过程全记录与方案
- `整改方案-记忆链路契约与工程风险.md` — 契约与工程风险整改
