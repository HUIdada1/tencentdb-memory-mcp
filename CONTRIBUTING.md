# 贡献指南

感谢你愿意参与。本项目是一个**零依赖**的腾讯云 TencentDB 记忆库接入工具集，
对"能不能跑"的要求高于"写得漂亮"——所以下面每一条都是为了**别把功能悄悄弄坏**。

---

## 一、开始之前

### 环境要求

| 你要改什么 | 最低 Node | 说明 |
|---|---|---|
| `core/` `daemon/` `mcp/` `register-all.cjs` `scripts/` `test/` | **≥16.0.0** | 零依赖，内置 `http`/`https`/`fetch` 兜底 |
| `pet/`（Electron 桌面应用，**源码运行或跑测试**） | **≥22.16.0** | 会话扫描用内置 `node:sqlite` 读 ZCode 会话库；低版本会静默降级 |

```bash
npm ci --prefix pet      # 只有测试与桌面应用需要（jsdom / electron / electron-builder）
npm run test:all         # 全量测试（19 个套件）—— 提交前必跑
npm run test:ci          # 与 CI 完全同一条链（额外跑 daemon/mcp 两条冒烟）
```

> 根目录**刻意不装任何依赖**（`package.json` 没有 `dependencies`）——
> 这是"零依赖"承诺的一部分，请不要为了图方便往根 `package.json` 里加包。

### 目录职责

| 目录 | 职责 | 改它的注意事项 |
|---|---|---|
| `core/tdai-core.js` | 零依赖 HTTP 客户端（配置 / 面板 API / 只读检索 / 会话导入） | 导出的是 `create(cfg)`，不是 `mkApi` |
| `core/clients.js` | **Agent 客户端清单唯一真源** | 加客户端只改这里；`daemon` 需同步内联一份（见下） |
| `daemon/tdai-daemon.js` | 单文件守护进程（HTTP :8100 + 采集循环） | **必须保持单文件自包含**，不能 `require` 外部模块（要能被 SEA 打包成独立 exe） |
| `mcp/tdai-mcp.js` | MCP stdio server（NDJSON JSON-RPC 2.0）+ CLI 双模式 | 工具的 `inputSchema` 必填字段要与 `core` 的实际入参一致 |
| `pet/src/*` | Electron 主进程与渲染层 | 见"前端约定" |
| `register-all.cjs` | 源码用户一键接入 | 与 `pet/src/register.js` 共用 `core/clients.js`，但**注册目标不同**（源码版指向 `node`，桌面版指向应用 exe）——这是刻意设计 |

---

## 二、提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <简短描述>

<可选正文：为什么这么改，而不是改了什么>

