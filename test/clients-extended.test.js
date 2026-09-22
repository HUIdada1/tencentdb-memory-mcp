// test/clients-extended.test.js — 扩充客户端的**读写往返**验证（P2-1）
//
// 与 clients-consistency.test.js 的分工：
//   clients-consistency —— 静态：清单字段完整 / 两端同源 / daemon 内联副本一致
//   本文件             —— 动态：真跑一遍 register/status/unregister，
//                         验证各形态**确实落到正确的文件与字段**，且不破坏用户已有配置
//
// 重点覆盖两个"新方言"（写错客户端会直接不认这个服务器）：
//   opencode —— 字段名是 mcp（不是 mcpServers），且 command 必须是**数组**
//   yaml     —— Hermes 的 mcp_servers 写在**主配置 config.yaml** 里，
//               且必须插到 mcp_servers 块**内部**（追加到文件末尾会挂错父节点）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const reg = require(path.join(ROOT, 'pet', 'src', 'register.js'));
const clients = require(path.join(ROOT, 'core', 'clients.js'));

const EXE = 'C:\\Program Files\\TD记忆守护\\TD记忆守护.exe';
const MCPJS = 'C:\\Program Files\\TD记忆守护\\resources\\mcp\\tdai-mcp.js';

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

const NEW_KEYS = ['codebuddy', 'workbuddy', 'opencode', 'hermes', 'openclaw', 'pi'];
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// 按缩进建树的极简 YAML 解析器（只为验证"结构归属"，不追求完整 YAML 语义）
function parseYaml(text) {
  const root = {}; const stack = [{ ind: -1, obj: root }];
  for (const l of text.split('\n')) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = l.match(/^\s*/)[0].length;
    const m = l.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    while (stack.length > 1 && stack[stack.length - 1].ind >= ind) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const key = m[1].trim(); const val = m[2].trim();
    if (val === '') { parent[key] = {}; stack.push({ ind, obj: parent[key] }); }
    else parent[key] = val.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
  }
  return root;
}

// 造一个"全部 12 客户端都装了"的隔离 home。
// 注意：probe 有时指向**目录**（如 ~/.cursor）、有时指向**文件**（如 ~/.codex/config.toml），
// 要按客户端显式声明，不能靠扩展名猜（`.codex/config.toml` 的 `.toml` 会被误判）。
// 值为 true 表示 probe 是文件（建空文件），false 表示是目录。
const PROBE_IS_FILE = {
  'zcode': false, 'claude-code': true, 'cursor': false, 'codex': true, 'trae': false,
  'deepseek-harness': false, 'codebuddy': false, 'workbuddy': false, 'opencode': false,
  'hermes': false, 'openclaw': false, 'pi': false,
};

