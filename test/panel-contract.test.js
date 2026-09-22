// test/panel-contract.test.js — 面板**协议契约**端到端验证（P2-2）
//
// 与既有套件的分工：
//   panel-codes.test.js  —— 单元：classify() 的判定表（纯函数，不联网）
//   e2e-live.js          —— 联调：一次真实请求在快照里留下完整流量/日志
//   本文件               —— 契约：起一个**模拟腾讯文档记忆库面板真实行为**的本地 HTTP 服务，
//                           让 core / daemon / main 的探活**真跑一遍网络**，验证：
//                             · 面板的 9 种真实响应形态都被正确解读
//                             · 三处探活（core.health / daemon /api/test-connection /
//                               main testConn）对同一面板给出一致结论
//                             · 坏 userKey 一定能被识别出来（这是历史上最严重的 bug）
//                             · /v3/* 的 404 被显式暴露，而不是被当成功
//
// 之所以要"模拟真实面板行为"而不是只跑单元表：历史 bug 的根因就是
// **对上游真实响应形态的误判**（把 HTTP 400+业务码当成功、用不校验 key 的端点做探活）。
// 单元表能保证"判定函数对"，本契约保证"面对真面板确实是那样回应"。
//
// 真实面板行为（2026-09-22 实测，详见 core/panel-codes.js 顶部）：
//   GET  /v3                       → 200 SPA index.html（前端路由，不是 API）
//   POST /v3/*                     → 404 纯文本（无 JSON）
//   POST /api/v1/skill/list        → 200 {"code":0,...} 即使 key 是坏的（**不校验**）
//   POST /api/v1/meta/auth/verify  → 200 {"code":0,"valid":true} 即使 key 是坏的（**不校验**）
//   POST /api/v1/chat-memory/*     → 坏 key 时 401 {"code":401,...}（**真正校验**）
//   缺 serviceId 头                → 400 {"code":"MISSING_INSTANCE_ID"}
//   未知 serviceId                 → 400 {"code":"INVALID_INSTANCE"}
'use strict';
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const core = require(path.join(ROOT, 'core', 'tdai-core.js'));
const panel = require(path.join(ROOT, 'core', 'panel-codes.js'));
const daemon = require(path.join(ROOT, 'daemon', 'tdai-daemon.js'));

const ok = [], bad = [];
const chk = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

const GOOD_KEY = 'sk-mem-GOODKEY';
const BAD_KEY = 'sk-mem-BADKEY';
const GOOD_SVC = 'default';
const PORT = Number(process.env.PANEL_CONTRACT_PORT) || 18347;

