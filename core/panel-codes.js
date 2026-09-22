// core/panel-codes.js — 面板响应的**唯一**判定真源
//
// 为什么需要这个文件：
//   2026-09-22 对真实面板（http://muhuihao.top:8125）实测发现，面板**不是**"HTTP 状态码即结论"：
//
//   | 情况                      | HTTP | body                                  |
//   |---------------------------|------|---------------------------------------|
//   | 缺 X-Tdai-Service-Id      | 400  | {"code":400,"message":"MISSING_INSTANCE_ID"}  |
//   | 缺 X-Tdai-User-Key        | 400  | {"code":400,"message":"MISSING_USER_KEY"}     |
//   | serviceId 不存在           | 400  | {"code":400,"message":"INVALID_INSTANCE"}     |
//   | 检索没给 block_id          | 400  | {"code":400,"message":"MISSING_BLOCK_ID"}     |
//   | 分层传了非法 layer         | 400  | {"code":400,"message":"INVALID_LAYER"}        |
//   | 检索用错 user key          | 401  | {"code":401,"message":"INVALID_USER_KEY"}     |
//   | /skill/list 用错 user key  | 200  | {"code":0,"message":"ok"}  ← 该端点不校验 key！ |
//   | 端点不存在 / 方法不对       | 404  | 纯文本 404 Not Found（**无 JSON**）            |
//   | 成功                       | 200  | {"code":0,"message":"ok","data":{...}}         |
//
//   所以「HTTP 400 + 可操作业务码」和「HTTP 404」都**不是成功**，但旧实现只看
//   status===401/403 与 status>=500，会把它们判成成功 → 上游静默"上传成功"、
//   实际上什么都没写进去。这是本项目最隐蔽的一类 bug。
//
//   本文件把该判定收敛成一处置，core / daemon / mcp / pet 全部从这里取结论。
//   ⚠️ daemon 要能单独打包成 SEA exe（单文件自包含），所以 daemon 里**内联**了一份
//   等价的常量与函数；`test/clients-consistency.test.js` 会断言两者语义一致。
'use strict';

/** 面板业务成功码。实测只有 0；留 code===undefined 兼容未来"不带 code 的裸 2xx"。 */
const PANEL_OK_CODE = 0;

/**
 * 业务码 → 中文可操作提示。key 是面板 message 里的稳定常量（不是给人看的整句）。
 * 新增面板错误码时**只改这里**，四端同时生效。
 */
const PANEL_HINTS = {
  // —— 鉴权 / 实例（配置类问题，用户能自己修）——
  MISSING_INSTANCE_ID: '未带 X-Tdai-Service-Id 头：请在配置里填 serviceId（默认 default）',
  MISSING_USER_KEY: '缺少 userKey：请在「设置 → 记忆库连接」里填面板的用户密钥',
  INVALID_INSTANCE: 'serviceId 面板不认：核对「设置 → 记忆库连接」里的 serviceId 是否与面板一致',
  INVALID_USER_KEY: 'userKey 失效：去面板重新复制一份用户密钥，填回「设置 → 记忆库连接」',
  PERMISSION_DENIED: '当前 userKey 没有该操作权限：请在面板里给这个用户授权（或换有权限的 key）',
  FORBIDDEN: '当前 userKey 没有该操作权限：请在面板里给这个用户授权',
  // —— 入参（本工具内部问题，一般不该出现）——
  MISSING_BLOCK_ID: '缺少记忆块：请配置 teamId + agentId，或显式指定 block_id',
  INVALID_LAYER: 'layer 只支持 L0/L1/L2/L3：请检查记忆页选的层级',
  INVALID_TEAM_ID: 'teamId 无效或不存在：核对「设置 → 记忆库连接」里的团队 ID',
  INVALID_AGENT_ID: 'agentId 无效或不存在：核对「设置 → 记忆库连接」里的 Agent ID',
  // —— 服务端（可重试）——
  INTERNAL_ERROR: '面板内部错误（可重试）：若持续出现请查看面板服务端日志',
  SERVICE_UNAVAILABLE: '面板服务不可用（可重试）：稍后再试，或确认面板容器状态',
  LLM_ERROR: '面板的模型服务报错（可重试）：蒸馏/抽取依赖模型，稍后再试',
  EXTRACT_FAILED: '面板抽取流水线失败（可重试）',
};

/** 语义分类：配置类（用户改配置）/ 入参类（工具自身）/ 服务端（等）/ 未知 */
const PANEL_CODE_CLASS = {
  MISSING_INSTANCE_ID: 'config', MISSING_USER_KEY: 'config', INVALID_INSTANCE: 'config',
  INVALID_USER_KEY: 'config', PERMISSION_DENIED: 'config', FORBIDDEN: 'config',
  MISSING_BLOCK_ID: 'input', INVALID_LAYER: 'input', INVALID_TEAM_ID: 'input', INVALID_AGENT_ID: 'input',
  INTERNAL_ERROR: 'server', SERVICE_UNAVAILABLE: 'server', LLM_ERROR: 'server', EXTRACT_FAILED: 'server',
};

/** 面板 message 可能是常量，也可能是一整句人话。取常量部分做 key。 */
function codeKeyOf(message) {
  const s = String(message == null ? '' : message).trim();
  if (!s) return '';
  // 形如 "user_key: Invalid input: expected string, received undefined" → 取冒号前的 token
  const m = s.match(/^([A-Z][A-Z0-9_]{2,})/);
  if (m) return m[1];
  const head = s.split(/[:：]/)[0].trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(head) ? head : '';
}

