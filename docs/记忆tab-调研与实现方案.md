# 「记忆」Tab 分层展示与绘画 — 调研报告与实现方案

> 调研日期：2026-09-22
> 调研对象：`pet/src/console.html` → `[data-page="memory"]` 与 `pet/src/console.js`
> 上游面板：`http://192.168.31.13:8125`（Memory Hub，SPA）
> 配置记忆块：`chat_memory-team-zn0elw0289-agt-zoav7zxdz0`（Agent「码聊助手」）

---

## 结论速览

| 问题 | 结论 |
|---|---|
| L0–L3 文字内容能否从上游获取？ | **能，且数据很完整。** 实测 L0 有原文、L1 有 273 条、L2 有 9 条、L3 有 1 条 |
| 对应「绘画」数据能否从上游获取？ | **不能。** 穷尽检索面板前端包与 i18n，**上游不存在任何绘画/插图/图像字段** |
| 当前页面展示了吗？ | **基本没有。** 现有代码字段名与上游不匹配，三种渲染分支全部落空，最终**直接吐原始 JSON** |
| 实现方案核心 | 文字**走上游接口**；绘画**本地构造**（SVG 数据可视化 + 确定性生成式几何图形，不引入第三方绘图库） |

---

## 一、上游接口调研

### 1.1 面板是 SPA，接口需从 bundle 反查

直接请求 `/openapi.json`、`/docs`、`/api/v1/meta/routes` 均返回 404（`/docs` 甚至回落到 SPA 首页）。
因此改为拉取面板前端包反查：

```
GET http://192.168.31.13:8125/assets/main-CdwHEhgx.js   (1,909,757 bytes)
```

从包内提取到两套 HTTP 封装：`Rr()` 用于 knowledge 命名空间，`Bi()` 用于 chat-memory 命名空间，
前缀常量 `WG = "/api/v1/chat-memory"`。据此还原出完整接口表。

### 1.2 核心接口：`POST /api/v1/chat-memory/layer`

这是**四层取数的唯一权威接口**。

