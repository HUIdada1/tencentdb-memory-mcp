// test/docs-consistency.test.js — 文档与代码一致性
//
// 为什么需要：
//   文档漂移比代码 bug 更隐蔽 —— 用户按文档做却失败，最后来提 Issue 抱怨的是"装不上"。
//   本项目已踩过：README 文首写"纯 Node ≥16"、文末写"推荐 Node ≥18"，
//   而会话扫描实际需要 ≥22.16（低版本静默降级成只扫归档目录）。
//   本测试把"文档里的事实性声明"与"代码里的真值"钉在一起。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// ⚠️ 必须归一化 CRLF：`.` 在无 s 标志时**不匹配行分隔符**（\n \r），
// 中文 Markdown 里常出现"前半句在一行、后半句在下一行"的表述，
// 用 /A.*B/.test(text) 会静默返回 false —— 断言写错了却看起来像文档缺失。
const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

const README = read('README.md');
const INSTALL = read('INSTALL.md');
const CONTRIB = read('CONTRIBUTING.md');
const CHANGELOG = read('CHANGELOG.md');
const DAEMON = read('daemon/tdai-daemon.js');
const CORE = read('core/tdai-core.js');
const REG_ALL = read('register-all.cjs');
const clients = require(path.join(ROOT, 'core', 'clients.js'));

/* ---------- ① 必备文档存在且被互相引用 ---------- */
{
  const must = ['README.md', 'INSTALL.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE'];
  for (const f of must) {
    chk(`① ${f} 存在`, fs.existsSync(path.join(ROOT, f)), '缺失');
  }
  chk('① README 链接到 INSTALL', /\[[^\]]*INSTALL\.md[^\]]*\]\(INSTALL\.md\)/.test(README));
  chk('① README 链接到 CONTRIBUTING', /\[[^\]]*CONTRIBUTING\.md[^\]]*\]\(CONTRIBUTING\.md\)/.test(README));
  chk('① README 链接到 CHANGELOG', /\[[^\]]*CHANGELOG\.md[^\]]*\]\(CHANGELOG\.md\)/.test(README));
  chk('① README 链接到 LICENSE', /\]\(LICENSE\)/.test(README));
  chk('① CONTRIBUTING 链接到 LICENSE', /\]\(LICENSE\)/.test(CONTRIB));
  chk('① INSTALL 回链到 CONTRIBUTING', /\[[^\]]*CONTRIBUTING\.md[^\]]*\]\(CONTRIBUTING\.md\)/.test(INSTALL));
}

/* ---------- ② Node 版本口径：三份文档一致且与 engines 一致 ---------- */
{
  const rootPkg = JSON.parse(read('package.json'));
  const petPkg = JSON.parse(read('pet/package.json'));
  const MIN_APP = petPkg.engines.node.match(/(\d+\.\d+\.\d+)/)[1];
  const MIN_CLI = rootPkg.engines.node.match(/(\d+\.\d+\.\d+)/)[1];

  chk(`② README 提及桌面端最低版本 ${MIN_APP}`, README.includes(MIN_APP));
  chk(`② INSTALL 提及桌面端最低版本 ${MIN_APP}`, INSTALL.includes(MIN_APP));
  chk(`② CONTRIBUTING 提及桌面端最低版本 ${MIN_APP}`, CONTRIB.includes(MIN_APP));
  chk(`② INSTALL 提及 CLI 侧最低版本 ${MIN_CLI}`, INSTALL.includes(MIN_CLI));
  // 旧的矛盾口径不得回归
  chk('② README 不再有"推荐 Node ≥18"（与 sqlite 门槛矛盾）', !/推荐 Node ≥18/.test(README));
  chk('② README 不再声称统一"纯 Node ≥16"',
    !/纯 Node ≥16/.test(README), '仍写着纯 Node ≥16');
  // 必须解释"为什么"（不能只给数字）
  chk('② README 说明了 sqlite 是桌面端的版本门槛原因',
    /node:sqlite/.test(README) && /静默降级/.test(README));
  chk('② INSTALL 说明了降级后果与自查方式',
    /node:sqlite/.test(INSTALL) && /警告横幅/.test(INSTALL));
}