/**
 * 把 `{ status, body }`（或已解析的 json）判成统一结论。
 *
 * @param {{status:number, body?:string, json?:object}} r 原始响应
 * @returns {{ok:boolean, status:number, code:(number|undefined), message:string,
 *            key:string, hint:string, cls:string, kind:string, retriable:boolean, json:object|null}}
 *
 * kind 取值：
 *   'ok'          —— 成功，可放心用 data
 *   'auth'        —— 鉴权/配置失败（UI 应引导去改配置）
 *   'input'       —— 入参错误（工具侧 bug）
 *   'not-found'   —— 端点不存在（多半是面板版本不匹配，**必须显式暴露**，不能当成功）
 *   'server'      —— 5xx / 面板内部错误（可重试）
 *   'unreachable' —— status===0（网络层失败）
 *   'unknown'     —— 其它非 2xx
 */
function classify(r) {
  const status = (r && typeof r.status === 'number') ? r.status : 0;
  let json = (r && r.json && typeof r.json === 'object') ? r.json : null;
  if (!json && r && typeof r.body === 'string' && r.body) {
    const t = r.body.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { json = JSON.parse(t); } catch (_) { json = null; } }
  }
  const rawCode = json ? json.code : undefined;
  const code = typeof rawCode === 'number' ? rawCode : undefined;
  const message = String((json && (json.message || json.msg || json.error)) || '');
  // 业务码常量可能出现在**三处**，都要认（缺一就会退化成"面板返回 HTTP 400"这种没用的提示）：
  //   ① message 里（实测主形态）：{"code":401,"message":"INVALID_USER_KEY: ..."}
  //   ② code 字段本身是常量串：{"code":"MISSING_INSTANCE_ID","message":"..."}
  //   ③ error 字段里（部分端点的写法）
  const key = codeKeyOf(
    (typeof rawCode === 'string' ? rawCode : '')
    || message
    || String((json && json.error) || ''));
  // 数字 code 落库后仍保留原始值，便于上层展示（如 code=401）
  const shownCode = typeof rawCode === 'string' ? rawCode : code;
  const hint = (key && PANEL_HINTS[key]) || '';
  const cls = (key && PANEL_CODE_CLASS[key]) || '';

  const base = { status, code: shownCode, message, key, hint, cls, json };

  // 网络层失败
  if (status === 0) {
    return Object.assign(base, { ok: false, kind: 'unreachable', retriable: true, hint: hint || '面板不可达：检查地址/端口/公网开闸' });
  }

  // ⚠️ 业务码优先于 HTTP 码：面板是 HTTP 400 + code:400 表达参数错误，
  //    也存在 HTTP 401 + code:401 的形态，但**绝不**假设业务码恒为 0。
  if (code !== undefined && code !== PANEL_OK_CODE) {
    // 业务码 401/403 一律归鉴权；即便面板某天用 HTTP 200 承载它，也能被抓住
    if (code === 401 || code === 403) {
      return Object.assign(base, { ok: false, kind: 'auth', retriable: false, hint: hint || 'userKey 失效或权限不足：去面板重新复制密钥' });
    }
    if (code >= 500) {
      return Object.assign(base, { ok: false, kind: 'server', retriable: true, hint: hint || '面板内部错误（可重试）' });
    }
    // 其它非 0 业务码：按语义分类（config = 用户改配置 / input = 工具入参 / server = 等服务端）
    const kind = cls === 'server' ? 'server' : (cls === 'config' ? 'auth' : (cls === 'input' ? 'input' : 'unknown'));
    return Object.assign(base, { ok: false, kind, retriable: cls === 'server', hint });
  }

  // 无业务码（或 code===0）时看 HTTP
  if (status >= 200 && status < 300) {
    return Object.assign(base, { ok: true, kind: 'ok', retriable: false, hint: '' });
  }
  if (status === 401 || status === 403) {
    return Object.assign(base, { ok: false, kind: 'auth', retriable: false, hint: hint || 'userKey 失效或权限不足：去面板重新复制密钥' });
  }
  if (status === 404) {
    // 端点不存在 = 面板与服务端契约不匹配，必须暴露（曾因静默当成功而查不出问题）
    return Object.assign(base, { ok: false, kind: 'not-found', retriable: false, hint: hint || '面板没有这个接口：请确认面板版本（本项目走 /api/v1 业务面）' });
  }
  if (status >= 500) {
    return Object.assign(base, { ok: false, kind: 'server', retriable: true, hint: hint || '面板 5xx（可重试）' });
  }
  return Object.assign(base, { ok: false, kind: 'unknown', retriable: false, hint: hint || `面板返回 HTTP ${status}` });
}

/** 给 UI 用的一行摘要：优先业务 hint，其次 message，最后 HTTP。 */
function summarize(v) {
  if (!v) return '';
  if (v.ok) return '';
  if (v.hint) return v.hint;
  if (v.message) return v.message;
  return v.status ? `面板返回 HTTP ${v.status}` : '面板不可达';
}

module.exports = {
  PANEL_OK_CODE,
  PANEL_HINTS,
  PANEL_CODE_CLASS,
  codeKeyOf,
  classify,
  summarize,
  // 面板业务面前缀（唯一真源）。⚠️ 是 /api/v1，**不是**上游文档里的 /v3。
  // 实测 2026-09-22：/v3/skill/list、/v3/chat-memory/search 全部 404；
  // GET /v3 会返回前端 SPA 的 index.html（说明 /v3 是**前端路由**，不是 API 前缀）。
  // 改了这里要同步改 daemon 的内联版本（SEA 单文件），测试会拦。
  API_PREFIX: '/api/v1',
};