<可选 footer：BREAKING CHANGE / Closes #123>
```

### type

`feat` · `fix` · `docs` · `refactor` · `perf` · `test` · `build` · `ci` · `chore` · `revert`

### scope（用下面这些，不要自创）

| scope | 覆盖范围 |
|---|---|
| `core` | `core/tdai-core.js`、`core/clients.js` |
| `daemon` | `daemon/tdai-daemon.js`、`daemon/console.html` |
| `mcp` | `mcp/tdai-mcp.js` |
| `pet` | `pet/src/*`（主进程、守护宿主、会话扫描、指标、更新、控制台 UI） |
| `register` | Agent 接入（`register-all.cjs`、`pet/src/register.js`、指令文件、hook） |
| `ui` | 纯界面/样式改动（`console.html|css|js` 的视觉与交互） |
| `test` | `test/`、`scripts/verify-*.cjs` |
| `docs` | `README.md` / `docs/` / `CHANGELOG.md` / `CONTRIBUTING.md` / `INSTALL.md` |
| `ci` | `.github/workflows/*` |
| `deploy` | 打包、SEA 配置、electron-builder、发版流程 |

多个 scope 用逗号分隔：`fix(pet,daemon): ...`

### 示例

```
fix(pet,daemon): 守护停止后不再产生上传流量（三处来源全部封堵）
feat(register): 新增 Codex TOML 段自动追加
docs(install): 补面板侧准备步骤与端口冲突排查
```

### 版本号与 CHANGELOG

- 版本号必须**四处同步**：根 `package.json`、`pet/package.json`、
  `daemon/tdai-daemon.js` 的 `APP_VER`、`mcp/tdai-mcp.js` 的 `SERVER_VER`（CI 会拦）
- 面向用户的变更要写进 `CHANGELOG.md` 的 `[Unreleased]` 段（[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式）
- 发版由维护者手动触发 `Release` workflow；**tag 一经发布永久不可复用**

---

## 三、代码约定（违反会被测试直接拦下）

### 通用

- **全仓零机器路径**：不得出现作者机器路径或私有项目名。
  CI 的 `hygiene` job 会扫 `[A-Za-z]:[\\/](Users|用户)[\\/]` 与 `AgentHub` / `私人项目`。
  合法的通用占位符（`C:/Users/x/...`）与本应用自身的安装路径（`C:\Program Files\TD记忆守护\...`）在白名单内。
- **新增文件不要引依赖**（除非是 `pet/` 的 devDependency）。
- **"检测面"必须等于"写入面"**：如果你让某段代码往 X 写，那检测它的代码就只能查 X。
  历史教训：指令文件只写 `.zcode/AGENTS.md` + `.claude/CLAUDE.md`，检测却多查一个从不写入的
  `.claude/AGENTS.md` → 用户自带的同名文件造成"已接入"**假阳性**。
  凡是"写一套、查一套"的字面量都是 bug 温床，请抽成常量共用（参考 `core/clients.js` 的 `INSTR_TARGETS`）。
- **量纲要标清**：`upPeak`/`downPeak` 是 **bytes/s**（速率），`upPeakBytes`/`downPeakBytes` 是
  **单笔字节数**。混用会让 5MB 请求显示成 `4.77 MB/s`。

### 前端（`pet/src`）

- **CSS 禁止裸圆角**，必须用 `--r-xs/s/m/l/xl/2xl/pill` 变量（`scripts/verify-v3-skin.cjs` 会拦）
- **HTML 全文档 id 必须唯一**（`test/renderer-dom.test.js` 会查）。注意 `up-*` 已被更新页占用
- 新增 `data-act` 按钮必须在 `console.js` 的 `actions` 里有处理分支
- `console.js` 里 `$('#id')` 引用的 id 必须真实存在于 `console.html`
- **异步初始化有初值陷阱**：`S.guardEnabled` 初值 `true`，真实值由异步 `prefsLoad()` 回填。
  首屏渲染必须挂在 `prefsReady` 之后，否则会按错误状态渲染一遍且不会自我纠正

### 守护进程（`daemon/`）

- **单文件自包含**：不能 `require` 本项目其它模块（SEA 打包后没有那些文件）。
  需要与 `core/clients.js` 共享的常量只能内联，并**必须**在
  `test/clients-consistency.test.js` 的 ⑨ 组里有对应断言
- 新增写 `~/.zcode/tdai-daemon/` 或 `~/.zcode/tdai-mcp.json` 的代码要考虑并发与半写状态

### 测试

- **新增/修改行为必须补测试**。现有 19 个套件见 `package.json` 的 `test:all`
- **测试文件命名统一为 `*.test.js`**（`test/` 下不得出现 `-smoke.js` / `-dom.js` 这类后缀）。
  `test/docs-consistency.test.js` 的 ⑩b 组会强制校验，命名不合规直接红。
  辅助模块（夹具/驱动）放子目录，同样以 `.js` 结尾但不参与命名校验。
- **用 jsdom 的测试必须在末尾 `process.exit(0)`** —— 页面里的 1s/2s/15s 定时器不会自停，
  否则 `test:all` 会整条挂住（表现为 SIGTERM、无输出）
- **异步渲染的断言必须放进对应的 `setTimeout` 回调**，否则读到的是"加载中"占位
- 检查"代码里是否还有残留引用"时，**先把注释剥掉**再匹配，否则注释里的历史说明会误报
- 新增测试套件记得同时加进 `package.json` 的 `test:all` 与 `test:ci`，否则它永远不会在 CI 跑

### ⚠️ 最容易踩的三个坑

1. **块注释里出现 `*/`** 会提前闭合（例如写 `*/transcript.jsonl`）→ 直接语法错误
2. **修"状态类" bug 时，先列出这个值还有谁会写**。实测 `h-beat` 有 3 个写入点、
   `h-uptime` 有 3 个、探活有 2 个来源、启动有 2 条路径 —— 只改主路径必然留漏
3. **`JSON.stringify` 之后做 `includes(path)` 永远不命中** —— Windows 路径的 `\` 在 JSON 串里是 `\\`。
   历史教训：`register-all.cjs` 用这个判据做幂等，导致 hook 每次运行都翻倍

---

## 四、Pull Request

1. Fork → 建分支（建议 `fix/xxx` / `feat/xxx`）→ 改 → 跑 `npm run test:ci`
2. PR 描述里请写清：**改了什么、为什么、怎么验证的**（贴关键测试输出最好）
3. 面向用户的变更请同步更新 `CHANGELOG.md`
4. CI 必须全绿；`hygiene` job 不通过说明有硬编码残留

### 我们不会接受的改动

- 把项目改成**反向代理**形态（劫持 `ANTHROPIC_BASE_URL`）—— 本项目的核心设计是
  **不碰 LLM 链路**的旁路接入（Push 采集 + Pull 注入），这是刻意的架构选择，不是待改进项
- 给根 `package.json` 加运行时依赖（破坏"零依赖"承诺）
- 把 `daemon/tdai-daemon.js` 拆成多文件（破坏 SEA 单文件打包）
- 修改 `pet/package.json` 的 `build.appId`（`com.tdai.pet`）—— NSIS 升级按它派生 GUID，
  改了会让老用户的升级路径断裂

---

## 五、签名与许可

- 提交即表示你同意以 [MIT](LICENSE) 许可发布你的贡献
- 建议在提交信息末尾加 `Signed-off-by: 你的名字 <邮箱>`（`git commit -s`），
  表明你有权提交该代码（[DCO](https://developercertificate.org/)）

---

## 六、安全

- **不要在本仓库里提交任何真实凭据**（`userKey`、`user_key`、token、内网地址）
- 配置文件 `~/.zcode/tdai-mcp.json` 是**本机**文件，不在仓库内；
  文档里的示例请一律用 `sk-mem-...`、`team-...` 这类占位符
- 发现安全问题请**不要开公开 Issue**，通过仓库主页的邮箱私下联系维护者
