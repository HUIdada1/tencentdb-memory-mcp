// ZCode hook 结构守卫：按 ZCode 3.14.3 内嵌的 zod schema 校验本工具写出的 hook 配置。
//
// 为什么单独一个文件：2026-09-23 的真实故障 —— 本工具把 UserPromptSubmit hook
// 写在**用户级** ~/.zcode/cli/config.json 的 `hooks.UserPromptSubmit`，而 ZCode 3.14.3
// 的 schema 是 `.strict()` 的 `hooks = { enabled?, timeoutMs?, maxOutputBytes?, events? }`。
// 多出的 UserPromptSubmit 被判 `Unrecognized key` → **整份用户配置作废** →
// plugins.enabledPlugins 读不到、插件开关点了就弹回。用户表现为"插件无法启用"。
//
// 本测试把官方 schema 的**结构约束**固化下来（零依赖手写等价校验），
// 确保以后不会有人再把旧写法加回来。schema 出处：
//   E:\ZCode\resources\app.asar → /out/main/index.js
//   var Fa=_.object({matcher:...,hooks:_.array(_.discriminatedUnion("type",[process,command])).min(1)}).strict()
//   var jw=_.object({enabled,timeoutMs,maxOutputBytes,events:_.object({<7个事件>:_.array(Fa)}).strict().optional()}).strict()
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function chk(name, ok, extra) { results.push(ok); console.log(ok ? '  ✓' : '  ✗', name, extra ? `→ ${extra}` : ''); }

// ---- ZCode 3.14.3 的 schema 结构（逐字对照，改这里前先核对 asar 是否变了） ----
const ZCODE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const HOOKS_KEYS = ['enabled', 'timeoutMs', 'maxOutputBytes', 'events'];
const ITEM_KEYS = ['matcher', 'hooks'];

function validateHookItem(x) {
  const errs = [];
  for (const k of Object.keys(x)) if (!ITEM_KEYS.includes(k)) errs.push(`item 未知键「${k}」`);
  if (x.matcher !== undefined && (typeof x.matcher !== 'string' || !x.matcher.length)) errs.push('matcher 非空字符串');
  if (!Array.isArray(x.hooks) || !x.hooks.length) errs.push('hooks 需至少 1 项');
  else x.hooks.forEach((h, i) => {
    if (h.type !== 'command' && h.type !== 'process') errs.push(`hooks[${i}].type 须为 command|process`);
    if (typeof h.command !== 'string' || !h.command.length) errs.push(`hooks[${i}].command 非空字符串`);
  });
  return errs;
}
function validateHooks(hooks) {
  const errs = [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return ['hooks 不是对象'];
  for (const k of Object.keys(hooks)) if (!HOOKS_KEYS.includes(k)) errs.push(`hooks 未知键「${k}」（ZCode 判整份配置无效）`);
  if (hooks.enabled !== undefined && typeof hooks.enabled !== 'boolean') errs.push('enabled 须为 boolean');
  for (const nk of ['timeoutMs', 'maxOutputBytes']) {
    if (hooks[nk] !== undefined && !(typeof hooks[nk] === 'number' && hooks[nk] > 0)) errs.push(`${nk} 须为正数`);
  }
  if (hooks.events !== undefined) {
    if (typeof hooks.events !== 'object' || hooks.events === null || Array.isArray(hooks.events)) return errs.concat('events 须为对象');
    for (const k of Object.keys(hooks.events)) {
      if (!ZCODE_HOOK_EVENTS.includes(k)) errs.push(`events 未知事件「${k}」`);
      if (!Array.isArray(hooks.events[k])) { errs.push(`events.${k} 须为数组`); continue; }
      hooks.events[k].forEach((it) => errs.push(...validateHookItem(it).map((m) => `events.${k}: ${m}`)));
    }
  }
  return errs;
}

/* ---------- 用真实 register 产出配置，再按官方 schema 校验 ---------- */
const reg = require(path.join(ROOT, 'pet', 'src', 'register.js'));
const clients = require(path.join(ROOT, 'core', 'clients.js'));
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-sch-h-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-sch-ws-'));
const EXE = 'C:\\App\\TD.exe';

fs.mkdirSync(path.join(H, '.zcode', 'cli'), { recursive: true });
fs.writeFileSync(path.join(H, '.zcode', 'cli', 'config.json'), JSON.stringify({ plugins: { enabled: true, enabledPlugins: { 'a@m': true } }, mcp: { servers: {} } }, null, 2));
fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ mcpServers: {} }));
fs.writeFileSync(path.join(H, '.claude', 'settings.json'), JSON.stringify({}));

reg.register({ home: H, exePath: EXE, mcpJs: 'C:\\App\\mcp.js', daemonJs: 'C:\\App\\daemon.js', workspaceRoot: WS });

console.log('【ZCode hook 结构守卫（按 3.14.3 schema）】');

// ① 工作区级 hook 必须通过官方 schema
const wsFile = path.join(WS, '.zcode', 'config.json');
chk('hook 写入工作区级 .zcode/config.json', fs.existsSync(wsFile), wsFile);
const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
const errs = validateHooks(ws.hooks);
chk('工作区 hooks 段通过 ZCode 3.14.3 schema（无 Unrecognized key）', errs.length === 0, errs.join('; '));
chk('层级为 hooks.events.UserPromptSubmit', !!(ws.hooks && ws.hooks.events && Array.isArray(ws.hooks.events.UserPromptSubmit)));
chk('未使用旧写法 hooks.UserPromptSubmit（会被判非法）', !Array.isArray(ws.hooks && ws.hooks.UserPromptSubmit));
chk('事件名在 ZCode 支持集内', Object.keys(ws.hooks.events).every((k) => ZCODE_HOOK_EVENTS.includes(k)), Object.keys(ws.hooks.events).join(','));

// ② 反例自检：旧写法必须被校验器抓到（证明校验器真的有效，不是空转）
const badErrs = validateHooks({ UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] });
chk('反例「旧写法」被判非法（校验器有效）', badErrs.length > 0, badErrs[0] || '');

// ③ 用户级配置必须不含 hooks（否则整份配置作废 → 插件开关失效）
const user = JSON.parse(fs.readFileSync(path.join(H, '.zcode', 'cli', 'config.json'), 'utf8'));
chk('用户级 config.json 无 hooks 键', !('hooks' in user));
chk('用户级 config.json 的 plugins 未被误删', !!(user.plugins && user.plugins.enabledPlugins));

// ④ Claude Code 保持用户级 + 无 events 层（不能被 ZCode 的改法带跑）
const cc = JSON.parse(fs.readFileSync(path.join(H, '.claude', 'settings.json'), 'utf8'));
chk('Claude Code 仍写用户级 hooks.UserPromptSubmit', Array.isArray(cc.hooks && cc.hooks.UserPromptSubmit));
chk('Claude Code 未被写入 events 层（两种客户端不同构）', !(cc.hooks && cc.hooks.events));

// ⑤ 清单层面的 scope 声明
const zcHook = clients.byKey('zcode').hook;
chk('清单声明 zcode hook 为工作区级', zcHook.scope === 'workspace', zcHook.scope);
chk('清单声明 zcode hook 需 events 容器', zcHook.eventsContainer === 'events', zcHook.eventsContainer);
chk('清单声明 zcode 用户级禁止 hooks', zcHook.forbiddenAtUserConfig === true, String(zcHook.forbiddenAtUserConfig));

fs.rmSync(H, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });

const failed = results.filter((x) => !x).length;
console.log(`\n结果：${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
