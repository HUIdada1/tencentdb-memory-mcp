// test/panel-codes.test.js — 面板响应判定（业务码 / HTTP 码 / 中文提示）一致性
//
// 为什么需要：
//   2026-09-22 对真实面板实测发现，本项目**最隐蔽的一类 bug** 就在这个判定上：
//     · HTTP 400 + code:400 + message:MISSING_BLOCK_ID  ← 旧实现当"成功"
//     · HTTP 404 纯文本（无 JSON）                        ← 旧实现当"成功"
//     · /skill/list 与 /meta/auth/verify 对**坏 userKey** 返回 200/code:0（不校验！）
//       → 旧实现写 `auth = nas`，auth 恒为 true，用户看到"连接正常"但全部静默失败
//   本测试把判定表与 `core/panel-codes.js` **唯一真源** 钉住，并断言
//   daemon 里那份**内联副本**（SEA 单文件要求）与它语义一致 —— 防两处漂移。
//
// 用真值表驱动，不联网（联网探测见 docs/改进方案-对齐上游规范.md 的实测记录）。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

const pc = require(path.join(ROOT, 'core', 'panel-codes.js'));
const CORE = read('core/tdai-core.js');
const DAEMON = read('daemon/tdai-daemon.js');
const MAIN = read('pet/src/main.js');
const CONSOLE_JS = read('pet/src/console.js');
const core = require(path.join(ROOT, 'core', 'tdai-core.js'));

/* ---------- ① 真值表：实测抓到的形态必须判对 ---------- */
{
  // [标签, {status, body}, 期望 ok, 期望 kind, 期望 codeKey]
  const table = [
    ['成功 200/code:0',            { status: 200, body: '{"code":0,"message":"ok","data":{"items":[]}}' }, true,  'ok',          ''],
    ['成功 200/无 code',            { status: 200, body: '{"items":[]}' },                                 true,  'ok',          ''],
    ['HTTP400 MISSING_INSTANCE_ID', { status: 400, body: '{"code":400,"message":"MISSING_INSTANCE_ID"}' }, false, 'auth',        'MISSING_INSTANCE_ID'],
    ['HTTP400 MISSING_USER_KEY',    { status: 400, body: '{"code":400,"message":"MISSING_USER_KEY"}' },    false, 'auth',        'MISSING_USER_KEY'],
    ['HTTP400 INVALID_INSTANCE',    { status: 400, body: '{"code":400,"message":"INVALID_INSTANCE"}' },    false, 'auth',        'INVALID_INSTANCE'],
    ['HTTP400 MISSING_BLOCK_ID',    { status: 400, body: '{"code":400,"message":"MISSING_BLOCK_ID"}' },    false, 'input',       'MISSING_BLOCK_ID'],
    ['HTTP400 INVALID_LAYER',       { status: 400, body: '{"code":400,"message":"INVALID_LAYER"}' },       false, 'input',       'INVALID_LAYER'],
    ['HTTP401 INVALID_USER_KEY',    { status: 401, body: '{"code":401,"message":"INVALID_USER_KEY"}' },    false, 'auth',        'INVALID_USER_KEY'],
    ['HTTP404 纯文本（无 JSON）',    { status: 404, body: '404 Not Found' },                                false, 'not-found',   ''],
    ['HTTP500 纯文本',              { status: 500, body: 'Internal Server Error' },                        false, 'server',      ''],
    ['HTTP503 + 业务码',            { status: 503, body: '{"code":503,"message":"SERVICE_UNAVAILABLE"}' }, false, 'server',      'SERVICE_UNAVAILABLE'],
    ['网络层 status 0',             { status: 0,   body: '' },                                             false, 'unreachable', ''],
    // ⚠️ 关键回归：面板可能用 HTTP 200 承载业务码，不能只看 HTTP
    ['HTTP200 + code:401',          { status: 200, body: '{"code":401,"message":"INVALID_USER_KEY"}' },    false, 'auth',        'INVALID_USER_KEY'],
    ['HTTP200 + code:500',          { status: 200, body: '{"code":500,"message":"INTERNAL_ERROR"}' },      false, 'server',      'INTERNAL_ERROR'],
    // 整句型 message（面板确实会返回 zod 的原话）
    ['整句型 message 取常量前缀',    { status: 400, body: '{"code":400,"message":"user_key: Invalid input: expected string, received undefined"}' }, false, 'unknown', ''],
  ];
  for (const [label, r, expOk, expKind, expKey] of table) {
    const v = pc.classify(r);
    chk(`① ${label} → ok=${expOk}`.replace('→  ', '→ '), v.ok === expOk, `实际 ok=${v.ok}`);
    chk(`① ${label} → kind=${expKind}`, v.kind === expKind, `实际 kind=${v.kind}`);
    if (expKey !== undefined) {
      chk(`① ${label} → codeKey=${expKey || '(空)'}`, v.key === expKey, `实际 ${v.key}`);
    }
  }
}