/* ---------- ③ INSTALL 的配置字段与代码真值一致 ---------- */
{
  // 环境变量清单：core 里实际读的 TDAI_* 都要在 INSTALL 里有
  const envs = [...CORE.matchAll(/process\.env\.(TDAI_[A-Z_]+)/g)].map((m) => m[1]);
  const uniq = [...new Set(envs)];
  chk('③ core 确实读取 TDAI_* 环境变量', uniq.length > 0, String(uniq.length));
  for (const e of uniq) {
    chk(`③ INSTALL 列出环境变量 ${e}`, INSTALL.includes(e), '');
  }
  // 端口默认值
  const portM = DAEMON.match(/RECALL_PORT = Number\(process\.env\.TDAI_DAEMON_PORT\) \|\| (\d+)/);
  chk('③ INSTALL 的默认端口与 daemon 代码一致',
    portM && INSTALL.includes(portM[1]), portM ? portM[1] : '未匹配');
  chk('③ INSTALL 说明端口可用 TDAI_DAEMON_PORT 覆盖',
    /TDAI_DAEMON_PORT/.test(INSTALL));
}

/* ---------- ④ INSTALL 的运行时数据与采集参数与代码一致 ---------- */
{
  const qm = DAEMON.match(/QUEUE_MAX = (\d+)/);
  chk('④ INSTALL 的离线队列上限与代码一致',
    qm && INSTALL.includes(qm[1]), qm ? qm[1] : '未匹配');
  const sm = DAEMON.match(/SCAN_INTERVAL_MS = (\d+) \* 60 \* 1000/);
  chk('④ INSTALL 的采集周期与代码一致（2 分钟）',
    sm && sm[1] === '2' && /每 2 分钟/.test(INSTALL), sm ? sm[1] + ' 分钟' : '未匹配');
  const hm = DAEMON.match(/RECALL_TIMEOUT_MS = (\d+)/);
  chk('④ README 的 hook 硬超时与代码一致',
    hm && README.includes(hm[1] + 'ms'), hm ? hm[1] : '未匹配');
  // 运行时数据文件名
  for (const f of ['cursors.json', 'queue/', 'daemon.log', 'status.json', 'backfill.json']) {
    chk(`④ INSTALL 列出运行时文件 ${f}`, INSTALL.includes(f), '');
  }
  // 配置文件名
  chk('④ INSTALL 列出 ~/.zcode/tdai-mcp.json', INSTALL.includes('.zcode/tdai-mcp.json'));
  chk('④ INSTALL 列出 ~/.zcode/tdai-app.json', INSTALL.includes('.zcode/tdai-app.json'));
  chk('④ INSTALL 列出 ~/.zcode/tdai-daemon/', INSTALL.includes('.zcode/tdai-daemon/'));
}

/* ---------- ⑤ INSTALL 的采集源默认值与代码一致 ---------- */
{
  const m = DAEMON.match(/enabledSources:\s*\{([^}]+)\}/);
  const sources = m ? [...m[1].matchAll(/'?([a-z-]+)'?\s*:/g)].map((x) => x[1]) : [];
  chk('⑤ INSTALL 的默认采集源与 daemon 代码一致',
    sources.length > 0 && sources.every((s) => INSTALL.includes(s)),
    sources.join(','));
}

/* ---------- ⑥ 客户端表：文档与清单同源 ---------- */
{
  for (const c of clients.CLIENTS) {
    // 客户端显示名要在 INSTALL 的目标表里出现
    chk(`⑥ INSTALL 覆盖客户端「${c.name}」`, INSTALL.includes(c.name), '');
    // 配置文件路径的相对形态要在 INSTALL 里出现（~ 替代 home）
    const rel = c.file('/').split(/[\\/]/).filter(Boolean).join('/');
    chk(`⑥ INSTALL 列出「${c.name}」配置文件 ~/${rel}`, INSTALL.includes('~/' + rel), '~/' + rel);
  }
  // 指令文件两处都要出现
  for (const [d, n] of clients.INSTR_TARGETS) {
    chk(`⑥ INSTALL 列出指令文件 ~/${d}/${n}`, INSTALL.includes(`~/${d}/${n}`), '');
  }
}