function mkHome(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-ext-'));
  for (const p of clients.CLIENT_PATHS) {
    const abs = path.join(home, p.probe);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (PROBE_IS_FILE[p.key]) fs.writeFileSync(abs, '{}');
    else fs.mkdirSync(abs, { recursive: true });
  }
  // Claude Code 的 hook 配置文件在 ~/.claude/settings.json（probe 是 ~/.claude.json，两者不同）
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  // DeepSeek Harness 只在"已初始化的 profile"（有 cordis.patch.yml）里写，
  // 没有 profile 时**刻意跳过**（不替用户造 patch 文件）→ 造一个已初始化的 profile
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'default'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dsh', 'profiles', 'default', 'cordis.patch.yml'), '# profile\n[]\n');
  if (extra) for (const [rel2, content] of Object.entries(extra)) {
    const abs = path.join(home, rel2);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return home;
}

/* ---------- ① 全量接入：12 个客户端都写成功 ---------- */
{
  const home = mkHome();
  const res = reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  const act = (t) => (res.find((r) => r.target === t) || {}).action;
  for (const k of clients.CLIENTS) {
    chk(`① 「${k.name}」接入成功（非跳过/失败）`,
      ['新增', '覆盖', '新建', '追加'].includes(act(k.name)), `${k.key} → ${act(k.name)}`);
  }
  chk('① 无任何「失败」项', res.every((r) => r.action !== '失败'),
    JSON.stringify(res.filter((r) => r.action === '失败')));

  /* ---------- ② 各形态落到正确文件与字段 ---------- */
  const cb = rd(path.join(home, '.codebuddy', '.mcp.json'));
  chk('② CodeBuddy → mcpServers.tdai', !!(cb.mcpServers && cb.mcpServers.tdai), JSON.stringify(cb));
  const wb = rd(path.join(home, '.workbuddy-ai', 'mcp.json'));
  chk('② WorkBuddy → mcpServers.tdai', !!(wb.mcpServers && wb.mcpServers.tdai), JSON.stringify(wb));
  chk('② WorkBuddy 用 ~/.workbuddy-ai（不是 ~/.workbuddy）',
    fs.existsSync(path.join(home, '.workbuddy-ai', 'mcp.json')), '');
  const ocl = rd(path.join(home, '.openclaw', 'openclaw.json'));
  chk('② OpenClaw → mcp.servers.tdai', !!(ocl.mcp && ocl.mcp.servers && ocl.mcp.servers.tdai), JSON.stringify(ocl));
  const pi = rd(path.join(home, '.pi', 'agent', 'mcp.json'));
  chk('② Pi → ~/.pi/agent/mcp.json 的 mcpServers.tdai', !!(pi.mcpServers && pi.mcpServers.tdai), JSON.stringify(pi));

  // OpenCode 的三条独有约定
  const oc = rd(path.join(home, '.config', 'opencode', 'opencode.json'));
  chk('② OpenCode → mcp.tdai（不是 mcpServers）', !!(oc.mcp && oc.mcp.tdai) && !oc.mcpServers, JSON.stringify(oc));
  chk('② OpenCode type = local', oc.mcp.tdai.type === 'local', String(oc.mcp.tdai.type));
  chk('② OpenCode command 是数组且 [0] = exe',
    Array.isArray(oc.mcp.tdai.command) && oc.mcp.tdai.command[0] === EXE, JSON.stringify(oc.mcp.tdai.command));
  chk('② OpenCode command 数组含 mcp 脚本', oc.mcp.tdai.command.includes(MCPJS), JSON.stringify(oc.mcp.tdai.command));

  // Hermes 的 YAML 形态
  const hy = fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8');
  const hTree = parseYaml(hy);
  chk('② Hermes → mcp_servers.tdai（YAML 结构正确）',
    !!(hTree.mcp_servers && hTree.mcp_servers.tdai), JSON.stringify(Object.keys(hTree)));
  chk('② Hermes command 带引号（Windows 路径需转义）', /command:\s*"/.test(hy), hy);

  /* ---------- ③ 幂等：再跑一次全跳过 ---------- */
  const res2 = reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  chk('③ 二次运行全部跳过（幂等）',
    res2.every((r) => r.action === '跳过'),
    JSON.stringify(res2.filter((r) => r.action !== '跳过')));
  chk('③ 二次运行未重复写入 tdai（各文件仅 1 处）',
    (fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8').match(/^\s{2}tdai:/gm) || []).length === 1, '');

  /* ---------- ④ status() 能认出"本应用接入" ---------- */
  const st = reg.status({ home, exePath: EXE });
  for (const k of NEW_KEYS) {
    const it = st.find((x) => x.key === k) || {};
    chk(`④ status(${k}) = installed`, it.status === 'installed', JSON.stringify(it));
    chk(`④ status(${k}).byApp = true（认出是本应用写的）`, it.byApp === true, JSON.stringify(it));
  }
  chk('④ status 条目数 = 12 客户端 + 1 指令文件',
    st.length === clients.CLIENTS.length + 1, `len=${st.length}`);

  /* ---------- ⑤ 断开往返 ---------- */
  for (const k of NEW_KEYS) reg.unregisterOneClient(k, { home });
  const st2 = reg.status({ home, exePath: EXE });
  for (const k of NEW_KEYS) {
    const it = st2.find((x) => x.key === k) || {};
    chk(`⑤ 断开后 status(${k}) = missing（客户端仍在）`, it.status === 'missing', JSON.stringify(it));
  }
  chk('⑤ OpenCode 断开后 mcp 里无 tdai',
    !(rd(path.join(home, '.config', 'opencode', 'opencode.json')).mcp || {}).tdai, '');
  chk('⑤ Hermes 断开后无 tdai 子块',
    !/^\s{2}tdai:/m.test(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8')), '');
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑥ Hermes：主配置已有其它顶层键时，tdai 必须落在 mcp_servers 下 ----------
 * 这是本套件最重要的一条回归：追加到文件末尾会让 `  tdai:` 被 YAML 解析成
 * **最后一个顶层键**的子键（实测挂到 tts.tdai）→ MCP 服务器静默读不到。
 */
{
  const home = mkHome({
    '.hermes/config.yaml': [
      'model: claude',
      'mcp_servers:',
      '  other:',
      '    command: "npx"',
      'tts:',
      '  enabled: true',
      '',
    ].join('\n'),
  });
  reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  const t = parseYaml(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8'));
  chk('⑥ tdai 落在 mcp_servers 下（不是 tts 下）',
    !!(t.mcp_servers && t.mcp_servers.tdai), JSON.stringify(t));
  chk('⑥ tts 未被污染（无 tts.tdai）', !(t.tts && t.tts.tdai), JSON.stringify(t.tts));
  chk('⑥ 已有的 other 服务器保留', !!(t.mcp_servers && t.mcp_servers.other), JSON.stringify(t.mcp_servers));
  chk('⑥ model 等其它顶层键保留', t.model === 'claude', String(t.model));
  reg.unregisterOneClient('hermes', { home });
  const t2 = parseYaml(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8'));
  chk('⑥ 断开后 other 仍在（同级判定正确）', !!(t2.mcp_servers && t2.mcp_servers.other), JSON.stringify(t2.mcp_servers));
  chk('⑥ 断开后 tts / model 没被吞掉', t2.tts && t2.tts.enabled === 'true' && t2.model === 'claude', JSON.stringify(t2));
  chk('⑥ 断开后 tdai 已移除', !(t2.mcp_servers && t2.mcp_servers.tdai), '');
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑦ Hermes：没有 mcp_servers 顶层键时新建一个 ---------- */
{
  const home = mkHome({ '.hermes/config.yaml': 'tts:\n  enabled: true\n' });
  reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  const raw = fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8');
  const t = parseYaml(raw);
  chk('⑦ 新开 mcp_servers 顶层键', !!(t.mcp_servers && t.mcp_servers.tdai), JSON.stringify(t));
  chk('⑦ 只出现一次 mcp_servers:', (raw.match(/^mcp_servers:/gm) || []).length === 1, raw);
  chk('⑦ 原有 tts 保留', t.tts && t.tts.enabled === 'true', JSON.stringify(t.tts));
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑧ Hermes：配置文件不存在（装了但没跑过）→ 新建 ---------- */
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-ext2-'));
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });   // 只有目录，无 config.yaml
  const res = reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  const act = (res.find((r) => r.target === 'Hermes') || {}).action;
  chk('⑧ Hermes 配置文件不存在时被创建', fs.existsSync(path.join(home, '.hermes', 'config.yaml')), '');
  chk('⑧ action = 新建（不是跳过）', act === '新建', String(act));
  const t = parseYaml(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8'));
  chk('⑧ 结构为 mcp_servers.tdai', !!(t.mcp_servers && t.mcp_servers.tdai), JSON.stringify(t));
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑨ OpenCode：已有 $schema 与其它服务器时不破坏 ---------- */
{
  const home = mkHome({
    '.config/opencode/opencode.json': JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { other: { type: 'local', command: ['npx', 'x'] } },
    }),
  });
  reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  const o = rd(path.join(home, '.config', 'opencode', 'opencode.json'));
  chk('⑨ $schema 保留', o.$schema === 'https://opencode.ai/config.json', JSON.stringify(o.$schema));
  chk('⑨ 其它 mcp 服务器保留', !!o.mcp.other, JSON.stringify(o.mcp));
  chk('⑨ tdai 已加入', !!o.mcp.tdai, JSON.stringify(o.mcp));
  reg.unregisterOneClient('opencode', { home });
  const o2 = rd(path.join(home, '.config', 'opencode', 'opencode.json'));
  chk('⑨ 断开后 other 仍在其一', !!o2.mcp.other && !o2.mcp.tdai, JSON.stringify(o2));
  fs.rmSync(home, { recursive: true, force: true });
}

/* ---------- ⑩ daemon 的检测口径与写入侧一致（真跑 daemon.agentStatus） ---------- */
{
  const home = mkHome();
  reg.register({ home, exePath: EXE, mcpJs: MCPJS });
  // daemon 用真实 os.homedir()，这里只能验证"形态与种类都认识"：
  // 静态部分（名称覆盖 / 条目数）已由 clients-consistency ⑨ 覆盖，
  // 本处补一条：daemon 的 mcpInstalled 支持新 kind（不因未知 kind 抛错）。
  const dmod = require(path.join(ROOT, 'daemon', 'tdai-daemon.js'));
  let threw = null;
  try { dmod.agentStatus(); } catch (e) { threw = e.message; }
  chk('⑩ daemon.agentStatus() 对含新 kind 的清单不抛错', threw === null, String(threw));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n---------- 扩充客户端读写往返验证：通过 ${ok.length} / 失败 ${bad.length} ----------`);
ok.forEach((x) => console.log('  ✓ ' + x));
if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
process.exit(0);