**请求头**（三个都必须带，缺 `X-Tdai-Service-Id` 会被拒）
```
Content-Type: application/json
X-Tdai-Service-Id: default
X-Tdai-User-Key: <userKey>
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `block_id` | string | ✅ | 形如 `chat_memory-<team_id>-<agent_id>` |
| `layer` | string | ✅ | `L0` / `L1` / `L2` / `L3` |
| `limit` | number | | 默认 50，**上限 200** |
| `offset` | number | | 分页偏移，实测生效 |
| `path` | string | | **L2 专用**，取单篇正文 |
| `before_ts` | number | | 时间游标（加载更早） |
| `time_start` / `time_end` | number | | 时间范围筛选 |

**响应信封**（所有接口统一）
```json
{ "code": 0, "message": "ok", "request_id": "...", "data": { ... } }
```

**`data` 结构**
```json
{ "layer": "L1", "items": [ ... ], "total": 273, "limit": 2, "offset": 0 }
```

### 1.3 四层字段各不相同（**实现时最关键的坑**）

| 层 | items 字段 | 实测样例 |
|---|---|---|
| **L0** 对话原文 | `{id, role, title, body, created_at}` | `role:"assistant"`, `title:"assistant @ backfill-zcode-rollout-..."` |
| **L1** 原子记忆 | `{id, title, body, tags:[], refs:[], created_at}` | `title:"work_fact"` / `"work_method"` / `"work_task"` |
| **L2** 场景记忆 | `{id, title, body, tags:[], refs:[], created_at}` | `title:"TDMemoryGuard-发版发布流程.md"`，**列表接口 `body` 恒为 `""`** |
| **L3** 核心记忆 | `{id, title, body, tags:[], refs:[], created_at}` | `id:"core"`, `title:"core memory"`, `body` 是长 Markdown |

> ⚠️ **三个实现要点**
> 1. **正文字段名是 `body`**，不是 `content` / `text` / `memory` —— 现有代码读错了，这是"只能看到 JSON"的直接原因之一。
> 2. **L2 列表返回的 `body` 是空字符串**，必须带 `path` 二次请求才有正文（实测已验证）：
>    `{"layer":"L2","path":"TDMemoryGuard-发版发布流程.md"}` → 返回带 `-----META-START-----` 头的完整正文（含 `summary` / `heat` 元信息）。
> 3. **L1 的 `title` 是语义标签**（`work_fact` / `work_method` / `work_task`），做 UI 时可以映射成中文分组（事实 / 方法 / 任务）。

### 1.4 配套接口

| 端点 | 用途 | 关键字段 |
|---|---|---|
| `POST /chat-memory/search` | 语义检索（带相关度） | 入参 `{block_id, layer, query, limit, type?}`；返回 items **多一个 `score`**（0~1） |
| `POST /chat-memory/my-agents` | 拿 block_id 与各层计数 | `id`、`layer_counts:{L0_messages,L1,L2,L3}`、`summary`、`scope` |
| `POST /chat-memory/team-assets` | 团队资产总览 | 实测返回空（本团队无共享资产） |
| `POST /chat-memory/layer-update` | **写**：编辑某层条目 | `{block_id, layer, id?, content, summary?}` |
| `POST /chat-memory/import` | 写入 L0 原文 | `{team_id, agent_id, session_id, messages}` |
| `POST /chat-memory/agent-fixed` / `allocate` / `patch-scope` / `unbind` | 记忆块分配与可见性 | — |

### 1.5 「绘画」数据 —— 明确不存在

在面板 bundle（1.9MB）与全部 i18n 文案中穷尽检索：

| 检索词 | 命中结果 |
|---|---|
| `paint` / `Paint` | 4 处，全是 React 内部 `unstable_requestPaint` / `paint-order`（SVG 属性表） |
| `draw` / `Draw` | 11 处，全是 antd 的 `Drawer`（抽屉组件） |
| `image` / `Image` / `picture` / `thumbnail` / `poster` | 无业务含义命中（仅 `"link":"image"` 这类无关项） |
| `illustration` / `visualization` / `mindmap` / `mermaid` / `echarts` / `three.js` | **0 命中** |
| 中文「绘画 / 画作 / 插图 / 配图 / 图集 / 海报」 | **0 命中** |

面板侧对四层的实际呈现方式就是**纯文本**：
- 左侧记忆块列表卡，副标题写 `0 条 L1 · 0 条 L2 · 0 条 L3`
- 右侧分层 tab（L0/L1/L2/L3）+ 文本条目列表 + 语义搜索框
- 面板 i18n 已给出各层定义文案（可直接复用）：

| 层 | 面板原文案 |
|---|---|
| L0 | `L0 · 对话原文` — 原始对话 / 工具调用流水，不做压缩 |
| L1 | `L1 · 原子记忆` — 从原文抽取出来的最小事实 / 约束 |
| L2 | `L2 · 场景记忆` — 围绕场景聚合的多条原子记忆总结 |
| L3 | `L3 · 核心记忆` — 沉淀的核心准则 / 模板 / 决策 |

> 面板自带的两处「图形化」是 `wiki/graph`（Wiki 图谱）与 `code-graph/*`（代码图谱），
> 属于**知识图谱**，与记忆分层无关，**不能拿来当记忆绘画用**。

**➜ 结论：绘画功能必须本地构造，不存在"接一下上游就能出图"的路径。**

---

## 二、当前「记忆」Tab 实现分析

### 2.1 HTML 结构（`console.html` L185–197）

```html
<section data-page="memory" class="page">
  <div class="toolbar glass">
    <input id="mem-q" placeholder="检索对话记忆…（回车即检索）">
    <select id="mem-topk"><option>5</option><option>10</option><option>20</option></select>
    <button data-act="memory-search" class="btn-primary">检索</button>
    <button data-act="memory-layers" class="btn-ghost">L1/L2/L3 分层</button>
    <button data-act="backfill-start" class="btn-ghost" id="bf-btn">回传历史会话</button>
  </div>
  <div id="b-backfill" class="banner"></div>
  <div id="mem-out" class="out glass">
    <div class="empty">输入关键词后回车开始检索，或点「L1/L2/L3 分层」查看记忆分层结构。</div>
  </div>
</section>
```

**结论**：整页只有一个**扁平输出容器** `#mem-out`，**没有任何分层结构、没有层导航、没有任何可视化元素**。

### 2.2 JS 渲染逻辑（`console.js`）

`renderMemResult()`（L637–693）是一条三级 fallback 链，**三级全部打不中**：

| 分支 | 代码期望 | 上游实际 | 结果 |
|---|---|---|---|
| ① 条目列表 | `it.content \|\| it.text \|\| it.memory \|\| it.value` | 字段名是 **`body`** | **内容取不到**，退化为 `JSON.stringify(it)` |
| ② 分层数组 | `d.layers` / `d.levels` 为数组 | 返回的是 `{layer, items, total}` | **落空** |
| ③ 兜底 | `JSON.stringify(...)` 塞进 `<pre class="mem-raw">` | — | **命中** ← 你看到的"一大坨 JSON" |

其他相关代码：
- `onMemoryShown()`（L697）：进入页面自动调 `memory_layers`（不带 layer，走 `core.memoryLayers` 的四层计数分支，每层只拉 `limit:1` 求 `total`）
- `actions['memory-search']`（L758）/ `actions['memory-layers']`（L764）
- 数据链路：`console.js` → `tdai.toolCall('memory_search')` → IPC `tool-call` → `main.js` L580 映射表 → `core.tdai-core.js`

**`core/tdai-core.js` 的能力缺口**（这是必须补的底层）：

| 现有 | 缺失 |
|---|---|
| `memorySearch({query, top_k, layer, agent_id, block_id})` | 无分页参数透传 |
| `memoryLayers({layer, limit, offset, ...})` | **不支持 `path` / `before_ts` / `time_start` / `time_end`** |

### 2.3 CSS

`console.css` 已有 `.mem-item` / `.mem-head` / `.mem-lv` / `.mem-txt` / `.mem-meta` / `.mem-score` / `.mem-raw`，
**但没有 `.layer-bar`**（分层可视化条）。

值得注意的是：桌面原型稿 `TD记忆守护-原型设计稿/pages/02-memory.html` **已经设计了**完整的记忆页——
`.layer-bar` 分层构成条、三张层说明卡、带 `score` 的条目列表、空态/错误态；
其 `.layer-bar` 样式在原型 `assets/components.css` L638 也有实现。**但这一版从未移植进 `pet/src/`。**

### 2.4 缺口清单

| # | 缺口 | 严重度 |
|---|---|---|
| 1 | 正文字段名不匹配（`body` vs `content`），内容根本渲染不出来 | 🔴 阻塞 |
| 2 | 无 L0–L3 分层导航，四层无法分别查看 | 🔴 阻塞 |
| 3 | 无分页（L1 有 273 条，只看得到前几条） | 🟠 高 |
| 4 | L2 哑 `body` 未处理，点了也看不到正文 | 🟠 高 |
| 5 | 无分层可视化（原型 `.layer-bar` 未落地） | 🟡 中 |
| 6 | 无「绘画」展示 | 🟡 中 |
| 7 | 按钮文案「L1/L2/L3 分层」**漏掉 L0**，与"应展示 L0–L3"不符 | 🟡 中 |
| 8 | 顺带：`layer-update` 写接口未接入，记忆只读不可编辑 | 🔵 低 |

---

## 三、实现方案

### 3.1 数据来源

| 内容 | 来源 |
|---|---|
| L0/L1/L2/L3 正文、标题、标签、时间 | **上游 `chat-memory/layer`** |
| 各层条数 | 上游 `layer` 响应的 `total`（或 `my-agents` 的 `layer_counts`） |
| 语义检索 + 相关度 | 上游 `chat-memory/search`（`score`） |
| **绘画 / 视觉图形** | **本地构造**（上游无） |

先补齐底层能力（`core/tdai-core.js`）：

```js
// memoryLayers 增加 path / before_ts / time_start / time_end 透传
async memoryLayers({ layer, limit = 50, offset = 0, path, before_ts, time_start, time_end,
                     team_id, agent_id, block_id } = {}) {
  // body 增加：
  //   ...(path ? { path } : {}),
  //   ...(before_ts ? { before_ts } : {}),
  //   ...(time_start ? { time_start } : {}),
  //   ...(time_end ? { time_end } : {}),
}

// 新增 countLayers()：一次 my-agents 拿 layer_counts，替代现在"四层各拉 1 条"的 4 次请求
async countLayers({ team_id, agent_id, block_id } = {}) { /* my-agents → layer_counts */ }
```

然后在 `main.js` L580 的 `map` 里加上 `memory_layer_update` 等新工具名。

### 3.2 页面应展示的内容

**每层的文字描述**（直接复用面板 i18n 口径，保证与官方一致）：

| 层 | 名称 | 描述 | 主色建议 |
|---|---|---|---|
| L0 | 对话原文 | 原始对话 / 工具调用流水，不做压缩 | `c-blue` |
| L1 | 原子记忆 | 从原文抽取出来的最小事实 / 约束 | `c-teal` |
| L2 | 场景记忆 | 围绕场景聚合的多条原子记忆总结 | `c-amber` |
| L3 | 核心记忆 | 沉淀的核心准则 / 模板 / 决策 | `c-purple` |

**条目的展示形式**（按层差异化）：

| 层 | 渲染形式 |
|---|---|
| L0 | **对话气泡流**（`role` 决定左右/配色）+ 会话名小字 + 时间；支持「加载更早的对话」 |
| L1 | **卡片列表**：`title` 映射成中文徽标（`work_fact`→事实 / `work_method`→方法 / `work_task`→任务），正文 `body` 全文 |
| L2 | **文档卡片**：标题 + 点击后带 `path` 拉正文，正文里的 `-----META-START-----` 块解析出 `summary` / `heat` 单独展示 |
| L3 | **长文阅读视图**：Markdown 渲染（标题层级、列表、引用块），突出"准则/模板"的文档感 |

**「绘画」的展示形式** —— 分三级，按优先级落地：

**① SVG 数据可视化（本质是把数据画成图，最实用）**
- **分层构成条**（`layer-bar`）：横向条，四层按条数占比分配宽度，hover 显示条数，点击切层 —— 原型稿已设计，直接移植
- **分层雷达 / 占比环**：L0–L3 四轴，一眼看出"记忆沉淀到了哪一层"
- **时间生长曲线**：按 `created_at` 聚合，展示记忆随时间的沉淀量（L3 增长 = 知识固化）
- **检索相关度条**：`score` 的横向进度条，让"相关度"视觉化

**② 确定性生成式几何图形（"绘画"字面意义的落地）**
- 用**条目 id 做哈希 seed**，程序化生成 SVG 几何图案作为该层的"视觉标识"：
  每层一套调色 + 一套几何语法（L0 连续折线＝对话流、L1 离散点阵＝原子、L2 聚类圆簇＝场景、L3 规整网格＝准则）
- **同一 id 永远生成同一张图**（确定性），既美观又可用作条目指纹
- 纯手工 SVG 路径 + 数学，**不引入任何第三方绘图库**（符合项目零依赖约束）

**③ 服务端渲染的图像（不做）**
- 不接图像生成模型。原因：与"记忆库是纯文本语义系统"的定位不符，且引入外部依赖与成本。

### 3.3 布局建议

建议把记忆页从"单容器"改成**左右分栏主从布局**：

```
┌─────────────────────────────────────────────────────────────┐
│ 工具条：检索框 | TopK | 检索 | 回传历史会话 | 刷新          │
├─────────────────────────────────────────────────────────────┤
│ 分层构成条（.layer-bar）：L0 ▓▓▓▓ | L1 ▓▓▓ | L2 ▓ | L3 ▓    │ ← 点击切层
├──────────────┬──────────────────────────────────────────────┤
│ 层导航（左） │  内容区（右）                                 │
│              │  ┌────────────────────────────────────────┐  │
│ ● L0 原文    │  │ 层标题 + 描述 + 条数 + 该层绘画图形     │  │
│   1,240 条   │  ├────────────────────────────────────────┤  │
│ ○ L1 原子    │  │ 条目列表（按层差异化渲染）              │  │
│   273 条     │  │  ┌──────────────────────────────────┐   │  │
│ ○ L2 场景    │  │  │ L1 卡片：徽标 + 正文 + 时间      │   │  │
│   9 条       │  │  └──────────────────────────────────┘   │  │
│ ○ L3 核心    │  │  …                                     │  │
│   1 条       │  │  [ 加载更多 ]  第 1/N 页                │  │
│              │  └────────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────┘
```

**交互方式**
- 进入页面：拉一次各层计数 → 渲染层导航徽标 + 分层构成条 → 默认选中 **L1**（信息密度最高）或上次停留层（记忆到 `prefs`）
- 点层 / 点构成条：切层，首次进入该层才发请求（懒加载 + 结果缓存）
- 检索框：走 `search` 接口，结果带相关度条；命中项标注所属层
- 分页：滚动到底自动加载 or 显式「加载更多」，`limit=50`，`total` 驱动进度显示
- L1 条目支持展开/收起长正文（`body` 可能很长）
- L3 的 Markdown 用轻量渲染（`h2/h3/列表/引用/加粗/行内代码`，自己写 30 行即可，别引 markdown 库）
- 空态：某层为 0 时，明确写「该层暂无条目 —— 需 L0 积累到一定量后由服务端蒸馏产出」（复用面板口径）
- 错误态：区分「面板不可达」与「未配置」，与总览页的连接状态同一口径

### 3.4 实现优先级与关键步骤

#### P0 —— 让内容真正显示出来（必须先做）
1. `core/tdai-core.js`：`memoryLayers` 补 `path` / 时间参数透传；新增 `countLayers()`
2. `console.js` 的 `renderMemResult` 重写：**字段改读 `body`**，按 `layer` 分支渲染
3. `console.html`：加层导航 + 分层构成条骨架；按钮文案改「L0–L3 分层」
4. 分页：`limit=50` + `offset`，加「加载更多」
5. **验收**：L0–L3 四层都能点开并看到真实正文，不再出现 `<pre>` 原始 JSON

#### P1 —— 分层可视化 + 读数
6. 移植原型的 `.layer-bar` 到 `console.css`；四层按条数占比 + 各自主色
7. 层导航徽标显示条数；层描述文案复用面板 i18n 口径
8. **验收**：一屏内看清四层构成与各自规模

#### P2 —— 绘画
9. 实现确定性 seed 生成式 SVG（每层一套几何语法），作为层标识
10. 时间生长曲线（按 `created_at` 聚合）
11. 检索相关度条
12. **验收**：同一条目每次进入生成同一张图；图形随主题（light/dark）正确换色

#### P3 —— 增强
13. L2 `path` 单读 + `META` 块解析出 `summary` / `heat`
14. L3 Markdown 渲染
15. 接入 `layer-update` 做条目编辑
16. 时间范围筛选（`time_start` / `time_end`）

### 3.5 必须遵守的项目约束（踩坑预警）

> 依据项目既有约定，以下几处**改完必须同步更新**，否则测试会红：

1. **tab 数量/顺序是契约** —— 本方案**不新增 tab**，只在 `memory` 页内部加二级结构，因此 `test/renderer-dom.test.js`、`test/ui.test.js`、`test/preview-verify.test.js` 里的 tab 断言不受影响
2. **`test/ui.test.js` 校验 page 前必须先剥 HTML 注释**（`replace(/<!--[\s\S]*?-->/g,'')`），否则被注释的 tab 会误匹配通过
3. **断言 DOM 顺序/数量必须 `querySelectorAll` 取数组比索引**，不能用文本包含 —— 分层构成条的"L0 在最左、L3 在最右"属于顺序契约
4. **jsdom 下 `document.readyState` 不可信** —— 新增的 boot 逻辑必须 `boot()` 无条件立即调用 + `DOMContentLoaded` 兜底 + `booted` 幂等守卫
5. **`core.create()` 不接受 `cfgPath` override** —— 测试里必须直接覆盖 `panelUrl/userKey/teamId/agentId/blockId`，否则请求会打到用户**真实记忆库**
6. **`memorySearch` 必须带 `blockId`**，否则发 HTTP 前就返回错误，观察者收不到事件
7. 改完渲染层务必跑 `npm run test:all`（当前 192 项）
8. 新增的分层可视化建议按既有惯例**固化成正式测试**（如 `console-layers.js`），不要只跑一次性诊断脚本

---

## 四、附：可直接使用的接口样例

```bash
# 分层取数（L1 第 6 条起取 3 条）
curl -X POST http://192.168.31.13:8125/api/v1/chat-memory/layer \
  -H "Content-Type: application/json" \
  -H "X-Tdai-Service-Id: default" \
  -H "X-Tdai-User-Key: $TDAI_USER_KEY" \
  -d '{"block_id":"chat_memory-<team>-<agent>","layer":"L1","limit":3,"offset":5}'

# L2 单篇正文（必须带 path，否则 body 为空）
curl -X POST http://192.168.31.13:8125/api/v1/chat-memory/layer \
  -H "Content-Type: application/json" \
  -H "X-Tdai-Service-Id: default" \
  -H "X-Tdai-User-Key: $TDAI_USER_KEY" \
  -d '{"block_id":"chat_memory-<team>-<agent>","layer":"L2","limit":1,"path":"TDMemoryGuard-发版发布流程.md"}'

# 语义检索（结果带 score）
curl -X POST http://192.168.31.13:8125/api/v1/chat-memory/search \
  -H "Content-Type: application/json" \
  -H "X-Tdai-Service-Id: default" \
  -H "X-Tdai-User-Key: $TDAI_USER_KEY" \
  -d '{"block_id":"chat_memory-<team>-<agent>","layer":"L1","query":"蒸馏","limit":5}'

# 各层计数（一次拿全）
curl -X POST http://192.168.31.13:8125/api/v1/chat-memory/my-agents \
  -H "Content-Type: application/json" \
  -H "X-Tdai-Service-Id: default" \
  -H "X-Tdai-User-Key: $TDAI_USER_KEY" \
  -d '{"team_id":"<team>"}'    # → data.items[].layer_counts
```
