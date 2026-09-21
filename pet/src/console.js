// console.js — 控制台渲染逻辑
/* global tdai */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = { snap: null, appInfo: null, sessTimer: null, latencyHist: [], lastLogSeq: 0, logPaused: false, scanAnchor: 0, scanInterval: 120 };

  /* ---------- 数值格式化 ---------- */
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ' + u[i];
  }
  function fmtSpeed(n) {
    n = Number(n) || 0;
    return n <= 0 ? '0 B/s' : fmtBytes(n) + '/s';
  }
  function fmtDur(ms) {
    ms = Number(ms) || 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时';
  }
  // 运行时长专用：带上秒，让"在走"这件事肉眼可见（fmtDur 在小时级只到分钟）
  function fmtUptime(ms) {
    ms = Math.max(0, Number(ms) || 0);
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    if (d > 0) return `${d} 天 ${two(h)}:${two(m)}:${two(s)}`;
    if (h > 0) return `${h}:${two(m)}:${two(s)}`;
    return `${m}:${two(s)}`;
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 5000) return '刚刚';
    if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }
  function localTime(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
  }

  // 安全地设置多类名（classList.toggle 不接受空格分隔的多类名，会抛 InvalidCharacterError）
  function setCls(el, cls) {
    if (!el) return;
    el.classList.remove('ok', 'err', 'warn', 'act', 'on');
    if (cls) String(cls).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
  }

  /* ---------- 窗口控制 ---------- */
  $('#win-min').addEventListener('click', () => tdai.winMin());
  $('#win-close').addEventListener('click', () => tdai.winClose());

  /* ---------- 顶栏 tab ---------- */
  // 本期生效的页面：home / memory / live / agent / settings
  // 技能 / Wiki / 图谱 已在 console.html 中整段注释，不在此处注册。
  const PAGE_INIT = {
    home: () => { onHomeShown(); },
    memory: () => { onMemoryShown(); },
    live: () => { onLiveShown(); },
    agent: () => { loadAgents(); refreshAgentCore(); },
    settings: () => { loadConn(); },
  };
  $$('#tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('.page').forEach((p) => p.classList.remove('active'));
      const page = $(`.page[data-page="${b.dataset.tab}"]`);
      if (page) page.classList.add('active');
      const init = PAGE_INIT[b.dataset.tab];
      if (init) init();
    });
  });

  /* ---------- 设置内二级 tab（分类） ---------- */
  function switchSub(name) {
    $$('#subtabs button').forEach((x) => x.classList.toggle('active', x.dataset.sub === name));
    $$('.subpanel').forEach((p) => p.classList.toggle('active', p.dataset.sub === name));
    const sb = $('#tabs button[data-tab="settings"]');
    if (sb) sb.dataset.lastSub = name;
    if (name === 'agents') loadAgents();
    if (name === 'update') loadUpdate();
  }
  $$('#subtabs button').forEach((b) => b.addEventListener('click', () => switchSub(b.dataset.sub)));

  /* ---------- 主题 ---------- */
  function applyTheme(t) { document.documentElement.dataset.theme = t; }
  tdai.prefsLoad().then((p) => {
    applyTheme(p.ui.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p.ui.theme);
    const st = $('#set-theme'); if (st) st.value = p.ui.theme || 'dark';
    const sa = $('#set-autostart'); if (sa) sa.checked = !!p.system.autoStart;
    const su = $('#set-autoupdate'); if (su) su.checked = !!p.update.autoCheck;
  });
  tdai.on('theme', (t) => applyTheme(t));
  $('#btn-theme').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    const st = $('#set-theme'); if (st) st.value = next;
    await tdai.prefsSave({ ui: { theme: next } });
  });

  /* ---------- 通用偏好 ---------- */
  const bindPref = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  bindPref('#set-theme', 'change', () => tdai.prefsSave({ ui: { theme: $('#set-theme').value } }));
  bindPref('#set-autostart', 'change', () => tdai.prefsSave({ system: { autoStart: $('#set-autostart').checked } }));
  bindPref('#set-autoupdate', 'change', () => tdai.prefsSave({ update: { autoCheck: $('#set-autoupdate').checked } }));

  /* ============================================================
     ① 连接体征条
     ============================================================ */
  function setLive(ok, text, sub) {
    const badge = $('#live-badge');
    if (badge) {
      badge.classList.remove('on', 'err');
      badge.classList.add(ok ? 'on' : 'err');
    }
    if (text != null) { const el = $('#live-text'); if (el) el.textContent = text; }
    if (sub != null) { const el = $('#live-sub'); if (el) el.textContent = sub; }
  }

  /* ---------- 右上角连接状态 pill ----------
   * 以前这个 pill 是纯静态 HTML（永远写死"检测中"），console.js 从未引用它。
   * 现在按「面板可达性」实时切换，并作为权威状态源同步给总览的「连接状态」卡。
   * 判定口径（三者都满足才算已连接）：
   *   ① 已配置面板地址
   *   ② 主进程报告面板未被标记为不可达（snap.panelOk !== false）
   *   ③ 至少有过一次成功的往返（latency > 0）或守护探活成功
   */
  const HEALTH = { connected: null, text: '检测中', detail: '' };

  function setHealthPill(state, text, detail) {
    const pill = $('#health-pill');
    const label = $('#health-text');
    HEALTH.connected = state === 'ok' ? true : (state === 'err' ? false : null);
    HEALTH.text = text;
    HEALTH.detail = detail || '';
    if (label) label.textContent = text;
    if (pill) {
      pill.classList.remove('on', 'err', 'off', 'wait');
      pill.classList.add(state === 'ok' ? 'on' : (state === 'err' ? 'err' : 'wait'));
      pill.title = detail || text;
    }
  }

  // 每 2s 兜底刷新一次（即使没有 metrics 推送，也不会卡在"检测中"）
  function refreshHealthPill() {
    const snap = S.snap;
    const panelUrl = (S.appInfo && S.appInfo.panelUrl) || (snap && snap.panelUrl) || '';
    if (!panelUrl) {
      setHealthPill('wait', '未配置', '尚未配置记忆库面板地址，请到「设置 → 记忆库连接」填写');
      return;
    }
    if (!snap) {
      setHealthPill('wait', '检测中', '已配置面板，等待首次心跳…');
      return;
    }
    const host = sanitizePanel(panelUrl);
    const m = snap.metrics || {};
    if (snap.panelOk === false) {
      setHealthPill('err', '连接失败', `${host} 不可达${snap.panelError ? '：' + snap.panelError : ''}`);
    } else if (m.latency > 0) {
      setHealthPill('ok', '已连接', `${host} · 延迟 ${m.latency}ms`);
    } else if (snap.daemonOk) {
      setHealthPill('ok', '已连接', `${host} · 守护在线（尚未发请求，暂无延迟）`);
    } else {
      setHealthPill('wait', '检测中', `${host} · 已配置，等待首次成功往返…`);
    }
  }

  function drawSpark() {
    const line = $('#spark-line'), fill = $('#spark-fill');
    if (!line) return;
    const hist = S.latencyHist.slice(-60);
    if (hist.length < 2) { line.setAttribute('points', ''); if (fill) fill.setAttribute('points', ''); return; }
    const max = Math.max.apply(null, hist.concat([40]));
    const W = 220, H = 44, pad = 3;
    const step = hist.length > 1 ? W / (hist.length - 1) : W;
    const pts = hist.map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (H - pad - (Math.min(v, max) / max) * (H - pad * 2)).toFixed(1);
      return x + ',' + y;
    });
    line.setAttribute('points', pts.join(' '));
    if (fill) fill.setAttribute('points', ('0,' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H));
  }

  /* ============================================================
     ② 关键指标卡
     ============================================================ */
  function renderStats(m, snap) {
    // 与右上角 pill 共用同一口径（refreshHealthPill 是权威状态源）
    const connected = HEALTH.connected;
    const st = $('#s-status');
    if (st) st.textContent = connected === true ? '在线' : (connected === false ? '离线' : '待连接');
    setCls($('#c-status'), connected === true ? 'ok' : (connected === false ? 'err' : ''));

    const se = $('#s-up'); if (se) se.textContent = fmtSpeed(m.upSpeed);
    const sd = $('#s-down'); if (sd) sd.textContent = fmtSpeed(m.downSpeed);
    setCls($('#c-up'), m.upSpeed > 0 ? 'act ok' : '');
    setCls($('#c-down'), m.downSpeed > 0 ? 'act ok' : '');

    const ss = $('#s-sess');
    if (ss) ss.textContent = String((snap.sessions || []).filter((x) => x.state === 'thinking' || x.state === 'active').length);
    const sr = $('#s-reqs'); if (sr) sr.textContent = String(m.reqTotal || 0);
    const sf = $('#s-err'); if (sf) sf.textContent = String(m.reqFailed || 0);
    // 「累计请求」「失败请求」两张卡样式一致，仅成功时点亮 ok，有失败时点亮 err
    setCls($('#c-reqs'), m.reqTotal > 0 ? 'ok' : '');
    setCls($('#c-err'), m.reqFailed > 0 ? 'err' : 'ok');
  }

  /* ============================================================
     ③ 实时会话列表
     ============================================================ */
  const ST = { thinking: '交互中', active: '交互中', idle: '空闲', stale: '休眠', err: '异常' };
  const SRC_NAME = { zcode: 'ZCode CLI', 'claude-code': 'Claude Code' };

  function renderSessions(list) {
    const box = $('#sess-list');
    if (!box) return;
    list = list || [];
    const cnt = $('#sess-count');
    if (cnt) {
      const act = list.filter((x) => x.state === 'thinking' || x.state === 'active').length;
      cnt.textContent = `共 ${list.length} 个 · 进行中 ${act}`;
    }
    if (!list.length) {
      box.innerHTML = '<div class="empty">未扫描到会话文件（与任一 Agent 对话后出现）</div>';
      return;
    }
    box.innerHTML = list.map((s) => {
      const state = ST[s.state] || s.state || '—';
      const stale = (s.state === 'stale') ? ' dim' : '';
      return `<div class="sess-row${stale}">
        <div class="sess-name">
          <b title="${esc(s.id)}">${esc(s.label || s.id)}</b>
          <span>${esc(SRC_NAME[s.source] || s.source)}</span>
        </div>
        <span class="badge-st ${esc(s.state || '')}">${esc(state)}</span>
        <span>${esc(String(s.turns || 0))} 轮</span>
        <span>${esc(fmtAgo(s.lastTs))}</span>
        <span class="sess-sum" title="${esc(s.lastNote || '')}">${esc(s.lastNote || '—')}</span>
      </div>`;
    }).join('');
  }

  async function refreshSessions(force) {
    try {
      const r = await tdai.sessionsScan({ force: !!force });
      if (r && r.ok) renderSessions(r.sessions);
    } catch (_) { /* 扫描失败不阻塞界面 */ }
  }

  /* ============================================================
     ④ 上下行流量
     ============================================================ */
  const ARC_C = 2 * Math.PI * 52;   // 与 HTML 的 stroke-dasharray 基准一致

  function setArc(id, speed, maxRef) {
    const el = document.getElementById(id);
    if (!el) return;
    const ref = Math.max(maxRef || 0, 1024);            // 至少 1KB/s 量程，避免低速抖动
    const ratio = Math.min(1, (Number(speed) || 0) / ref);
    el.style.strokeDashoffset = String((ARC_C * (1 - ratio)).toFixed(1));
  }

  function drawBars(id, series, maxRef) {
    const box = document.getElementById(id);
    if (!box) return;
    const data = (series || []).slice(-40);
    if (!data.length) { box.innerHTML = ''; return; }
    const max = Math.max(maxRef || 0, 1);
    box.innerHTML = data.map((v) => {
      const h = Math.max(2, Math.round((Math.min(v, max) / max) * 32));
      const hi = (v / max) > 0.8 ? ' class="hi"' : '';
      return `<i${hi} style="height:${h}px" title="${esc(fmtSpeed(v))}"></i>`;
    }).join('');
  }

  function renderTask(dir, task) {
    const nameEl = document.getElementById(dir + '-task-name');
    const pctEl = document.getElementById(dir + '-task-pct');
    const barEl = document.getElementById(dir + '-task-bar');
    const footEl = document.getElementById(dir + '-task-foot');
    if (!nameEl) return;
    const isUp = dir === 'up';
    if (!task) {
      nameEl.textContent = isUp ? '暂无上传任务' : '暂无下载任务';
      if (pctEl) { pctEl.textContent = '—'; }
      if (barEl) barEl.style.width = '0%';
      if (footEl) footEl.textContent = isUp ? '等待下次采集…' : '等待请求…';
      return;
    }
    nameEl.textContent = task.label || '—';
    if (task.state === 'pending') {
      if (pctEl) pctEl.textContent = '进行中';
      if (barEl) barEl.style.width = '55%';
      if (footEl) footEl.textContent = '正在传输…';
    } else if (task.state === 'done') {
      if (pctEl) pctEl.textContent = '已完成';
      if (barEl) barEl.style.width = '100%';
      if (footEl) footEl.textContent = `本次 ${fmtBytes(task.bytes)}${task.ms != null ? ' · ' + task.ms + ' ms' : ''}`;
    } else {
      const bad = task.status === 0 ? '连接失败' : 'HTTP ' + task.status;
      if (pctEl) pctEl.textContent = bad;
      if (barEl) barEl.style.width = '100%';
      if (footEl) footEl.textContent = '本次传输失败（详见实时日志）';
    }
  }

  function renderFlow(m, series) {
    // 上行
    const ut = $('#up-total'); if (ut) ut.textContent = fmtBytes(m.uploadBytes);
    const up2 = $('#up-speed'); if (up2) up2.textContent = fmtSpeed(m.upSpeed);
    const upk = $('#up-peak'); if (upk) upk.textContent = fmtSpeed(m.uploadPeak);
    const uok = $('#up-ok'); if (uok) uok.textContent = `${m.uploadCommits || 0} / ${m.uploadFails || 0}`;
    const ucm = $('#up-commits'); if (ucm) ucm.textContent = String(m.uploadCommits || 0);
    setArc('up-arc', m.upSpeed, Math.max(m.uploadPeak || 0, m.upSpeed || 0));
    renderTask('up', m.upTask);
    drawBars('up-bars', series && series.up, Math.max(m.uploadPeak || 0, m.upSpeed || 0));

    // 下行
    const dt = $('#down-total'); if (dt) dt.textContent = fmtBytes(m.downloadBytes);
    const ds = $('#down-speed'); if (ds) ds.textContent = fmtSpeed(m.downSpeed);
    const dpk = $('#down-peak'); if (dpk) dpk.textContent = fmtSpeed(m.downloadPeak);
    const dok = $('#down-ok'); if (dok) dok.textContent = `${(m.downloadRequests || 0) - (m.downloadFails || 0)} / ${m.downloadFails || 0}`;
    const dav = $('#down-avg'); if (dav) dav.textContent = (m.downloadAvgMs || 0) + ' ms';
    setArc('down-arc', m.downSpeed, Math.max(m.downloadPeak || 0, m.downSpeed || 0));
    renderTask('down', m.downTask);
    drawBars('down-bars', series && series.down, Math.max(m.downloadPeak || 0, m.downSpeed || 0));

    // 当前在传的任务名（有则覆盖标签）
    if (m.currentUp) { const e = $('#up-task-name'); if (e && (!m.upTask || m.upTask.state !== 'pending')) e.title = '当前：' + m.currentUp; }
    const note = $('#up-bytes-note');
    if (note) note.textContent = `真实 socket 计量 · 近 2s 窗口`;
  }

  /* ============================================================
     ⑤ 实时日志
     ============================================================ */
  const LV_TEXT = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERROR', flow: 'FLOW' };

  function renderLogs(logs, logSeq) {
    const box = $('#log-list');
    if (!box) return;
    logs = logs || [];
    const cnt = $('#log-count');
    if (cnt) cnt.textContent = `共 ${logs.length} 条${S.logPaused ? ' · 已暂停' : ''}`;
    if (S.logPaused) return;
    if (!logs.length) { box.innerHTML = '<div class="empty">等待日志…</div>'; return; }
    // 倒序：最新在最上
    const view = logs.slice().reverse();
    box.innerHTML = view.map((l) => `<div class="log-row" data-seq="${l.seq}">
      <span class="log-t">${esc(l.ts || '')}</span>
      <span class="log-lv ${esc(l.level || 'info')}">${esc(LV_TEXT[l.level] || String(l.level || '').toUpperCase())}</span>
      <span class="log-msg" title="${esc(l.msg || '')}">${esc(l.msg || '')}</span>
      <div class="log-detail">${esc(l.detail || '')}</div>
    </div>`).join('');
  }

  const logClear = $('#log-clear');
  if (logClear) logClear.addEventListener('click', () => {
    const box = $('#log-list');
    if (box) box.innerHTML = '<div class="empty">日志已清空（新日志仍会继续追加）</div>';
  });
  const logPause = $('#log-pause');
  if (logPause) logPause.addEventListener('click', () => {
    S.logPaused = !S.logPaused;
    logPause.textContent = S.logPaused ? '继续' : '暂停';
    if (!S.logPaused && S.snap) renderLogs(S.snap.logs, S.snap.logSeq);
  });
  // 点击行展开详情（事件委托）
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.log-row');
    if (row) row.classList.toggle('open');
  });

  /* ============================================================
     ⑥ 守护状态 / 资产
     ============================================================ */
  let daemonPinged = false;

  function renderScanCountdown() {
    const el = $('#d-nextscan');
    if (!el) return;
    if (!S.scanAnchor) { el.textContent = '—'; setCls(el, ''); return; }
    const left = Math.round((S.scanAnchor + S.scanInterval * 1000 - Date.now()) / 1000);
    if (left <= 0) { el.textContent = '即将采集…'; setCls(el, 'warn'); return; }
    const m = Math.floor(left / 60), s = left % 60;
    el.textContent = (m ? m + ' 分 ' : '') + s + ' 秒';
    setCls(el, left <= 15 ? 'warn' : '');
  }

  async function refreshDaemon(announce) {
    const r = await tdai.daemonPing().catch(() => ({ ok: false, error: 'ipc 异常' }));
    const mode = $('#d-mode');
    if (r.ok && r.payload) {
      const p = r.payload;
      if (mode) { mode.textContent = '运行中'; setCls(mode, 'ok'); }
      const since = $('#d-since'); if (since) since.textContent = p.uptimeSince ? localTime(p.uptimeSince) : '—';
      const lp = $('#d-lastpush'); if (lp) lp.textContent = p.lastPush ? fmtAgo(Date.parse(p.lastPush)) : '尚未上传';
      const q = p.queueLen || 0;
      const qe = $('#d-queue'); if (qe) { qe.textContent = q + ' 项'; setCls(qe, q > 0 ? 'warn' : 'ok'); }
      const he = $('#d-hooks'); if (he) he.textContent = String(p.hookCalls != null ? p.hookCalls : 0);
      const hv = $('#h-ver'); if (hv) hv.textContent = p.version || '—';
      const hb = $('#h-beat'); if (hb) hb.textContent = r.ms + ' ms';
      // 采集锚点：优先最近上传时间，退回进程启动时间
      const anchor = p.lastPush ? Date.parse(p.lastPush) : (p.uptimeSince ? Date.parse(p.uptimeSince) : 0);
      if (anchor) S.scanAnchor = anchor;
      renderScanCountdown();
      if (announce) pushLocal('ok', `守护探活成功 · ${r.ms}ms · 队列 ${q}`);
    } else {
      if (mode) { mode.textContent = '未运行（点「探活」重试）'; setCls(mode, 'err'); }
      const hb = $('#h-beat'); if (hb) hb.textContent = '超时';
      S.scanAnchor = 0;
      renderScanCountdown();
      if (announce) pushLocal('warn', `守护探活失败 · ${r.error || ''}（上传将停摆）`);
    }
    // 游标 + 资产
    const cs = await tdai.cursorStats().catch(() => null);
    if (cs && cs.ok) {
      const df = $('#d-files'); if (df) df.textContent = cs.count + ' 个';
      const sd = $('#s-seeded'); if (sd) sd.textContent = `${cs.seeded || 0} / ${cs.count || 0}`;
      const ss = $('#s-srcs');
      if (ss) {
        const parts = Object.entries(cs.bySource || {}).map(([k, v]) => `${SRC_NAME[k] || k} ${v}`);
        ss.textContent = parts.length ? parts.join(' · ') : '—';
      }
    }
    const port = $('#d-port');
    if (port && S.appInfo) port.textContent = `127.0.0.1:${S.appInfo.port}`;
  }

  // 渲染进程侧即时提示（写进同一日志流由主进程推送；此处仅在无法回传时兜底）
  function pushLocal(level, msg) {
    const box = $('#log-list');
    if (!box || S.logPaused) return;
    if (box.querySelector('.empty')) box.innerHTML = '';
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span class="log-t">${esc(ts)}</span>
      <span class="log-lv ${esc(level)}">${esc(LV_TEXT[level] || level.toUpperCase())}</span>
      <span class="log-msg">${esc(msg)}</span>
      <div class="log-detail">${esc(msg)}</div>`;
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 200) box.removeChild(box.lastChild);
  }

  /* ============================================================
     总览刷新主流程（由 1s 心跳推送驱动）
     ============================================================ */
  async function tick(snap) {
    if (!snap || !snap.metrics) return;
    S.snap = snap;
    const m = snap.metrics;

    const up = $('#h-uptime'); if (up) up.textContent = fmtUptime(snap.uptime);
    const hp = $('#h-panel');
    if (hp) hp.textContent = String(snap.panelUrl || '').replace(/^https?:\/\//, '') || '未配置';

    if (m.latency > 0) {
      S.latencyHist.push(m.latency);
      if (S.latencyHist.length > 120) S.latencyHist.shift();
      drawSpark();
    }
    const hl = $('#h-latency'); if (hl) hl.textContent = m.latency > 0 ? m.latency + ' ms' : '—';

    // 连接状态 pill 必须跟着心跳一起更新（它就是权威状态源）
    refreshHealthPill();

    renderStats(m, snap);
    renderFlow(m, snap.series);
    renderSessions(snap.sessions);
    renderLogs(snap.logs, snap.logSeq);
    renderLiveMeta(snap.sessions);

    setLive(
      snap.panelOk !== false,
      snap.panelOk === false ? '面板连接已中断' : '实时连接正常',
      `${sanitizePanel(snap.panelUrl)} · 面板延迟 ${m.latency || 0}ms · 链路 ${fmtSpeed(m.upSpeed)}↑ ${fmtSpeed(m.downSpeed)}↓`
    );
  }
  function sanitizePanel(u) {
    return String(u || '').replace(/^https?:\/\//, '') || '未配置面板';
  }

  function onHomeShown() {
    tdai.metricsGet().then((s) => { tick(s); }).catch(() => { })
      .then(() => refreshHealthPill());
    refreshDaemon(false);
    refreshSessions(true);
  }

  function onLiveShown() {
    refreshSessions(true);
    renderLiveMeta((S.snap && S.snap.sessions) || []);
    renderScanCountdown();
  }

  /* ---------- 实时会话页：来源统计 ---------- */
  function renderLiveMeta(list) {
    list = list || [];
    const by = (src) => list.filter((x) => x.source === src).length;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#live-zcode', by('zcode') + ' 个');
    set('#live-claude', by('claude-code') + ' 个');
    set('#live-total', String(list.length));
  }

  tdai.on('metrics', ({ payload }) => { tick(payload); });
  setInterval(() => { refreshDaemon(false); }, 15000);
  // 连接状态兜底刷新：即使 metrics 推送中断，也保证不会永远卡在"检测中"
  setInterval(refreshHealthPill, 2000);
  // 运行时长独立刷新：不依赖 metrics 推送，切页面时也不会停在旧值
  setInterval(() => {
    if (!S.snap) return;
    // 用本地时钟推进，避免推送中断导致数字冻结
    const up = $('#h-uptime');
    if (up) up.textContent = fmtUptime(S.snap.uptime + (Date.now() - S.snap.at));
  }, 1000);
  setInterval(() => {
    if ($('.page[data-page="home"]').classList.contains('active')) renderScanCountdown();
    if ($('.page[data-page="live"]').classList.contains('active')) renderScanCountdown();
  }, 1000);

  /* ============================================================
     总览：记忆库资产
     ============================================================ */
  async function loadOverview() {
    let layers = null;
    try {
      const [assets, lyr] = await Promise.all([
        tdai.toolCall('team_assets', {}),
        tdai.toolCall('memory_layers', {}),
      ]);
      layers = lyr;
      if (assets && assets.ok) {
        const d = assets.data && (assets.data.data || assets.data);
        const sa = $('#s-assets'); if (sa) sa.textContent = ((d && (d.skill_count ?? d.skills)) ?? '—') + ' 技能';
        const sm = $('#s-mem'); if (sm) sm.textContent = ((d && (d.memory_count ?? d.memories)) ?? '—') + ' 条';
      }
    } catch (_) { /* 面板不可达时静默，日志里有心跳失败记录 */ }
    renderLayers(layers);
    return layers;
  }

  function renderLayers(r) {
    const box = $('#layers');
    if (!box) return;
    if (!r || !r.ok) { box.innerHTML = `<div class="empty">${esc((r && (r.error || r.hint)) || '未取到')}</div>`; return; }
    const d = r.data && (r.data.data || r.data);
    const items = [];
    for (const k of ['L1', 'L2', 'L3', 'l1', 'l2', 'l3']) {
      if (d && d[k]) items.push(Object.assign({ name: k.toUpperCase() }, d[k]));
    }
    if (!items.length) { box.innerHTML = '<div class="empty">暂无分层数据（配置连接并跑一轮采集后出现）</div>'; return; }
    box.innerHTML = items.map((it) => `<div class="item">
      <b>${esc(it.name)}</b> — ${esc(String(it.count ?? it.total ?? '—'))} 条
      <div class="meta">${esc(it.updated_at || it.last_update || '')}</div>
    </div>`).join('');
  }

  /* 快速检索已移除：总览页不再重复提供检索入口（记忆页已有完整检索能力） */

  /* ============================================================
     记忆页（本期可用功能页之一）
     ============================================================ */
  function setOut(sel, txt) { const el = $(sel); if (el) el.textContent = txt; }
  function pretty(r) {
    if (!r) return '(空)';
    if (!r.ok) return `✕ ${r.error}\n${r.hint || ''}`;
    return JSON.stringify(r.data, null, 2).slice(0, 8000);
  }

  // 记忆页允许出现多条结果，用可读列表渲染（纯文本 JSON 太长且不好看）
  function renderMemResult(r) {
    const box = $('#mem-out');
    if (!box) return;
    if (!r || !r.ok) {
      box.innerHTML = `<div class="empty">检索失败：${esc((r && (r.error || r.hint)) || '未知错误')}</div>`;
      return;
    }
    const d = r.data && (r.data.data || r.data);

    // ① 记忆条目列表（memory_search 的典型返回）
    const list = (d && (d.list || d.results || d.items || d.memories)) || (Array.isArray(d) ? d : null);
    if (list && list.length) {
      box.innerHTML = `<div class="mem-head">共 ${list.length} 条</div>` + list.map((it) => {
        const txt = it.content || it.text || it.memory || it.value || JSON.stringify(it);
        const score = (it.score != null) ? `<span class="mem-score">${Number(it.score).toFixed(2)}</span>` : '';
        const meta = it.updated_at || it.created_at || it.source || '';
        return `<div class="mem-item">
          <div class="mem-txt">${esc(txt)}</div>
          <div class="mem-meta">${score}${meta ? `<span>${esc(String(meta))}</span>` : ''}</div>
        </div>`;
      }).join('');
      return;
    }

    // ② 分层结构（memory_layers 的典型返回，常见形态 {layers:[{name,count}]} 或 {L1:..}）
    const layers = (d && (d.layers || d.levels)) || null;
    const layerItems = [];
    if (Array.isArray(layers)) {
      layers.forEach((x) => layerItems.push({
        name: x.name || x.level || x.key || '—',
        count: x.count ?? x.total ?? x.size ?? '—',
        note: x.updated_at || x.last_update || x.desc || '',
      }));
    } else if (d && typeof d === 'object') {
      for (const k of ['L1', 'L2', 'L3', 'l1', 'l2', 'l3']) {
        if (d[k]) layerItems.push({
          name: k.toUpperCase(),
          count: d[k].count ?? d[k].total ?? d[k].size ?? '—',
          note: d[k].updated_at || d[k].last_update || '',
        });
      }
    }
    if (layerItems.length) {
      box.innerHTML = `<div class="mem-head">记忆分层结构 · 共 ${layerItems.length} 层</div>` + layerItems.map((it) => `
        <div class="mem-item">
          <div class="mem-lv"><b>${esc(String(it.name))}</b><span>${esc(String(it.count))} 条</span></div>
          ${it.note ? `<div class="mem-meta"><span>${esc(String(it.note))}</span></div>` : ''}
        </div>`).join('');
      return;
    }

    // ③ 其它形态：退回原始 JSON（保证一定能看到数据，而不是空白）
    const raw = JSON.stringify(d === undefined ? r.data : d, null, 2);
    box.innerHTML = raw
      ? `<div class="mem-head">原始返回</div><pre class="mem-raw">${esc(raw.slice(0, 8000))}</pre>`
      : '<div class="empty">返回为空（该记忆库暂无数据）</div>';
  }

  // 进入记忆页即自动加载一次分层结构，避免"页面空白"
  let memLoaded = false;
  async function onMemoryShown() {
    if (memLoaded) return;
    memLoaded = true;
    const box = $('#mem-out');
    if (box) box.innerHTML = '<div class="empty">正在加载记忆分层…</div>';
    try {
      const r = await tdai.toolCall('memory_layers', {});
      if (r && r.ok) renderMemResult(r);
      else if (box) {
        box.innerHTML = `<div class="empty">尚未取到记忆数据${r && (r.error || r.hint) ? '：' + esc(r.error || r.hint) : '（请先在「设置 → 记忆库连接」完成配置）'}</div>`;
      }
    } catch (e) {
      if (box) box.innerHTML = `<div class="empty">加载失败：${esc(e && e.message ? e.message : String(e))}</div>`;
    }
  }

  const actions = {
    async 'memory-search'() {
      const q = $('#mem-q').value.trim(); if (!q) return;
      setOut('#mem-out', '检索中…');
      const r = await tdai.toolCall('memory_search', { query: q, top_k: Number($('#mem-topk').value) });
      renderMemResult(r);
    },
    async 'memory-layers'() {
      setOut('#mem-out', '加载分层…');
      const r = await tdai.toolCall('memory_layers', {});
      renderMemResult(r);
    },
    async 'reload-layers'() { await loadOverview(); },
    async 'sess-refresh'() { await refreshSessions(true); pushLocal('info', '已手动刷新会话列表'); },
    async 'guard-ping'() { await refreshDaemon(true); },
    async 'agent-refresh'() { await loadAgents(); await refreshAgentCore(); },
    async 'agent-copy-cmd'() {
      const info = S.appInfo || {};
      const cmd = `"${info.exePath || 'TD记忆守护.exe'}" --register-agents`;
      const r = await tdai.copyText(cmd);
      const b = $('#b-agent');
      if (b) { b.className = 'banner show ' + (r && r.ok ? 'ok' : 'err'); b.textContent = (r && r.ok ? '已复制到剪贴板：' : '复制失败：') + cmd; }
    },
    async 'agent-open-console'() {
      const port = (S.appInfo && S.appInfo.port) || 8100;
      tdai.openExternal(`http://127.0.0.1:${port}/`);
    },
    // 技能 / Wiki / 图谱：本期已注释隐藏，处理函数一并移除
  };
  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (t) { const act = t.dataset.act; if (actions[act]) actions[act](); }
  });

  // 记忆页：回车即检索
  const memQ = $('#mem-q');
  if (memQ) memQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') actions['memory-search'](); });

  /* ============================================================
     应用信息
     ============================================================ */
  tdai.appInfo().then((info) => {
    S.appInfo = info;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = fmt(v); };
    set('#a-ver', info.version);
    set('#a-exe', info.exePath);
    set('#a-cfg', info.cfgPath);
    const url = `http://127.0.0.1:${info.port}/`;
    const link = $('#a-console');
    if (link) {
      link.textContent = url;
      link.addEventListener('click', (e) => { e.preventDefault(); tdai.openExternal(url); });
    }
    $$('.port-inline').forEach((el) => { el.textContent = String(info.port); });
    const dp = $('#d-port'); if (dp) dp.textContent = `127.0.0.1:${info.port}`;
    const ap = $('#ag-port'); if (ap) ap.textContent = `127.0.0.1:${info.port}`;
  });

  /* ============================================================
     Agent 接入页
     ============================================================ */
  const STATUS_LABEL = { installed: '已接入', missing: '未接入', absent: '未安装' };

  async function loadAgents() {
    let items = [];
    try { items = await tdai.agentsStatus(); } catch (_) { items = []; }
    const list = $('#agent-list');
    if (list) {
      if (!items || !items.length) list.innerHTML = '<div class="empty">未检测到客户端</div>';
      else list.innerHTML = items.map((it) => `<div class="agent-row">
        <div class="ar-name">
          <b>${esc(it.name)}</b>
          <span>${esc(it.detail || '')}</span>
        </div>
        <span class="agent-badge ${esc(it.status || '')}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
      </div>`).join('');
    }
    const installed = (items || []).filter((x) => x.status === 'installed').length;
    const total = (items || []).length;
    const ac = $('#ag-clients'); if (ac) ac.textContent = `${installed} / ${total}`;
    const b = $('#b-agent');
    if (b && items && items.length) {
      const missing = items.filter((x) => x.status === 'missing').length;
      if (missing) { b.className = 'banner show warn'; b.textContent = `有 ${missing} 项已安装但未接入：点「一键接入全部客户端」即可（幂等）。`; }
      else if (installed) { b.className = 'banner show ok'; b.textContent = `已接入 ${installed} 个客户端，可直接使用 tdai 记忆工具。`; }
      else { b.className = 'banner show warn'; b.textContent = '尚未接入任何客户端：点「一键接入全部客户端」。'; }
    }
    return items;
  }

  async function refreshAgentCore() {
    try {
      const r = await tdai.daemonPing();
      const core = $('#ag-core');
      if (core) {
        if (r.ok && r.payload) { core.textContent = '在线'; setCls(core, 'ok'); }
        else { core.textContent = '未运行'; setCls(core, 'err'); }
      }
      const hk = $('#ag-hooks');
      if (hk && r.ok && r.payload) hk.textContent = String(r.payload.hookCalls != null ? r.payload.hookCalls : 0);
    } catch (_) {
      const core = $('#ag-core'); if (core) { core.textContent = '不可用'; setCls(core, 'err'); }
    }
  }

  const agentRegBtn = $('#agent-register');
  if (agentRegBtn) agentRegBtn.addEventListener('click', async function () {
    const btn = this; btn.disabled = true; btn.textContent = '接入中…';
    try {
      const { results, items } = await tdai.agentsRegister();
      if (items) {
        const list = $('#agent-list');
        if (list) list.innerHTML = items.map((it) => `<div class="agent-row">
          <div class="ar-name"><b>${esc(it.name)}</b><span>${esc(it.detail || '')}</span></div>
          <span class="agent-badge ${esc(it.status || '')}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
        </div>`).join('');
        const ins = items.filter((x) => x.status === 'installed').length;
        const ac = $('#ag-clients'); if (ac) ac.textContent = `${ins} / ${items.length}`;
      }
      const log = $('#agent-log');
      if (log && results) { log.style.display = 'block'; log.textContent = results.map((r) => `[${r.action}] ${r.target} — ${r.detail}`).join('\n'); }
      const done = (results || []).filter((r) => ['新增', '追加', '覆盖'].includes(r.action)).length;
      const failed = (results || []).filter((r) => r.action === '失败').length;
      const b = $('#b-agent');
      if (b) {
        if (failed) { b.className = 'banner show err'; b.textContent = `${done} 项已写入，${failed} 项失败（见下方明细）。`; }
        else if (done) { b.className = 'banner show ok'; b.textContent = `接入完成：${done} 项已写入。新开会话即生效。`; }
        else { b.className = 'banner show ok'; b.textContent = '接入已完成（此前均已接入，无重复写入）。'; }
      }
      await refreshAgentCore();
    } catch (e) {
      const b = $('#b-agent');
      if (b) { b.className = 'banner show err'; b.textContent = '接入失败：' + (e && e.message ? e.message : e); }
    } finally { btn.disabled = false; btn.textContent = '一键接入全部客户端'; }
  });

  /* ============================================================
     设置：记忆库连接
     ============================================================ */
  function banner(id, cls, text) {
    const b = document.getElementById(id);
    if (!b) return;
    b.className = 'banner show ' + cls;
    b.textContent = text;
  }
  async function loadConn() {
    const c = await tdai.connLoad();
    const set = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
    set('#set-url', c.panelUrl);
    set('#set-team', c.teamId);
    set('#set-agent', c.agentId);
    set('#set-task', c.taskId);
    set('#set-block', c.blockId);
    const k = $('#set-key');
    if (k && c.hasUserKey) k.placeholder = `${c.userKeyMasked}（已保存，留空则不修改）`;
    if (c.panelUrl) S.scanInterval = S.scanInterval || 120;
  }
  const connSave = $('#conn-save');
  if (connSave) connSave.addEventListener('click', async function () {
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
  const connTest = $('#conn-test');
  if (connTest) connTest.addEventListener('click', async function () {
    const btn = this; btn.disabled = true; btn.textContent = '测试中…';
    try {
      const j = await tdai.connTest();
      if (j.nas && j.auth) banner('b-conn', 'ok', `连接成功：面板可达且认证通过（${j.latencyMs}ms）。`);
      else banner('b-conn', 'err', '连接失败：' + (j.hint || '面板不可达。'));
    } catch (e) {
      banner('b-conn', 'err', '测试失败：' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; btn.textContent = '链接测试'; }
  });

  /* ============================================================
     设置：更新
     ============================================================ */
  async function loadUpdate() {
    const s = await tdai.updateGet();
    renderUpdate(s);
  }
  function renderUpdate(s) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#up-current', fmt(s.currentVersion));
    const map = {
      idle: '空闲', checking: '检查中…', 'up-to-date': '已是最新',
      available: `有新版本 ${s.latestVersion}`, downloading: `下载中 ${s.percent}%`,
      downloaded: '已下载，待安装', error: '出错',
    };
    set('#up-status', map[s.status] || fmt(s.status));
    const pg = $('#up-progress i'); if (pg) pg.style.width = (s.percent || 0) + '%';
    set('#up-message', s.message || '');
    const dl = $('#up-download'); if (dl) dl.style.display = (s.status === 'available' && !s.isPortable) ? '' : 'none';
    const ins = $('#up-install'); if (ins) ins.style.display = s.status === 'downloaded' ? '' : 'none';
    const nt = $('#up-notes');
    if (nt) { if (s.notes) { nt.textContent = s.notes; nt.classList.add('show'); } else nt.classList.remove('show'); }
    if (s.isPortable && s.status === 'available') set('#up-message', `便携版请前往 GitHub 手动下载 ${s.latestVersion}`);
  }
  tdai.on('update:state', renderUpdate);
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('#up-check', 'click', () => tdai.updateCheck());
  on('#up-download', 'click', () => tdai.updateDownload());
  on('#up-install', 'click', () => tdai.updateInstall());
  on('#up-open-releases', 'click', () => tdai.updateOpenReleases());
  on('#open-web-console', 'click', () => {
    const port = (S.appInfo && S.appInfo.port) || 8100;
    tdai.openExternal(`http://127.0.0.1:${port}/`);
  });
  // 设置页里原有的 Agent 接入面板（与独立页共用同一套数据）
  on('#agents-register', 'click', async function () {
    const btn = this; btn.disabled = true; btn.textContent = '接入中…';
    try {
      const { results, items } = await tdai.agentsRegister();
      const list = $('#agents-list');
      if (list && items) {
        list.innerHTML = items.map((it) => `<div class="li">
          <div class="li-name">${esc(it.name)}${it.detail ? `<span class="li-detail">${esc(it.detail)}</span>` : ''}</div>
          <span class="badge ${esc(it.status)}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
        </div>`).join('');
      }
      const log = $('#agents-log');
      if (log && results) { log.style.display = 'block'; log.textContent = results.map((r) => `[${r.action}] ${r.target} — ${r.detail}`).join('\n'); }
      banner('b-agents', 'ok', `接入完成：${(results || []).length} 项结果已写入。`);
    } catch (e) {
      banner('b-agents', 'err', '接入失败：' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; btn.textContent = '一键接入'; }
  });
  on('#agents-reload', 'click', async () => {
    const items = await tdai.agentsStatus();
    const list = $('#agents-list');
    if (list) list.innerHTML = items.map((it) => `<div class="li">
      <div class="li-name">${esc(it.name)}${it.detail ? `<span class="li-detail">${esc(it.detail)}</span>` : ''}</div>
      <span class="badge ${esc(it.status)}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
    </div>`).join('');
  });

  /* ---------- 启动 ---------- */
  onHomeShown();
  loadOverview();
})();