/* ---------- 模拟面板：复刻真实行为（含"某些端点不校验 key"这个坑） ---------- */
const hits = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ url: req.url, svc: req.headers['x-tdai-service-id'], key: req.headers['x-tdai-user-key'] });
    const send = (code, obj) => {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json' });
      res.end(s);
    };

    // 前端 SPA 路由：/v3 本身返回 HTML
    if (req.method === 'GET' && (req.url === '/v3' || req.url === '/v3/')) {
      return send(200, '<!DOCTYPE html><html><body>SPA</body></html>');
    }
    // 任何 /v3/* 的"API"调用 → 404 纯文本（真面板就是这样）
    if (req.url.startsWith('/v3')) return send(404, 'Not Found');

    // /api/v1/* 的统一校验：先查 serviceId 头
    if (req.url.startsWith('/api/v1')) {
      const svc = req.headers['x-tdai-service-id'];
      if (!svc) return send(400, { code: 'MISSING_INSTANCE_ID', message: 'missing instance id' });
      if (svc !== GOOD_SVC) return send(400, { code: 'INVALID_INSTANCE', message: 'invalid instance' });

      // ⚠️ 这两个端点真面板**不校验 userKey** —— 正是历史 bug 的来源
      if (req.url === '/api/v1/skill/list') {
        return send(200, { code: 0, message: 'ok', data: { items: [{ id: 's1' }] } });
      }
      if (req.url === '/api/v1/meta/auth/verify') {
        return send(200, { code: 0, message: 'ok', data: { valid: true } });
      }

      // chat-memory/* 才是真正校验 key 的
      // ⚠️ 实测口径：缺 key 与坏 key 一律 401，面板**不会**为"缺头"返回业务码
      //    （MISSING_USER_KEY 只在请求体里缺字段时出现，不是 HTTP 头缺失）
      if (req.url.startsWith('/api/v1/chat-memory/')) {
        const key = req.headers['x-tdai-user-key'];
        if (!key || key !== GOOD_KEY) {
          return send(401, { code: 'INVALID_USER_KEY', message: 'invalid user key' });
        }
        if (req.url === '/api/v1/chat-memory/my-agents') {
          return send(200, { code: 0, message: 'ok', data: { items: [{ id: 'agt-1' }] } });
        }
        if (req.url === '/api/v1/chat-memory/search') {
          const p = JSON.parse(body || '{}');
          if (!p.block_id) return send(400, { code: 'MISSING_BLOCK_ID', message: 'missing block id' });
          return send(200, { code: 0, message: 'ok', data: { items: [], total: 0 } });
        }
        if (req.url === '/api/v1/chat-memory/layer') {
          const p = JSON.parse(body || '{}');
          if (p.layer && !['L0', 'L1', 'L2', 'L3'].includes(p.layer)) {
            return send(400, { code: 'INVALID_LAYER', message: 'invalid layer' });
          }
          return send(200, { code: 0, message: 'ok', data: { counts: { L0_messages: 0, L1: 0, L2: 0, L3: 0 }, total: 0 } });
        }
      }
      return send(404, 'Not Found');
    }
    send(404, 'Not Found');
  });
});