/* ---------- ② 失败必须给中文可操作提示（不能只回裸 HTTP 码） ---------- */
{
  const failCases = [
    { status: 400, body: '{"code":400,"message":"MISSING_BLOCK_ID"}' },
    { status: 400, body: '{"code":400,"message":"INVALID_INSTANCE"}' },
    { status: 401, body: '{"code":401,"message":"INVALID_USER_KEY"}' },
  ];
  for (const r of failCases) {
    const v = pc.classify(r);
    chk(`② ${v.key} 有中文 hint`, !!v.hint && /[\u4e00-\u9fa5]/.test(v.hint), '没有中文提示');
    chk(`② ${v.key} summarize 给出 hint`, pc.summarize(v) === v.hint, pc.summarize(v));
  }
  chk('② 成功时 summarize 返回空串', pc.summarize(pc.classify({ status: 200, body: '{"code":0}' })) === '');
}

/* ---------- ③ 鉴权类错误必须是「不可重试」，服务端类必须「可重试」 ---------- */
{
  chk('③ 坏 key 不可重试', pc.classify({ status: 401, body: '{"code":401,"message":"INVALID_USER_KEY"}' }).retriable === false);
  chk('③ 坏 serviceId 不可重试', pc.classify({ status: 400, body: '{"code":400,"message":"INVALID_INSTANCE"}' }).retriable === false);
  chk('③ 缺 block_id 不可重试', pc.classify({ status: 400, body: '{"code":400,"message":"MISSING_BLOCK_ID"}' }).retriable === false);
  chk('③ 5xx 可重试', pc.classify({ status: 500, body: 'x' }).retriable === true);
  chk('③ 网络层失败可重试', pc.classify({ status: 0, body: '' }).retriable === true);
  chk('③ 404 不可重试（契约不匹配，重试无意义）', pc.classify({ status: 404, body: '404' }).retriable === false);
}

/* ---------- ④ codeKeyOf：常量 / 整句 / 空 的提取 ---------- */
{
  chk('④ 纯常量', pc.codeKeyOf('INVALID_USER_KEY') === 'INVALID_USER_KEY');
  chk('④ 常量+冒号后缀', pc.codeKeyOf('INVALID_USER_KEY: something') === 'INVALID_USER_KEY');
  chk('④ zod 整句取不到常量（返回空）', pc.codeKeyOf('user_key: Invalid input: expected string, received undefined') === '');
  chk('④ 空值安全', pc.codeKeyOf(null) === '' && pc.codeKeyOf(undefined) === '' && pc.codeKeyOf('') === '');
  chk('④ 小写开头不误判为常量', pc.codeKeyOf('something went wrong') === '');
}

/* ---------- ⑤ API 前缀真源：是 /api/v1，不是上游文档的 /v3 ---------- */
{
  chk('⑤ panel-codes 声明 API_PREFIX=/api/v1', pc.API_PREFIX === '/api/v1', pc.API_PREFIX);
  chk('⑤ core/tdai-core.js 用 API_PREFIX 而非硬编码',
    /panel\.API_PREFIX/.test(CORE) && !/panelUrl \+ '\/api\/v1'/.test(CORE), '仍硬编码');
  chk('⑤ daemon 内联了 PANEL_API_PREFIX 且为 /api/v1',
    /const PANEL_API_PREFIX = '\/api\/v1';/.test(DAEMON), '未找到内联常量');
  chk('⑤ daemon 不再硬编码 /api/v1 拼接',
    !/cfg\.panelUrl \+ '\/api\/v1' \+ pathname/.test(DAEMON), 'mkApi 里仍硬编码');
  chk('⑤ core 顶部注释写明 /v3 是前端路由（防后人"对齐"错）',
    /\/v3/.test(CORE) && /前端路由|SPA/.test(CORE));
}