/* ---------- ⑦ 命令行子命令与 flags 与代码一致 ---------- */
{
  for (const sub of ['serve', 'push', 'hook', 'health']) {
    chk(`⑦ daemon 子命令 ${sub} 在代码里存在`, new RegExp(`'${sub}'`).test(DAEMON), '');
    chk(`⑦ INSTALL 列出 daemon 子命令 ${sub}`,
      new RegExp(`tdai-daemon\\.exe ${sub}`).test(INSTALL) || INSTALL.includes('`' + sub + '`'),
      '');
  }
  for (const flag of ['--no-hook', '--no-instructions', '--autostart']) {
    chk(`⑦ INSTALL 列出 register-all 参数 ${flag}`, INSTALL.includes(flag), '');
    chk(`⑦ 代码里存在参数 ${flag}`, REG_ALL.includes(`'${flag}'`), '');
  }
  chk('⑦ INSTALL 说明桌面应用不需要装 Node',
    /不需要[\s\S]{0,40}Node|Node[\s\S]{0,40}不需要/.test(INSTALL), 'INSTALL 未讲清"安装包形态无需 Node"');
}

/* ---------- ⑧ CONTRIBUTING 的 scope 覆盖实际模块 ---------- */
{
  for (const s of ['core', 'daemon', 'mcp', 'pet', 'register', 'ui', 'test', 'docs', 'ci', 'deploy']) {
    chk(`⑧ CONTRIBUTING 定义 scope「${s}」`, CONTRIB.includes('`' + s + '`'), '');
  }
  chk('⑧ CONTRIBUTING 说明 Conventional Commits', /Conventional Commits/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 说明版本号四处同步', /四处同步/.test(CONTRIB) && /SERVER_VER/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 说明 daemon 必须单文件自包含', /单文件自包含/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 说明"检测面=写入面"原则', /检测面/.test(CONTRIB) && /写入面/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 拒绝 Proxy 形态改动', /反向代理/.test(CONTRIB) && /ANTHROPIC_BASE_URL/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 要求 jsdom 测试 process.exit(0)', /process\.exit\(0\)/.test(CONTRIB));
  chk('⑧ CONTRIBUTING 提示注释里的 */ 陷阱', /\*\/[\s\S]{0,30}提前闭合|提前闭合/.test(CONTRIB));
}

/* ---------- ⑨ CHANGELOG 覆盖已有 tag ---------- */
{
  const heads = [...CHANGELOG.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
  chk('⑨ CHANGELOG 含 [Unreleased]', heads.includes('Unreleased'));
  chk('⑨ CHANGELOG 含当前版本',
    heads.includes(JSON.parse(read('package.json')).version),
    '当前 ' + JSON.parse(read('package.json')).version + ' | 有 ' + heads.join(','));
  // 已知的历史 tag 都要有条目（0.1.0 ~ 0.5.8）
  const known = ['0.1.0', '0.2.0', '0.2.1', '0.2.2', '0.3.0', '0.4.0', '0.4.1',
    '0.5.0', '0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5', '0.5.6', '0.5.7', '0.5.8'];
  const missing = known.filter((v) => !heads.includes(v));
  chk('⑨ CHANGELOG 覆盖全部历史版本', missing.length === 0, missing.join(','));
  chk('⑨ CHANGELOG 用 Keep a Changelog 分类词',
    /### Added/.test(CHANGELOG) && /### Fixed/.test(CHANGELOG) && /### Changed/.test(CHANGELOG));
  chk('⑨ CHANGELOG 注明 tag 不可复用', /不可复用/.test(CHANGELOG));
}

/* ---------- ⑩ CI 会跑全部新增套件（否则等于没有） ---------- */
{
  const rootPkg = JSON.parse(read('package.json'));
  const chain = rootPkg.scripts['test:ci'] || '';
  const all = rootPkg.scripts['test:all'] || '';
  // 收集 test/ 下所有 .js 套件
  const suites = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js'));
  // 允许被别的套件覆盖（preview-verify 由 scripts 驱动等），但至少不能在两处都缺席
  const uncovered = suites.filter((f) => !chain.includes(f) && !all.includes(f));
  chk('⑩ test/ 下所有套件都进了 test:all 或 test:ci', uncovered.length === 0, uncovered.join(','));
  chk('⑩ test:ci 与 test:all 步骤数一致（CI 不弱于本地）',
    chain.split(' && ').length >= all.split(' && ').length,
    'ci=' + chain.split(' && ').length + ' all=' + all.split(' && ').length);
  chk('⑩ test:ci 额外跑 daemon health 与 mcp list 冒烟',
    chain.includes('daemon/tdai-daemon.js health') && chain.includes('mcp/tdai-mcp.js list'));
  chk('⑩ 存在 CI workflow', fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci.yml')));
  const CI = read('.github/workflows/ci.yml');
  chk('⑩ CI workflow 跑 test:ci', /npm run test:ci/.test(CI));
  chk('⑩ CI workflow 有硬编码门禁', /hygiene/.test(CI) && /AgentHub/.test(CI));
  const REL = read('.github/workflows/release.yml');
  chk('⑩ release workflow 跑 test:ci（不再只有 4 条冒烟）', /npm run test:ci/.test(REL));
  chk('⑩ release workflow 不再有裸的 node test/register.test.js 冒烟步骤',
    !/run: \|[\s\S]{0,200}node test\/register\.test\.js/.test(REL), '仍存在旧冒烟');

  /* ---------- ⑩b 测试文件命名统一为 *.test.js ----------
   * 历史上混用两种风格（functional.test.js vs metrics-smoke.js），没有强制约定
   * 就一定会再次漂移。这里把约定钉死，新增套件命名不合规会直接红。
   */
  const bad = suites.filter((f) => !/\.test\.js$/.test(f));
  chk('⑩b test/ 下所有套件统一用 *.test.js 后缀', bad.length === 0, bad.join(','));
  const allTest = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js'));
  chk('⑩b 全部套件都进 test:all', allTest.every((f) => all.includes(f)),
    allTest.filter((f) => !all.includes(f)).join(','));
  // 子目录里的辅助模块（夹具/驱动）不强制 .test.js，但不能被漏掉引用
  const con = read('CONTRIBUTING.md');
  chk('⑩b CONTRIBUTING.md 写明 *.test.js 命名约定',
    /test\.js/.test(con) && /命名/.test(con), '');
}

/* ---------- ⑪ Issue/PR 模板存在且合法 ---------- */
{
  const tplDir = path.join(ROOT, '.github', 'ISSUE_TEMPLATE');
  chk('⑪ ISSUE_TEMPLATE 目录存在', fs.existsSync(tplDir));
  const files = fs.readdirSync(tplDir);
  chk('⑪ 有 bug_report / feature_request / agent_integration',
    ['bug_report.md', 'feature_request.md', 'agent_integration.md'].every((f) => files.includes(f)),
    files.join(','));
  chk('⑪ 有 config.yml（禁用空白 Issue）', files.includes('config.yml'));
  for (const f of ['bug_report.md', 'feature_request.md', 'agent_integration.md']) {
    const t = fs.readFileSync(path.join(tplDir, f), 'utf8');
    chk(`⑪ ${f} 有 YAML frontmatter`, /^---\n[\s\S]*?\n---\n/.test(t), '');
    chk(`⑪ ${f} 声明了 name`, /^name:/m.test(t), '');
  }
  chk('⑪ 有 PR 模板',
    fs.existsSync(path.join(ROOT, '.github', 'pull_request_template.md')));
  const PR = read('.github/pull_request_template.md');
  chk('⑪ PR 模板含测试自查项', /test:ci/.test(PR));
  chk('⑪ Bug 模板提醒不要贴密钥', /userKey|密钥/.test(read('.github/ISSUE_TEMPLATE/bug_report.md')));
}

console.log('\n---------- 文档一致性验证：通过 ' + ok.length + ' / 失败 ' + bad.length + ' ----------');
ok.forEach((x) => console.log('  ✓ ' + x));
if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
process.exit(0);