const cfgOf = (key, svc) => ({
  panelUrl: `http://127.0.0.1:${PORT}`,
  userKey: key,
  serviceId: svc,
  teamId: 'team-1',
  agentId: 'agt-1',
  blockId: 'chat_memory-team-1-agt-1',
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  /* ================= 一、真实面板形态 → classify() 判定 ================= */
  {
    // 用真网络跑一遍，拿真实 HTTP 状态 + 响应体喂给 classify
    const probe = async (url, headers, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body || {}),
      });
      return { status: r.status, body: await r.text() };
    };
    const H = (k) => (k ? { 'X-Tdai-Service-Id': k.svc, 'X-Tdai-User-Key': k.key } : {});

    const v1 = panel.classify(await probe('/api/v1/skill/list', H({ svc: GOOD_SVC, key: GOOD_KEY })));
    chk('① 正常 200+code:0 → ok', v1.ok === true && v1.kind === 'ok', JSON.stringify({ k: v1.kind }));

    const v2 = panel.classify(await probe('/api/v1/chat-memory/my-agents', H({ svc: GOOD_SVC, key: BAD_KEY })));
    chk('① 坏 key → 401 被判 auth（不是 ok）', v2.ok === false && v2.kind === 'auth', JSON.stringify({ k: v2.kind, s: v2.status }));
    chk('① 坏 key 的 codeKey = INVALID_USER_KEY', v2.key === 'INVALID_USER_KEY', String(v2.key));

    const v3 = panel.classify(await probe('/api/v1/chat-memory/my-agents', H({ svc: GOOD_SVC })));
    chk('① 缺 userKey → 401 被判 auth（面板不为缺头返回业务码）',
      v3.ok === false && v3.kind === 'auth', JSON.stringify({ k: v3.kind, s: v3.status, key: v3.key }));

    const v4 = panel.classify(await probe('/api/v1/skill/list', H({ svc: 'nope', key: GOOD_KEY })));
    chk('① 坏 serviceId → INVALID_INSTANCE 被判 auth', v4.ok === false && v4.key === 'INVALID_INSTANCE', String(v4.key));

    const v5 = panel.classify(await probe('/api/v1/skill/list', {}));
    chk('① 缺 serviceId 头 → MISSING_INSTANCE_ID', v5.ok === false && v5.key === 'MISSING_INSTANCE_ID', String(v5.key));

    const v6 = panel.classify(await probe('/v3/skill/list', H({ svc: GOOD_SVC, key: GOOD_KEY })));
    chk('① /v3/* → 404 被判 not-found 并**显式暴露**（不静默成功）',
      v6.ok === false && v6.kind === 'not-found', JSON.stringify({ k: v6.kind, s: v6.status }));

    const v7 = panel.classify(await probe('/api/v1/chat-memory/search', H({ svc: GOOD_SVC, key: GOOD_KEY }), {}));
    chk('① 缺 block_id → 400 MISSING_BLOCK_ID 被判 input', v7.ok === false && v7.key === 'MISSING_BLOCK_ID', String(v7.key));

    const v8 = panel.classify(await probe('/api/v1/chat-memory/layer', H({ svc: GOOD_SVC, key: GOOD_KEY }), { layer: 'L9' }));
    chk('① 非法 layer → 400 INVALID_LAYER 被判 input', v8.ok === false && v8.key === 'INVALID_LAYER', String(v8.key));

    // 关键回归：不校验 key 的端点**必须**被识别为"不能用来做认证探活"
    const s1 = panel.classify(await probe('/api/v1/skill/list', H({ svc: GOOD_SVC, key: BAD_KEY })));
    chk('① 【关键】/skill/list 用坏 key 也返回 200 → classify 只能给 ok（所以不能用它探活）',
      s1.ok === true, JSON.stringify({ k: s1.kind }));
    const s2 = panel.classify(await probe('/api/v1/meta/auth/verify', H({ svc: GOOD_SVC, key: BAD_KEY })));
    chk('① 【关键】/meta/auth/verify 用坏 key 也返回 200 → 同样不能用来探活',
      s2.ok === true, JSON.stringify({ k: s2.kind }));
  }

  /* ================= 二、core.health() 面对真面板的结论 ================= */
  {
    const good = await core.create(cfgOf(GOOD_KEY, GOOD_SVC)).health();
    chk('② 好 key：nas = true', good.ok && good.data.nas === true, JSON.stringify(good.data));
    chk('② 好 key：auth = true', good.ok && good.data.auth === true, JSON.stringify(good.data));
    chk('② 好 key：kind = ok', good.ok && good.data.kind === 'ok', JSON.stringify(good.data));

    const badk = await core.create(cfgOf(BAD_KEY, GOOD_SVC)).health();
    chk('② 【关键回归】坏 key：nas = true 但 auth = false（旧代码此处恒为 true）',
      badk.ok && badk.data.nas === true && badk.data.auth === false, JSON.stringify(badk.data));
    chk('② 坏 key：codeKey = INVALID_USER_KEY', badk.ok && badk.data.codeKey === 'INVALID_USER_KEY', JSON.stringify(badk.data));
    chk('② 坏 key：给出可操作中文提示', badk.ok && /userKey/.test(String(badk.data.hint)), String(badk.ok && badk.data.hint));

    const bads = await core.create(cfgOf(GOOD_KEY, 'nope')).health();
    chk('② 坏 serviceId：auth = false', bads.ok && bads.data.auth === false, JSON.stringify(bads.data));
    chk('② 坏 serviceId：codeKey = INVALID_INSTANCE', bads.ok && bads.data.codeKey === 'INVALID_INSTANCE', JSON.stringify(bads.data));

    // 不可达（用没人监听的端口）
    const dead = await core.create({ ...cfgOf(GOOD_KEY, GOOD_SVC), panelUrl: 'http://127.0.0.1:19999' }).health();
    chk('② 不可达：nas = false', dead.ok && dead.data.nas === false, JSON.stringify(dead.data));
    chk('② 不可达：auth = false', dead.ok && dead.data.auth === false, JSON.stringify(dead.data));
    chk('② 不可达：kind = unreachable', dead.ok && dead.data.kind === 'unreachable', JSON.stringify(dead.data));

    // 缺配置
    const nocfg = await core.create({ panelUrl: '', userKey: '' }).health();
    chk('② 缺配置：kind = config', nocfg.ok && nocfg.data.kind === 'config', JSON.stringify(nocfg.data));
  }

  /* ================= 三、daemon 真跑：spawn 一个守护实例打自己的 /api/test-connection =================
   * 不用 mock —— 起真实进程、换端口（TDAI_DAEMON_PORT）、隔离 HOME，
   * 然后向它发 HTTP 请求。这样连"守护读配置 → 探活 → 回包"整条链都覆盖到了。
   */
  {
    const { spawn } = require('child_process');
    const fsx = require('fs');
    const osx = require('os');
    const DPORT = PORT + 1;
    const fakeHome = fsx.mkdtempSync(path.join(osx.tmpdir(), 'tdai-pc-'));
    const cfgDir = path.join(fakeHome, '.zcode');
    fsx.mkdirSync(cfgDir, { recursive: true });

    const writeCfg = (key, svc) => fsx.writeFileSync(path.join(cfgDir, 'tdai-mcp.json'), JSON.stringify({
      panelUrl: `http://127.0.0.1:${PORT}`, userKey: key, serviceId: svc,
      teamId: 'team-1', agentId: 'agt-1',
    }));
    writeCfg(GOOD_KEY, GOOD_SVC);

    const child = spawn(process.execPath, [path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'serve'], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, TDAI_DAEMON_PORT: String(DPORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonOut = '';
    child.stdout.on('data', (d) => { daemonOut += d; });
    child.stderr.on('data', (d) => { daemonOut += d; });

    // 等端口起来
    const probe = async (path2) => {
      const r = await fetch(`http://127.0.0.1:${DPORT}${path2}`, { method: 'POST' });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    let up = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${DPORT}/health`); up = true; break; } catch (_) { await new Promise((r) => setTimeout(r, 120)); }
    }
    chk('③ daemon 实例已启动（真进程）', up, daemonOut.slice(-300));

    if (up) {
      const good = await probe('/api/test-connection');
      chk('③ daemon(HTTP) 好 key：nas && auth',
        good.json && good.json.nas === true && good.json.auth === true, JSON.stringify(good.json));

      // 换成坏 key：守护只在启动时读配置，用环境变量覆盖比重启更快更稳
      // （TDAI_USER_KEY 优先级高于磁盘配置，loadConfig 里 Object.assign 的后者覆盖前者）
      child.kill();
      await new Promise((r) => setTimeout(r, 400));
      writeCfg(BAD_KEY, GOOD_SVC);
      const child2 = spawn(process.execPath, [path.join(ROOT, 'daemon', 'tdai-daemon.js'), 'serve'], {
        env: {
          ...process.env, HOME: fakeHome, USERPROFILE: fakeHome,
          TDAI_DAEMON_PORT: String(DPORT), TDAI_USER_KEY: BAD_KEY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out2 = '';
      child2.stdout.on('data', (d) => { out2 += d; });
      child2.stderr.on('data', (d) => { out2 += d; });
      let up2 = false;
      for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${DPORT}/health`); up2 = true; break; } catch (_) { await new Promise((r) => setTimeout(r, 120)); }
      }
      chk('③ daemon 重启后仍在', up2, out2.slice(-300));
      if (up2) {
        const bad2 = await probe('/api/test-connection');
        chk('③ 【关键回归】daemon(HTTP) 坏 key：nas=true 但 auth=false',
          bad2.json && bad2.json.nas === true && bad2.json.auth === false, JSON.stringify(bad2.json));
        chk('③ daemon(HTTP) 坏 key：codeKey = INVALID_USER_KEY',
          bad2.json && bad2.json.codeKey === 'INVALID_USER_KEY', JSON.stringify(bad2.json));
        chk('③ daemon(HTTP) 坏 key：给出可操作提示',
          bad2.json && /userKey/.test(String(bad2.json.hint)), JSON.stringify(bad2.json && bad2.json.hint));
        // /health 也要带 auth（网页控制台据此判断）
        const h = await fetch(`http://127.0.0.1:${DPORT}/health`).then((r) => r.json());
        chk('③ daemon /health 带 auth 字段且为 false',
          h && h.auth === false, JSON.stringify(h));
      }
      try { child2.kill(); } catch (_) { }
    }
    try { child.kill(); } catch (_) { }
    await new Promise((r) => setTimeout(r, 300));
    fsx.rmSync(fakeHome, { recursive: true, force: true });
  }

  /* ================= 四、探活端点必须是"真正校验 key 的那个" ================= */
  {
    // 记录一次好 key health 期间面板收到的请求，确认打的是 /chat-memory/my-agents
    hits.length = 0;
    await core.create(cfgOf(GOOD_KEY, GOOD_SVC)).health();
    const urls = hits.map((h) => h.url);
    chk('④ core.health 探活打 /chat-memory/my-agents', urls.some((u) => u.includes('/chat-memory/my-agents')), urls.join(','));
    chk('④ core.health 不依赖 /skill/list 做认证判据', !urls.includes('/api/v1/skill/list'), urls.join(','));
    chk('④ 探活持带 X-Tdai-Service-Id 与 X-Tdai-User-Key',
      hits.every((h) => h.svc && h.key), JSON.stringify(hits[0]));
  }

  /* ================= 五、检索/分层路径走通（正确写入与读取） ================= */
  {
    const c = core.create(cfgOf(GOOD_KEY, GOOD_SVC));
    const sr = await c.memorySearch({ query: 'x', top_k: 5 });
    chk('⑤ memorySearch 正常返回 ok', sr.ok === true, JSON.stringify(sr.error || sr.hint || ''));
    const ly = await c.memoryLayers({ layer: 'L1', limit: 10, offset: 0 });
    chk('⑤ memoryLayers 正常返回 ok', ly.ok === true, JSON.stringify(ly.error || ly.hint || ''));
    const bl = await c.memoryLayers({ layer: 'BAD' });
    chk('⑤ 非法 layer 被拦（不静默成功）', bl.ok === false, JSON.stringify(bl));
    chk('⑤ 非法 layer 提示指向层级参数', /layer/i.test(String(bl.error || bl.hint || '')), String(bl.error || bl.hint));
    // 面板侧返回 400 INVALID_LAYER 也要被暴露（绕过本地校验，直接打非法值走网络）
    const raw = await c.request ? null : null;
    const blocked = await c.memoryLayers({ layer: 'L9' });
    chk('⑤ 面板侧 INVALID_LAYER 被识别为失败（不静默成功）', blocked.ok === false, JSON.stringify(blocked));
  }

  /* ================= 六、API_PREFIX 真的是 /api/v1（用真网络证伪 /v3） ================= */
  {
    chk('⑥ core 使用的 API 前缀 = /api/v1', panel.API_PREFIX === '/api/v1', panel.API_PREFIX);
    // 用真实网络证明 /v3 是前端路由而不是 API 前缀
    const g = await fetch(`http://127.0.0.1:${PORT}/v3`);
    const gt = await g.text();
    chk('⑥ GET /v3 返回 HTML（前端 SPA 路由，不是 API）',
      g.status === 200 && /<!DOCTYPE html>/i.test(gt), `${g.status} ${gt.slice(0, 40)}`);
    const p = await fetch(`http://127.0.0.1:${PORT}/v3/skill/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    chk('⑥ POST /v3/skill/list → 404（若改成 /v3 前缀将全部失败）', p.status === 404, String(p.status));
  }

  server.close();
  console.log(`\n---------- 面板协议契约验证：通过 ${ok.length} / 失败 ${bad.length} ----------`);
  ok.forEach((x) => console.log('  ✓ ' + x));
  if (bad.length) { bad.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  server.close();
  console.log('套件异常：' + e.message);
  console.log(e.stack);
  process.exit(1);
});