/* ---------- ⑥ daemon 的内联副本与 core 唯一真源语义一致 ---------- */
{
  // 内联常量与 core 完全相同
  const coreHints = /const PANEL_HINTS = \{([\s\S]*?)\n\};/.exec(read('core/panel-codes.js'));
  const daemonHints = /const PANEL_HINTS = \{([\s\S]*?)\n\};/.exec(DAEMON);
  chk('⑥ 两处都有 PANEL_HINTS', !!coreHints && !!daemonHints);
  if (coreHints && daemonHints) {
    const pick = (s) => [...s.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]).sort();
    const a = pick(coreHints[1]), b = pick(daemonHints[1]);
    chk('⑥ PANEL_HINTS 键集合一致', JSON.stringify(a) === JSON.stringify(b),
      `core=${a.length} daemon=${b.length} 差集=${a.filter((x) => !b.includes(x)).concat(b.filter((x) => !a.includes(x))).join(',')}`);
    chk('⑥ PANEL_HINTS 至少含 14 个码', a.length >= 14, String(a.length));
    // 值也要一致（提示文案漂移会让两端 UI 说法不同）
    const kv = (s) => Object.fromEntries([...s.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*'([^']*)'/gm)].map((m) => [m[1], m[2]]));
    const ka = kv(coreHints[1]), kb = kv(daemonHints[1]);
    const diffs = Object.keys(ka).filter((k) => kb[k] !== ka[k]);
    chk('⑥ PANEL_HINTS 文案一字不差', diffs.length === 0, diffs.join(','));
  }

  const coreCls = /const PANEL_CODE_CLASS = \{([\s\S]*?)\n\};/.exec(read('core/panel-codes.js'));
  const daemonCls = /const PANEL_CODE_CLASS = \{([\s\S]*?)\n\};/.exec(DAEMON);
  chk('⑥ 两处都有 PANEL_CODE_CLASS', !!coreCls && !!daemonCls);
  if (coreCls && daemonCls) {
    const kv = (s) => Object.fromEntries([...s.matchAll(/([A-Z][A-Z0-9_]+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]));
    const ka = kv(coreCls[1]), kb = kv(daemonCls[1]);
    const diffs = Object.keys(ka).filter((k) => kb[k] !== ka[k]);
    chk('⑥ PANEL_CODE_CLASS 映射一致', diffs.length === 0, diffs.join(','));
  }

  chk('⑥ 两处 PANEL_OK_CODE 都是 0',
    /const PANEL_OK_CODE = 0;/.test(read('core/panel-codes.js')) && /const PANEL_OK_CODE = 0;/.test(DAEMON));
  chk('⑥ 两处都有 classify 实现', /function classify\(/.test(read('core/panel-codes.js')) && /function classifyPanel\(/.test(DAEMON));
  chk('⑥ daemon 有内联说明（解释为何不 require）',
    /内联副本/.test(DAEMON) && /SEA/.test(DAEMON));
}

/* ---------- ⑦ mkApi 必须挂 v/ok，调用方不得再只看 HTTP 区间 ---------- */
{
  chk('⑦ daemon mkApi 返回 v 与 ok', /out\.v = classifyPanel\(out\);/.test(DAEMON) && /out\.ok = out\.v\.ok;/.test(DAEMON));
  // 采集上传主路径不得再用 HTTP 区间判成功（函数体约 25 行，给足窗口）
  const upload = /async function uploadBatch\(cfg, api, payload, state\) \{[\s\S]{0,2000}?\n\}/.exec(DAEMON);
  chk('⑦ uploadBatch 定位到', !!upload, '正则未匹配到函数');
  chk('⑦ uploadBatch 用 r.ok 判成功', !!upload && /if \(r\.ok\) \{/.test(upload[0]), '仍看 HTTP 区间');
  chk('⑦ uploadBatch 不再有 status>=200&&<300 判成功',
    !!upload && !/r\.status >= 200 && r\.status < 300/.test(upload[0]));
  // skill 缓存
  const cache = /async refresh\(\) \{[\s\S]{0,900}?\n    \}/.exec(DAEMON);
  chk('⑦ skill 缓存用 s.ok', !!cache && /if \(s\.ok && s\.json/.test(cache[0]));
  // recall 组装走 classifyPanel
  const recall = /async function buildRecall[\s\S]*?\n\}/.exec(DAEMON);
  chk('⑦ recall 路径走 classifyPanel', !!recall && /classifyPanel\(\{ status: r\.status, raw: r\.body \}\)/.test(recall[0]));
}

/* ---------- ⑧ 探活端点必须是「真校验 key」的那个（本次修掉的核心 bug） ---------- */
{
  // 三处探活统一用 /chat-memory/my-agents，且 auth 与 nas 分开
  chk('⑧ core health() 打 my-agents',
    /async health\(\)[\s\S]{0,1400}?api\('\/chat-memory\/my-agents'/.test(CORE), '仍用不校验的端点');
  chk('⑧ core health() auth 不再等于 nas',
    /const auth = !!a\.ok;/.test(CORE), '仍写 auth = nas');
  chk('⑧ core health() 的 nas 允许 4xx',
    /v\.status >= 100 && v\.status < 500/.test(CORE));
  // 网络层失败时 api() 返回的 err 不带 panel，health 必须兜底 kind，不能给 UI 空串
  chk('⑧ core health() 对"无 panel 结论"兜底 kind=unreachable',
    /kind: v\.kind \|\| 'unreachable'/.test(CORE) && /a\.panel \|\| \{ kind: 'unreachable'/.test(CORE));
  chk('⑧ core health() 缺配置时也给 kind',
    /hint: miss, kind: 'config', codeKey: ''/.test(CORE));
  chk('⑧ core health() 注释记录了 /skill/list 不校验 key 这个实测事实',
    /skill\/list[\s\S]{0,80}不校验|不校验[\s\S]{0,80}skill\/list/.test(CORE));

  const tc = /'\/api\/test-connection'[\s\S]{0,1400}?return;\n      \}/.exec(DAEMON);
  chk('⑧ daemon test-connection 打 my-agents', !!tc && /api\('\/chat-memory\/my-agents'/.test(tc[0]));
  chk('⑧ daemon test-connection auth 独立于 nas', !!tc && /auth = r\.ok;/.test(tc[0]));
  chk('⑧ daemon test-connection 不回退成 auth = nas', !!tc && !/auth = nas;/.test(tc[0]));

  chk('⑧ pet main.js testConn 打 my-agents',
    /async function testConn[\s\S]{0,1200}?api\('\/chat-memory\/my-agents'/.test(MAIN), '仍用不校验的端点');
  chk('⑧ pet main.js testConn auth 不再等于 nas',
    /const auth = !!r\.ok;/.test(MAIN), '仍写 auth = ok');
  chk('⑧ pet main.js testConn 注释记录了实测事实',
    /不校验|校验 userKey/.test(MAIN));

  // /health 也要带 auth 字段（函数体较长，给足窗口）
  const hp = /if \(u\.pathname === '\/health'\) \{[\s\S]{0,2600}?uploadSources,/.exec(DAEMON);
  chk('⑧ daemon /health 定位到', !!hp);
  chk('⑧ daemon /health 带 auth 字段', !!hp && /local: true, nas, auth,/.test(hp[0]));
}

/* ---------- ⑨ UI 必须能区分「面板活着但认证失败」 ---------- */
{
  chk('⑨ console.js 分开渲染 nas&&!auth（warn 而非笼统 err）',
    /j\.nas && !j\.auth/.test(CONSOLE_JS) && /banner\('b-conn', 'warn'/.test(CONSOLE_JS));
  chk('⑨ console.js 三态提示都在', /连接成功/.test(CONSOLE_JS) && /认证未通过/.test(CONSOLE_JS) && /连接失败/.test(CONSOLE_JS));
  // 右上角 pill 也要分「认证失败」与「连接失败」
  chk('⑨ 顶栏 pill 用 panelAuthFail 分文案',
    /snap\.panelAuthFail/.test(CONSOLE_JS) && /text = '认证失败'/.test(CONSOLE_JS));
  chk('⑨ pill 认证失败态指向"重新签发 userKey"',
    /重新签发 userKey/.test(CONSOLE_JS));
}

/* ---------- ⑨b main.js 的 _onHttp 观察者按 401/403 标记鉴权失败并透出 ---------- */
{
  chk('⑨b main.js 定义 panelAuthFail',
    /let panelAuthFail = false;/.test(MAIN));
  chk('⑨b _onHttp 里按 401/403 赋值',
    /panelAuthFail = \(st === 401 \|\| st === 403\);/.test(MAIN));
  chk('⑨b panelError 区分认证失败文案',
    /认证失败（HTTP \$\{st\}）/.test(MAIN));
  chk('⑨b 快照透出 panelAuthFail',
    (MAIN.match(/^\s*panelAuthFail,$/gm) || []).length >= 2, '快照/IPC 未透出（应至少 2 处）');
  chk('⑨b 重置时一并清 panelAuthFail',
    /panelOk = null; panelAuthFail = false; panelError = '';/.test(MAIN));
  chk('⑨b _onHttp 不再把 4xx 一律说成"面板返回 HTTP"',
    !/panelError = ok \? '' : \(st === 0/.test(MAIN) || /panelAuthFail \?/.test(MAIN));
}

/* ---------- ⑩ INSTALL/README 记录了这个坑（用户能自查） ---------- */
{
  const INSTALL = read('INSTALL.md');
  chk('⑩ INSTALL 说明"面板可达但 key 不对"要分开报',
    /可达[\s\S]{0,40}(认证|key|密钥)|(认证|密钥)[\s\S]{0,40}可达/.test(INSTALL), 'INSTALL 未讲区分方式');
  chk('⑩ INSTALL 提到 userKey 失效的自查',
    /userKey[\s\S]{0,120}(失效|重新|复制)/.test(INSTALL));
}

/* ---------- 输出 ---------- */
console.log(`\n---------- 面板响应判定验证：通过 ${ok.length} / 失败 ${bad.length} ----------`);
if (bad.length) {
  for (const b of bad) console.log('  ✗ ' + b);
  console.log('');
  process.exit(1);
}
for (const o of ok) console.log('  ✓ ' + o);
process.exit(0);
