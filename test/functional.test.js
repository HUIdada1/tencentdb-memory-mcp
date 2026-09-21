// 功能校验：隔离临时 HOME + 进程内 mock 面板，端到端验证守护进程
// 全 Node（用 os.tmpdir() 真实 Windows 路径，避开 Git Bash /tmp 映射差异）
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO, 'daemon', 'tdai-daemon.js');
const PORT = 18100;
const MOCK_PORT = 18999;
const results = [];
function check(name, ok) { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); }

/* ---- mock 面板（进程内） ---- */
const hits = [];
let mockDown = false;
const mockLog = [];
function startMock() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mockLog.push({ path: req.url, body: body.slice(0, 2000) });
      if (mockDown) { res.destroy(); return; }
      if (req.url.includes('/chat-memory/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { items: [{ content: 'MOCK-MEM-HIT 我们之前把登录改成token校验' }], total: 1 } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, message: 'ok', data: { items: [{ name: 'mock-skill-1' }, { name: 'mock-skill-2' }], total: 2 } }));
      }
    });
  });
  return new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

(async () => {
  // 1) 搭建隔离环境
  const TH = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-fntest-'));
  const agentsDir = path.join(TH, '.zcode', 'cli', 'agents', 'sess1', 'agent1');
  const claudeDir = path.join(TH, '.claude', 'projects', 'p1');
  const queueDir = path.join(TH, '.zcode', 'tdai-daemon', 'queue');
  for (const d of [agentsDir, claudeDir, queueDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(TH, '.zcode', 'tdai-mcp.json'), JSON.stringify({ panelUrl: `http://127.0.0.1:${MOCK_PORT}`, userKey: 'sk-mem-test', teamId: 'team-t', agentId: 'agt-a' }));
  const zTranscript = path.join(agentsDir, 'transcript.jsonl');
  const cTranscript = path.join(claudeDir, 's1.jsonl');
  fs.writeFileSync(zTranscript, JSON.stringify({ event: 'turn_started', payload: { input: '上次怎么修的登录bug' } }) + '\n');
  fs.writeFileSync(cTranscript, JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我看看' } }) + '\n');

  await startMock();

  // 2) 守护进程（临时 HOME）
  const env = { ...process.env, USERPROFILE: TH, HOME: TH, TDAI_DAEMON_PORT: String(PORT) };
  const daemon = spawn(process.execPath, [DAEMON, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let dOut = '';
  daemon.stdout.on('data', (c) => (dOut += c));
  daemon.stderr.on('data', (c) => (dOut += c));

  const get = (p) => new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}${p}`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
  const post = (p) => new Promise((res, rej) => { const r = http.request(`http://127.0.0.1:${PORT}${p}`, { method: 'POST' }, (r2) => { let b = ''; r2.on('data', (c) => (b += c)); r2.on('end', () => res({ status: r2.statusCode, body: b })); }); r.on('error', rej); r.end(); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await sleep(1000);
    // 1) 健康检查
    const h = JSON.parse((await get('/health')).body);
    check('health configOk=true 且 nas=true', h.configOk === true && h.nas === true);

    // 2) recall 带意图词 → 命中 mock 记忆 + 固定块
    const rc = await get('/recall?q=' + encodeURIComponent('我们之前怎么修的登录'));
    check('recall(带意图) 注入 MOCK-MEM-HIT', rc.body.includes('MOCK-MEM-HIT'));
    check('recall 注入技能目录固定块', rc.body.includes('mock-skill-1'));

    // 3) recall 无意图词 → 不做远程 search
    const rc2 = await get('/recall?q=' + encodeURIComponent('1+1等于几'));
    check('recall(无意图) 不含远程记忆', !rc2.body.includes('MOCK-MEM-HIT'));

    // 4) 首轮 push：种子不回传（fixture 在启动前已存在）
    const importBefore = mockLog.filter((l) => l.path.includes('chat-memory/import')).length;
    const p1 = JSON.parse((await post('/push')).body);
    check('push 首轮种子不回传历史', p1.pushed === 0 && importBefore === 0);

    // 5) 增量：追加新轮次 → push 上传
    fs.appendFileSync(zTranscript, JSON.stringify({ event: 'turn_complete', payload: { response: '已用token校验修复' } }) + '\n');
    await sleep(150);
    const p2 = JSON.parse((await post('/push')).body);
    check('push 增量上传 1 批', p2.pushed === 1);
    const imps = mockLog.filter((l) => l.path.includes('chat-memory/import'));
    check('import 携带 team/agent/messages 内容', imps.length >= 1 && imps.some((l) => l.body.includes('"team_id":"team-t"') && l.body.includes('token校验')));
    check('conversation/add 触发抽取', mockLog.filter((l) => l.path.includes('skill/conversation/add')).length >= 1);

    // 6) 离线队列 + 恢复补传
    mockDown = true;
    fs.appendFileSync(zTranscript, JSON.stringify({ event: 'turn_complete', payload: { response: '离线轮次' } }) + '\n');
    await sleep(150);
    const p3 = JSON.parse((await post('/push')).body);
    check('离线时 push 不丢（入本地队列）', p3.pushed === 0 && fs.readdirSync(queueDir).length >= 1);
    mockDown = false;
    const p4 = JSON.parse((await post('/push')).body);
    check('恢复后队列补传', p4.pushed + p4.queueFlushed >= 1 && fs.readdirSync(queueDir).length === 0);

    // 7) hook 子命令
    const hookRes = await new Promise((res) => {
      const hp = spawn(process.execPath, [DAEMON, 'hook', '--q', '我们之前怎么修的登录'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let b = ''; hp.stdout.on('data', (c) => (b += c)); hp.on('close', () => res(b));
    });
    check('hook 子命令输出记忆片段', hookRes.includes('MOCK-MEM-HIT'));

    // 8) 控制台页
    const page = await get('/');
    check('控制台页 HTML 可访问', page.status === 200 && page.body.includes('TD 记忆守护') && page.body.includes('Agent 接入'));

    // 9) 配置读（脱敏）
    const cfgRes = JSON.parse((await get('/api/config')).body);
    check('config 读取并脱敏 userKey', cfgRes.panelUrl.includes('18999') && /sk-mem-\*\*\*|sk-mem-t\*\*\*/.test(cfgRes.userKeyMasked) && cfgRes.hasUserKey === true);

    // 10) 配置保存（含新字段 + 不传 userKey 不清空）
    const saveRes = await new Promise((res) => {
      const r = http.request(`http://127.0.0.1:${PORT}/api/config/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r2) => { let b = ''; r2.on('data', (c) => (b += c)); r2.on('end', () => res({ status: r2.statusCode, body: b })); });
      r.end(JSON.stringify({ teamId: 'team-updated', taskId: 'task-new' }));
    });
    const saved = JSON.parse(saveRes.body);
    check('config 保存生效且 userKey 不丢失', saved.ok && saved.config.teamId === 'team-updated' && saved.config.taskId === 'task-new' && saved.config.hasUserKey === true);

    // 11) 链接测试（mock 面板在线）
    const tc = JSON.parse((await post('/api/test-connection')).body);
    check('test-connection 返回 nas+auth', tc.nas === true && tc.auth === true && typeof tc.latencyMs === 'number');

    // 12) Agent 接入状态（隔离 HOME：客户端均未安装 → absent）
    const ags = JSON.parse((await get('/api/agents-status')).body);
    check('agents-status 返回列表', Array.isArray(ags.items) && ags.items.some((x) => x.name === 'ZCode CLI') && ags.items.every((x) => ['installed', 'missing', 'absent'].includes(x.status)));

    // 13) 更新检查（离线静默降级为 null）
    const up = JSON.parse((await get('/api/update-check')).body);
    check('update-check 当前版本 + 离线容错', typeof up.current === 'string' && /^\d+\.\d+\.\d+$/.test(up.current));
  } catch (e) {
    console.error('测试异常:', e.message, '\ndaemon 输出:', dOut);
    results.push(['无异常', false]);
  } finally {
    daemon.kill();
  }
  fs.rmSync(TH, { recursive: true, force: true });
  const failed = results.filter((r) => !r[1]);
  console.log(failed.length ? `\n功能校验失败 ${failed.length} 项` : `\n功能校验全部通过（${results.length} 项）`);
  process.exit(failed.length ? 1 : 0);
})();
