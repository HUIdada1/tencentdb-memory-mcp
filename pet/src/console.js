// console.js — 控制台渲染逻辑
/* global tdai */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmt = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 窗口控制 ---------- */
  $('#win-min').addEventListener('click', () => tdai.winMin());
  $('#win-close').addEventListener('click', () => tdai.winClose());

  /* ---------- 顶栏 tab ---------- */
  $$('#tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('.page').forEach((p) => p.classList.remove('active'));
      $(`.page[data-page="${b.dataset.tab}"]`).classList.add('active');
      const t = b.dataset.tab;
      if (t === 'home') loadOverview();
      if (t === 'settings') loadSettings(b.dataset.lastSub || 'conn');
      if (t === 'skills') actions['skill-list']();
    });
  });

  /* ---------- 设置内二级 tab（分类） ---------- */
  function switchSub(name) {
    $$('#subtabs button').forEach((x) => x.classList.toggle('active', x.dataset.sub === name));
    $$('.subpanel').forEach((p) => p.classList.toggle('active', p.dataset.sub === name));
    $('#tabs button[data-tab="settings"]').dataset.lastSub = name;
    if (name === 'agents') loadAgents();
    if (name === 'update') loadUpdate();
  }
  $$('#subtabs button').forEach((b) => b.addEventListener('click', () => switchSub(b.dataset.sub)));

  /* ---------- 主题 ---------- */
  function applyTheme(t) { document.documentElement.dataset.theme = t; }
  tdai.prefsLoad().then((p) => {
    applyTheme(p.ui.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p.ui.theme);
    $('#set-theme').value = p.ui.theme || 'dark';
    $('#set-autostart').checked = !!p.system.autoStart;
    $('#set-autoupdate').checked = !!p.update.autoCheck;
  });
  tdai.on('theme', (t) => applyTheme(t));
  $('#btn-theme').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    $('#set-theme').value = next;
    await tdai.prefsSave({ ui: { theme: next } });
  });

  /* ---------- 通用偏好（改动即保存） ---------- */
  $('#set-theme').addEventListener('change', () => tdai.prefsSave({ ui: { theme: $('#set-theme').value } }));
  $('#set-autostart').addEventListener('change', () => tdai.prefsSave({ system: { autoStart: $('#set-autostart').checked } }));
  $('#set-autoupdate').addEventListener('change', () => tdai.prefsSave({ update: { autoCheck: $('#set-autoupdate').checked } }));

  /* ---------- 健康 / 守护状态 ---------- */
  function renderHealth(h) {
    // h = { running, external, port, queueLen, health: {...} | null, latencyMs }
    const svc = h.health;
    const pill = $('#health-pill');
    if (!svc) {
      pill.textContent = '○ 守护未运行';
      pill.className = 'pill err';
      $('#s-status').textContent = '-';
    } else {
      const online = svc.nas === true;
      pill.textContent = online ? '● 已连接' : '○ 未连接';
      pill.className = 'pill ' + (online ? 'on' : 'err');
      $('#s-status').textContent = online ? '可达' : '不可达';
    }
    $('#s-latency').textContent = svc && h.latencyMs ? h.latencyMs + 'ms' : '-';
    $('#s-guard').textContent = h.running ? '运行中' : (h.external ? '外部进程' : '-');
    $('#s-queue').textContent = svc && typeof svc.queueLen === 'number' ? svc.queueLen + ' 项' : (h.running || h.external ? '0 项' : '-');
    // 运行信息
    $('#k-lastpush').textContent = fmt(svc && svc.lastPush ? localTime(svc.lastPush) : '');
    $('#k-hookcalls').textContent = fmt(svc ? svc.hookCalls : '');
    $('#k-uptime').textContent = fmt(h.startedAt ? localTime(h.startedAt) : (svc ? svc.uptimeSince && localTime(svc.uptimeSince) : ''));
    $('#k-port').textContent = svc ? `127.0.0.1:${h.port}（浏览器可打开）` : '-';
    $('#k-cfg').textContent = appInfo ? appInfo.cfgPath : '-';
  }
  function localTime(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
  }
  let appInfo = null;
  tdai.getHealth().then(renderHealth);
  tdai.on('health', renderHealth);

  /* ---------- 应用信息（关于 / 端口文案） ---------- */
  tdai.appInfo().then((info) => {
    appInfo = info;
    $('#a-ver').textContent = fmt(info.version);
    $('#a-exe').textContent = fmt(info.exePath);
    $('#a-cfg').textContent = fmt(info.cfgPath);
    const url = `http://127.0.0.1:${info.port}/`;
    const link = $('#a-console');
    link.textContent = url;
    link.addEventListener('click', (e) => { e.preventDefault(); tdai.openExternal(url); });
    $$('.port-inline').forEach((el) => { el.textContent = String(info.port); });
  });

  /* ---------- 总览：最近记忆 ---------- */
  async function loadOverview() {
    const layers = await tdai.toolCall('memory_layers', {});
    renderLayers(layers);
    await tdai.refresh();
  }
  function renderLayers(r) {
    const box = $('#layers');
    if (!r || !r.ok) { box.innerHTML = `<div class="empty">${esc((r && (r.error || r.hint)) || '未取到')}</div>`; return; }
    const d = r.data && (r.data.data || r.data);
    const items = [];
    for (const k of ['L1', 'L2', 'L3', 'l1', 'l2', 'l3']) {
      if (d && d[k]) items.push({ name: k.toUpperCase(), ...d[k] });
    }
    if (!items.length) {
      box.innerHTML = '<div class="empty">暂无分层数据（配置连接并跑一轮采集后出现）</div>';
      return;
    }
    box.innerHTML = items.map((it) => `
      <div class="item">
        <b>${esc(it.name)}</b> — ${esc(String(it.count ?? it.total ?? '-'))} 条
        <div class="meta">${esc(it.updated_at || it.last_update || '')}</div>
      </div>`).join('');
  }

  /* ---------- 快速检索 ---------- */
  async function quickSearch() {
    const q = $('#qs-input').value.trim();
    if (!q) return;
    $('#qs-result').textContent = '检索中…';
    const r = await tdai.toolCall('memory_search', { query: q, top_k: 3 });
    $('#qs-result').textContent = r.ok ? JSON.stringify(r.data, null, 2).slice(0, 1500) : `错误：${r.error}\n${r.hint || ''}`;
  }
  $('#qs-go').addEventListener('click', quickSearch);
  $('#qs-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickSearch(); });

  /* ---------- 各页动作 ---------- */
  const actions = {
    async 'memory-search'() {
      const q = $('#mem-q').value.trim(); if (!q) return;
      setOut('#mem-out', '检索中…');
      const r = await tdai.toolCall('memory_search', { query: q, top_k: Number($('#mem-topk').value) });
      setOut('#mem-out', pretty(r));
    },
    async 'memory-layers'() {
      setOut('#mem-out', '加载分层…');
      const r = await tdai.toolCall('memory_layers', {});
      setOut('#mem-out', pretty(r));
    },
    async 'skill-list'() {
      setOut('#skill-out', '加载中…');
      const r = await tdai.toolCall('skill_list', {});
      if (!r.ok) { setOut('#skill-out', pretty(r)); return; }
      const list = (r.data && (r.data.data || r.data)) || [];
      const arr = Array.isArray(list) ? list : (list.skills || list.list || []);
      $('#skill-out').innerHTML = arr.map((s) => `
        <div class="tile" data-skill="${esc(s.skill_id || s.id || s.name)}">
          <b>${esc(s.name || s.skill_id || '?')}</b>
          <span>${esc((s.description || '').slice(0, 60))}</span>
        </div>`).join('') || '<div class="empty">无技能</div>';
    },
    async 'wiki-search'() {
      const q = $('#wiki-q').value.trim(); if (!q) return;
      setOut('#wiki-out', '检索中…');
      const r = await tdai.toolCall('wiki_search', { query: q });
      setOut('#wiki-out', pretty(r));
    },
    async 'graph-search'() {
      const q = $('#graph-q').value.trim(); if (!q) return;
      setOut('#graph-out', '检索中…');
      const r = await tdai.toolCall('codegraph_search', { query: q });
      setOut('#graph-out', pretty(r));
    },
  };
  document.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act && actions[act]) actions[act]();
    if (e.target.closest('.tile')) {
      const id = e.target.closest('.tile').dataset.skill;
      tdai.toolCall('skill_get', { skill_id: id }).then((r) => setOut('#skill-out', pretty(r)));
    }
    if (act === 'reload-layers') loadOverview();
    if (act === 'reload-guard') tdai.refresh();
  });

  function setOut(sel, txt) { $(sel).textContent = txt; }
  function pretty(r) {
    if (!r) return '(空)';
    if (!r.ok) return `✕ ${r.error}\n${r.hint || ''}`;
    return JSON.stringify(r.data, null, 2).slice(0, 8000);
  }

  /* ---------- 设置：记忆库连接 ---------- */
  function banner(id, cls, text) {
    const b = document.getElementById(id);
    if (!b) { console.warn('banner 目标不存在：' + id); return; }
    b.className = 'banner show ' + cls;
    b.textContent = text;
  }
  async function loadConn() {
    const c = await tdai.connLoad();
    $('#set-url').value = c.panelUrl || '';
    $('#set-team').value = c.teamId || '';
    $('#set-agent').value = c.agentId || '';
    $('#set-task').value = c.taskId || '';
    $('#set-block').value = c.blockId || '';
    if (c.hasUserKey) $('#set-key').placeholder = `${c.userKeyMasked}（已保存，留空则不修改）`;
  }
  $('#conn-save').addEventListener('click', async function () {
    const btn = this; btn.disabled = true;
    try {
      const body = {
        panelUrl: $('#set-url').value.trim(),
        teamId: $('#set-team').value.trim(),
        agentId: $('#set-agent').value.trim(),
        taskId: $('#set-task').value.trim(),
        blockId: $('#set-block').value.trim(),
      };
      const key = $('#set-key').value.trim();
      if (key) body.userKey = key;
      const c = await tdai.connSave(body);
      $('#set-key').value = '';
      if (c.hasUserKey) $('#set-key').placeholder = `${c.userKeyMasked}（已保存，留空则不修改）`;
      banner('b-conn', 'ok', '配置已保存（原文件备份为 .bak），后台守护已按新配置重启。');
      await tdai.refresh();
    } catch (e) {
      banner('b-conn', 'err', '保存失败：' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; }
  });
  $('#conn-test').addEventListener('click', async function () {
    const btn = this; btn.disabled = true; btn.textContent = '测试中…';
    try {
      const j = await tdai.connTest();
      if (j.nas && j.auth) banner('b-conn', 'ok', `连接成功：面板可达且认证通过（${j.latencyMs}ms）。`);
      else banner('b-conn', 'err', '连接失败：' + (j.hint || '面板不可达。'));
    } catch (e) {
      banner('b-conn', 'err', '测试失败：' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; btn.textContent = '链接测试'; }
  });

  /* ---------- 设置：Agent 接入 ---------- */
  const STATUS_LABEL = { installed: '已接入', missing: '未接入', absent: '未装客户端' };
  function renderAgents(items) {
    const list = $('#agents-list');
    if (!items || !items.length) { list.innerHTML = '<div class="empty">未检测到客户端</div>'; return; }
    list.innerHTML = items.map((it) => `
      <div class="li">
        <div class="li-name">${esc(it.name)}${it.detail ? `<span class="li-detail">${esc(it.detail)}</span>` : ''}</div>
        <span class="badge ${esc(it.status)}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
      </div>`).join('');
  }
  async function loadAgents() {
    const items = await tdai.agentsStatus();
    renderAgents(items);
    const missing = items.filter((x) => x.status === 'missing').length;
    const installed = items.filter((x) => x.status === 'installed').length;
    if (missing) banner('b-agents', 'warn', `有 ${missing} 项已安装但未接入：点「一键接入」即可全部接入（幂等，不重复写）。`);
    else if (installed) banner('b-agents', 'ok', '已接入的客户端均可使用 tdai 记忆工具。');
    else banner('b-agents', 'warn', '尚未接入任何客户端：点「一键接入」写配置（未安装的客户端会自动跳过）。');
  }
  $('#agents-reload').addEventListener('click', loadAgents);
  $('#agents-register').addEventListener('click', async function () {
    const btn = this; btn.disabled = true; btn.textContent = '接入中…';
    try {
      const { results, items } = await tdai.agentsRegister();
      renderAgents(items);
      const log = $('#agents-log');
      log.style.display = 'block';
      log.textContent = results.map((r) => `[${r.action}] ${r.target} — ${r.detail}`).join('\n');
      const failed = results.filter((r) => r.action === '失败').length;
      const done = results.filter((r) => r.action === '新增' || r.action === '追加' || r.action === '覆盖').length;
      if (failed) banner('b-agents', 'err', `${done} 项已写入，${failed} 项失败（见下方明细）。`);
      else if (done) banner('b-agents', 'ok', `接入完成：${done} 项已写入。新开会话即生效；Claude Code 首次会提示「信任」hook，点一次即可。`);
      else banner('b-agents', 'ok', '接入已完成（各客户端此前均已接入，无重复写入）。');
    } catch (e) {
      banner('b-agents', 'err', '接入失败：' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; btn.textContent = '一键接入'; }
  });
  $('#open-web-console').addEventListener('click', () => {
    const port = appInfo ? appInfo.port : 8100;
    tdai.openExternal(`http://127.0.0.1:${port}/`);
  });

  /* ---------- 设置加载入口 ---------- */
  function loadSettings(sub) {
    switchSub(sub || 'conn');
    loadConn();
    loadAgents();
  }

  /* ---------- 设置：更新 ---------- */
  async function loadUpdate() {
    const s = await tdai.updateGet();
    renderUpdate(s);
  }
  function renderUpdate(s) {
    $('#up-current').textContent = fmt(s.currentVersion);
    const map = {
      idle: '空闲', checking: '检查中…', 'up-to-date': '已是最新',
      available: `有新版本 ${s.latestVersion}`, downloading: `下载中 ${s.percent}%`,
      downloaded: '已下载，待安装', error: '出错',
    };
    $('#up-status').textContent = map[s.status] || fmt(s.status);
    $('#up-progress i').style.width = (s.percent || 0) + '%';
    $('#up-message').textContent = s.message || '';
    $('#up-download').style.display = s.status === 'available' && !s.isPortable ? '' : 'none';
    $('#up-install').style.display = s.status === 'downloaded' ? '' : 'none';
    if (s.notes) { $('#up-notes').textContent = s.notes; $('#up-notes').classList.add('show'); }
    else $('#up-notes').classList.remove('show');
    if (s.isPortable && s.status === 'available') {
      $('#up-message').textContent = `便携版请前往 GitHub 手动下载 ${s.latestVersion}`;
    }
  }
  tdai.on('update:state', renderUpdate);
  $('#up-check').addEventListener('click', () => tdai.updateCheck());
  $('#up-download').addEventListener('click', () => tdai.updateDownload());
  $('#up-install').addEventListener('click', () => tdai.updateInstall());
  $('#up-open-releases').addEventListener('click', () => tdai.updateOpenReleases());

  /* ---------- 启动 ---------- */
  loadOverview();
})();
