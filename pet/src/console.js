// console.js — 控制台渲染逻辑
/* global tdai */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------- 窗口控制 ---------- */
  $('#win-min').addEventListener('click', () => tdai.winMin());
  $('#win-close').addEventListener('click', () => tdai.winClose());

  /* ---------- Tab ---------- */
  $$('#tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('.page').forEach((p) => p.classList.remove('active'));
      $(`.page[data-page="${b.dataset.tab}"]`).classList.add('active');
      if (b.dataset.tab === 'update') loadUpdate();
    });
  });

  /* ---------- 主题 ---------- */
  function applyTheme(t) { document.documentElement.dataset.theme = t; }
  tdai.getConfig().then((c) => applyTheme(c.ui.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : c.ui.theme));
  tdai.on('theme', (t) => applyTheme(t));
  $('#btn-theme').addEventListener('click', async () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await tdai.setConfig({ ui: { theme: next } });
  });

  /* ---------- 健康状态 ---------- */
  function fmtHealth(h) {
    const pill = $('#health-pill');
    $('#s-status').textContent = h.ok ? '已连接' : '离线';
    $('#s-latency').textContent = h.latencyMs ? h.latencyMs + 'ms' : '—';
    pill.textContent = h.ok ? '● 在线' : '○ 离线';
    pill.className = 'pill ' + (h.ok ? 'on' : 'err');
  }
  tdai.getHealth().then(fmtHealth);
  tdai.on('health', ({ payload }) => fmtHealth(payload));

  /* ---------- 总览 ---------- */
  async function loadOverview() {
    const [assets, layers] = await Promise.all([
      tdai.toolCall('team_assets', {}),
      tdai.toolCall('memory_layers', {}),
    ]);
    if (assets.ok && assets.data) {
      const d = assets.data.data || assets.data;
      $('#s-assets').textContent = (d.skill_count ?? d.skills ?? '—') + ' 技能';
      $('#s-mem').textContent = (d.memory_count ?? d.memories ?? '—') + ' 条';
    }
    renderLayers(layers);
  }
  function renderLayers(r) {
    const box = $('#layers');
    if (!r || !r.ok) { box.innerHTML = `<div class="empty">${esc(r && (r.error || r.hint) || '未取到')}</div>`; return; }
    const d = r.data && (r.data.data || r.data);
    const items = [];
    for (const k of ['L1', 'L2', 'L3', 'l1', 'l2', 'l3']) {
      if (d && d[k]) items.push({ name: k.toUpperCase(), ...d[k] });
    }
    if (!items.length && d && typeof d === 'object') {
      box.innerHTML = `<div class="item"><pre>${esc(JSON.stringify(d, null, 2)).slice(0, 2000)}</pre></div>`;
      return;
    }
    box.innerHTML = items.map((it) => `
      <div class="item">
        <b>${esc(it.name)}</b> — ${esc(String(it.count ?? it.total ?? ''))} 条
        <div class="meta">${esc(it.updated_at || it.last_update || '')}</div>
      </div>`).join('');
  }

  /* ---------- 快速检索 ---------- */
  async function quickSearch() {
    const q = $('#qs-input').value.trim();
    if (!q) return;
    $('#qs-result').textContent = '检索中…';
    const r = await tdai.toolCall('memory_search', { query: q, top_k: 3 });
    $('#qs-result').textContent = r.ok ? JSON.stringify(r.data, null, 2).slice(0, 1500) : `错误:${r.error}\n${r.hint || ''}`;
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
  });

  function setOut(sel, txt) { $(sel).textContent = txt; }
  function pretty(r) {
    if (!r) return '(空)';
    if (!r.ok) return `✕ ${r.error}\n${r.hint || ''}`;
    return JSON.stringify(r.data, null, 2).slice(0, 8000);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------- 更新页 ---------- */
  async function loadUpdate() {
    const s = await tdai.updateGet();
    renderUpdate(s);
  }
  function renderUpdate(s) {
    $('#up-current').textContent = s.currentVersion || '—';
    const map = {
      idle: '空闲', checking: '检查中…', 'up-to-date': '已是最新',
      available: `有新版本 ${s.latestVersion}`, downloading: `下载中 ${s.percent}%`,
      downloaded: '已下载,待安装', error: '出错',
    };
    $('#up-status').textContent = map[s.status] || s.status;
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

  /* ---------- 设置弹窗 ---------- */
  const mask = $('#settings-mask');
  $('#btn-settings').addEventListener('click', async () => {
    const c = await tdai.getConfig();
    $('#set-url').value = c.panel.url || '';
    $('#set-key').value = c.panel.userKey || '';
    $('#set-team').value = c.panel.teamId || '';
    $('#set-agent').value = c.panel.agentId || '';
    $('#set-task').value = c.panel.taskId || '';
    $('#set-top').checked = !!c.pet.alwaysOnTop;
    $('#set-through').checked = !!c.pet.clickThrough;
    $('#set-opacity').value = c.pet.opacity;
    $('#set-interval').value = c.sync.intervalSec;
    $('#set-theme').value = c.ui.theme;
    $('#set-autostart').checked = !!c.system.autoStart;
    $('#set-autoupdate').checked = !!c.update.autoCheck;
    $('#set-ai-on').checked = !!c.ai.enabled;
    $('#set-ai-endpoint').value = c.ai.endpoint || '';
    $('#set-ai-key').value = c.ai.apiKey || '';
    $('#set-ai-model').value = c.ai.model || '';
    mask.classList.add('show');
  });
  $('#settings-close').addEventListener('click', () => mask.classList.remove('show'));
  $('#settings-cancel').addEventListener('click', () => mask.classList.remove('show'));
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.remove('show'); });
  $('#settings-save').addEventListener('click', async () => {
    await tdai.setConfig({
      panel: {
        url: $('#set-url').value.trim(),
        userKey: $('#set-key').value.trim(),
        teamId: $('#set-team').value.trim(),
        agentId: $('#set-agent').value.trim(),
        taskId: $('#set-task').value.trim(),
      },
      pet: {
        alwaysOnTop: $('#set-top').checked,
        clickThrough: $('#set-through').checked,
        opacity: Number($('#set-opacity').value),
      },
      sync: { intervalSec: Number($('#set-interval').value) },
      ui: { theme: $('#set-theme').value },
      system: { autoStart: $('#set-autostart').checked },
      update: { autoCheck: $('#set-autoupdate').checked },
      ai: {
        enabled: $('#set-ai-on').checked,
        endpoint: $('#set-ai-endpoint').value.trim(),
        apiKey: $('#set-ai-key').value.trim(),
        model: $('#set-ai-model').value.trim(),
      },
    });
    mask.classList.remove('show');
  });

  /* ---------- 启动 ---------- */
  loadOverview();
})();
