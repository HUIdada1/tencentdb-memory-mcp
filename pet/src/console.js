// console.js — 控制台渲染逻辑
/* global tdai */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = { snap: null, appInfo: null, sessTimer: null, latencyHist: [], lastLogSeq: 0, logPaused: false, logClearSeq: 0, scanAnchor: 0, scanInterval: 120, guardEnabled: true };

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

  /* ---------- 设置内二级 tab（分类） ----------
   * 注意：Agent 接入不在设置里 —— 它是顶栏的独立 tab（data-page="agent"）。
   * 这里曾有一份重复的"Agent 接入"子面板，已删除，避免两套入口维护两份状态。
   */
  function switchSub(name) {
    $$('#subtabs button').forEach((x) => x.classList.toggle('active', x.dataset.sub === name));
    $$('.subpanel').forEach((p) => p.classList.toggle('active', p.dataset.sub === name));
    const sb = $('#tabs button[data-tab="settings"]');
    if (sb) sb.dataset.lastSub = name;
    if (name === 'update') loadUpdate();
  }
  $$('#subtabs button').forEach((b) => b.addEventListener('click', () => switchSub(b.dataset.sub)));

  /* ---------- 主题 ---------- */
  const IC_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
  const IC_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    // 深色下显示"太阳"（点了变浅色），浅色下显示"月亮"，图标即下一步动作
    const b = $('#btn-theme');
    if (b) b.innerHTML = t === 'dark' ? IC_SUN : IC_MOON;
  }
  tdai.prefsLoad().then((p) => {
    applyTheme(p.ui.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p.ui.theme);
    const st = $('#set-theme'); if (st) st.value = p.ui.theme || 'dark';
    const sa = $('#set-autostart'); if (sa) sa.checked = !!p.system.autoStart;
    const su = $('#set-autoupdate'); if (su) su.checked = !!p.update.autoCheck;
    // 守护服务开关状态（右上角 pill 点击切换）：持久化在应用偏好里
    if (p.system && p.system.guardEnabled === false) {
      S.guardEnabled = false;
      const pill = $('#health-pill');
      if (pill) { pill.classList.remove('on', 'err', 'wait'); pill.classList.add('off'); }
      const ht = $('#health-text'); if (ht) ht.textContent = '守护已停止';
    }
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

  /* ---------- 右上角 pill = 守护服务开关 ----------
   * 点击在「开启守护 / 停止守护」之间切换，状态持久化到应用偏好（重启保持）。
   * 停止后：采集上传、本地 recall 服务（:8100）、守护探活全部暂停。
   */
  let guardToggling = false;
  async function toggleGuard() {
    if (guardToggling) return;
    guardToggling = true;
    const next = !S.guardEnabled;
    const pill = $('#health-pill');
    if (pill) pill.classList.add('wait');
    const ht = $('#health-text'); if (ht) ht.textContent = next ? '正在开启…' : '正在停止…';
    try {
      const r = await tdai.guardSet(next);
      if (r && r.ok) {
        S.guardEnabled = next;
        pushLocal(next ? 'ok' : 'warn', next ? '守护服务已开启' : '守护服务已停止');
      } else {
        pushLocal('err', '守护开关操作失败：' + ((r && r.error) || '未知错误'));
      }
    } catch (e) {
      pushLocal('err', '守护开关异常：' + ((e && e.message) || e));
    } finally {
      guardToggling = false;
      refreshHealthPill();
      refreshDaemon(false);
    }
  }
  const healthPill = $('#health-pill');
  if (healthPill) {
    healthPill.style.cursor = 'pointer';
    healthPill.addEventListener('click', toggleGuard);
  }

  // 每 2s 兜底刷新一次（即使没有 metrics 推送，也不会卡在"检测中"）
  function refreshHealthPill() {
    // 守护被手动停止：pill 固定显示"守护已停止"，不跑其它判据（避免盖住用户意图）
    if (S.guardEnabled === false) {
      setHealthPill('off', '守护已停止', '守护服务已手动停止：采集上传与本地 recall 服务暂停。点击此按钮重新开启。');
      return;
    }
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
  // 来源显示名（缺失的来源直接用原始 source 字符串，界面不会显示空白或 "undefined"）
  const SRC_NAME = { zcode: 'ZCode CLI', 'zcode-rollout': 'ZCode Rollout', 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', trae: 'Trae', 'deepseek-harness': 'DeepSeek Harness' };

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
      const file = s.file || '';
      return `<div class="sess-row${stale}" title="${esc(file)}">
        <div class="sess-name">
          <b title="${esc(s.id)}">${esc(s.label || s.id)}</b>
          <span>${esc(SRC_NAME[s.source] || srcName(s.source))}</span>
          ${file ? `<span class="sess-file">${esc(file)}</span>` : ''}
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
    if (typeof logSeq === 'number') S.lastLogSeq = logSeq;
    // 应用"清空"水位线：只展示水位线之后的新日志
    const floor = S.logClearSeq || 0;
    const view0 = floor ? logs.filter((l) => (l.seq || 0) > floor) : logs;
    const cnt = $('#log-count');
    if (cnt) cnt.textContent = `共 ${view0.length} 条${S.logPaused ? ' · 已暂停' : (floor ? ' · 已隐藏旧日志' : '')}`;
    if (S.logPaused) return;
    if (!view0.length) { box.innerHTML = '<div class="empty">等待日志…</div>'; return; }
    // 倒序：最新在最上
    const view = view0.slice().reverse();
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
    // 早先只清 DOM，下一次 1s 推送立刻恢复（"清空"是假象）。
    // 现在记录清理水位线：仅隐藏 <= 水位线的旧日志，新日志照常追加。
    S.logClearSeq = S.lastLogSeq;
    if (box) box.innerHTML = '<div class="empty">已隐藏此前的日志（新日志继续追加）</div>';
  });
  const logPause = $('#log-pause');
  if (logPause) logPause.addEventListener('click', () => {
    S.logPaused = !S.logPaused;
    logPause.textContent = S.logPaused ? '继续' : '暂停';
    if (!S.logPaused && S.snap) renderLogs(S.snap.logs, S.snap.logSeq);
  });
  // 导出日志：当前视图（应用"清空"水位线之后的全部日志）→ 保存为 .log 文件
  const logExport = $('#log-export');
  if (logExport) logExport.addEventListener('click', async () => {
    const snap = S.snap;
    const floor = S.logClearSeq || 0;
    const logs = ((snap && snap.logs) || []).filter((l) => (l.seq || 0) > floor);
    if (!logs.length) {
      logExport.textContent = '无日志';
      setTimeout(() => { logExport.textContent = '导出'; }, 1500);
      return;
    }
    const lines = logs.map((l) => `[${l.ts}] [${(LV_TEXT[l.level] || String(l.level || '')).toUpperCase()}] ${l.msg}${l.detail && l.detail !== l.msg ? '\n  ' + l.detail.split('\n').join('\n  ') : ''}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const r = await tdai.logExport(lines.join('\n\n') + '\n', `tdai-logs-${stamp}.log`);
    if (r && r.ok) {
      logExport.textContent = '已导出';
      pushLocal('ok', `实时日志已导出：${logs.length} 条 → ${r.path}`);
    } else if (r && r.canceled) {
      logExport.textContent = '已取消';
    } else {
      logExport.textContent = '导出失败';
      pushLocal('warn', '日志导出失败：' + ((r && r.error) || '未知'));
    }
    setTimeout(() => { logExport.textContent = '导出'; }, 2000);
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
    // 全流程兜底：daemonPing / cursorStats 各自有 .catch，但中间的 DOM 渲染
    // 一旦因字段缺失抛错，整个 15s 定时器就会持续抛未捕获异常。
    // 守护被手动停止时不探活：直接显示"已停止"，探活只会得到失败噪音。
    if (S.guardEnabled === false) {
      const mode = $('#d-mode');
      if (mode) { mode.textContent = '已手动停止'; setCls(mode, 'warn'); }
      const ns = $('#d-nextscan'); if (ns) { ns.textContent = '—'; setCls(ns, ''); }
      return;
    }
    try {
    const r = await tdai.daemonPing().catch(() => ({ ok: false, error: 'ipc 异常' }));
    const mode = $('#d-mode');
    if (r && r.ok && r.payload) {
      const p = r.payload;
      if (mode) { mode.textContent = '运行中'; setCls(mode, 'ok'); }
      const since = $('#d-since'); if (since) since.textContent = p.uptimeSince ? localTime(p.uptimeSince) : '—';
      const lp = $('#d-lastpush'); if (lp) lp.textContent = p.lastPush ? fmtAgo(Date.parse(p.lastPush)) : '尚未上传';
      const q = p.queueLen || 0;
      const qe = $('#d-queue'); if (qe) { qe.textContent = q + ' 项'; setCls(qe, q > 0 ? 'warn' : 'ok'); }
      const he = $('#d-hooks'); if (he) he.textContent = String(p.hookCalls != null ? p.hookCalls : 0);
      const hv = $('#h-ver'); if (hv) hv.textContent = p.version || '—';
      const hb = $('#h-beat'); if (hb) hb.textContent = r.ms + ' ms';
      // 采集锚点：优先守护自报的下轮采集时刻（持久化，重启不断档）；
      // 老版本守护没有 nextScanAt 时退回"最近上传 / 启动时间"估算。
      const anchor = p.nextScanAt ? Date.parse(p.nextScanAt) : (p.lastPush ? Date.parse(p.lastPush) + S.scanInterval * 1000 : (p.uptimeSince ? Date.parse(p.uptimeSince) : 0));
      if (anchor && !isNaN(anchor)) S.scanAnchor = anchor;
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
    } catch (e) {
      // 守护卡片渲染异常不应打断总览主流程（它跑在独立的 15s 定时器里）
      if (announce) pushLocal('warn', '守护状态刷新异常：' + ((e && e.message) || e));
    }
  }

  // 渲染进程侧即时提示（与主进程日志流共用同一个 DOM；只做"本地兜底"）
  function pushLocal(level, msg) {
    const box = $('#log-list');
    if (!box || S.logPaused) return;
    // level 必须是已知级别，否则 LV_TEXT 查不到、class 也可能被注入奇怪值
    const lv = LV_TEXT[level] ? level : 'info';
    const text = String(msg == null ? '' : msg);
    if (box.querySelector('.empty')) box.innerHTML = '';
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `<span class="log-t">${esc(ts)}</span>
      <span class="log-lv ${esc(lv)}">${esc(LV_TEXT[lv])}</span>
      <span class="log-msg">${esc(text)}</span>
      <div class="log-detail">${esc(text)}</div>`;
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

    // 延迟过期（metrics.latencyStale）时不再画入曲线，避免"幽灵延迟"
    const latFresh = m.latency > 0 && m.latencyStale !== true;
    if (latFresh) {
      S.latencyHist.push(m.latency);
      if (S.latencyHist.length > 120) S.latencyHist.shift();
      drawSpark();
    }
    const hl = $('#h-latency'); if (hl) hl.textContent = latFresh ? m.latency + ' ms' : '—';

    // 连接状态 pill 必须跟着心跳一起更新（它就是权威状态源）
    refreshHealthPill();

    renderStats(m, snap);
    renderFlow(m, snap.series);
    renderSessions(snap.sessions);
    renderLogs(snap.logs, snap.logSeq);
    renderLiveMeta(snap.sessions);

    // 与 pill 严格同口径：pill 是权威源，这里不再自己判一次，
    // 否则「pill=检测中」而横幅写「实时连接正常」会自相矛盾（早先 null 时就是如此）。
    const connected = HEALTH.connected;
    setLive(
      connected !== false,
      connected === false ? '面板连接已中断' : (connected === true ? '实时连接正常' : '等待首次往返…'),
      `${sanitizePanel(snap.panelUrl)} · 面板延迟 ${latFresh ? m.latency : 0}ms · 链路 ${fmtSpeed(m.upSpeed)}↑ ${fmtSpeed(m.downSpeed)}↓`
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

  /* ---------- 实时会话页：动态来源统计 ----------
   * 不再写死"ZCode CLI / Claude Code"：按扫描结果实际出现的 source 动态列出行，
   * 未出现的来源不出现在列表里；同时生成对应的来源说明文案。
   */
  const SRC_DESC = {
    'zcode': { name: 'ZCode CLI', dir: '~/.zcode/cli/agents/' },
    'zcode-rollout': { name: 'ZCode Rollout', dir: '~/.zcode/cli/rollout/' },
    'claude-code': { name: 'Claude Code', dir: '~/.claude/projects/' },
  };
  function srcName(src) { return (SRC_DESC[src] && SRC_DESC[src].name) || src; }

  function renderLiveMeta(list) {
    list = list || [];
    // ① 动态来源行：只列出本次扫描实际出现的来源
    const bySrc = {};
    list.forEach((x) => { const s = x.source || '未知'; bySrc[s] = (bySrc[s] || 0) + 1; });
    const box = $('#live-src-stats');
    if (box) {
      const rows = Object.entries(bySrc)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `<div class="kv"><span>${esc(srcName(s))}</span><b>${n} 个</b></div>`)
        .join('');
      const base = `<div class="kv"><span>扫描会话总数</span><b id="live-total">${list.length}</b></div>
        <div class="kv"><span>下次自动扫描</span><b id="live-nextscan">—</b></div>`;
      box.innerHTML = rows + base;
    }
    // ② 来源说明：列出实际出现的来源及其会话文件目录
    const hint = $('#live-src-hint');
    if (hint) {
      const parts = Object.keys(bySrc).map((s) => {
        const d = SRC_DESC[s];
        return d ? `${d.name}（<code>${d.dir}</code>）` : `${srcName(s)}`;
      });
      hint.innerHTML = (parts.length
        ? '当前识别到 ' + parts.join('、') + '。'
        : '尚未扫描到任何会话文件。')
        + '每 4 秒自动扫描一次。状态：交互中（15 秒内）/ 空闲（3 分钟内）/ 休眠（更久）。';
    }
  }

  // tick 是 async：早先直接 `tick(payload)` 会把内部异常变成 unhandledRejection，
  // 整块总览静默停止刷新且无任何提示。现在显式串行 + 捕获。
  let tickRunning = false;
  tdai.on('metrics', ({ payload } = {}) => {
    if (tickRunning) return;   // 上一次还没画完就丢弃这一帧（1s 一帧，丢帧无害）
    tickRunning = true;
    Promise.resolve()
      .then(() => tick(payload))
      .catch((e) => { try { pushLocal('error', '总览刷新异常：' + ((e && e.message) || e)); } catch (_) { } })
      .then(() => { tickRunning = false; });
  });
  setInterval(() => { refreshDaemon(false).catch(() => { }); }, 15000);
  // 连接状态兜底刷新：即使 metrics 推送中断，也保证不会永远卡在"检测中"
  setInterval(refreshHealthPill, 2000);
  // 速率卡独立 1s 刷新：主动向主进程取最新快照重算（主进程每秒 sample 一次），
  // 即使 metrics 推送被丢帧/窗口切走，"上传/下载速度"等速率卡也保证每秒都在动。
  let speedTimerRunning = false;
  setInterval(() => {
    if (speedTimerRunning) return;
    speedTimerRunning = true;
    tdai.metricsGet().then((snap) => {
      if (snap && snap.metrics) {
        S.snap = snap;
        renderStats(snap.metrics, snap);
        renderFlow(snap.metrics, snap.series);
      }
    }).catch(() => { }).then(() => { speedTimerRunning = false; });
  }, 1000);
  // 运行时长独立刷新：不依赖 metrics 推送，切页面时也不会停在旧值
  setInterval(() => {
    if (!S.snap) return;
    // 用本地时钟推进，避免推送中断导致数字冻结
    const up = $('#h-uptime');
    if (up) up.textContent = fmtUptime(S.snap.uptime + (Date.now() - S.snap.at));
  }, 1000);
  setInterval(() => {
    // 早先直接 $('.page[...]').classList —— 元素缺失时抛 TypeError，
    // 1s 定时器每次都炸一次（静默刷屏）。统一走 activePage() 并做空值保护。
    const cur = activePage();
    if (cur === 'home' || cur === 'live') renderScanCountdown();
  }, 1000);

  // 当前激活页面（元素缺失时返回 ''，绝不抛错）
  function activePage() {
    const p = $('.page.active');
    return (p && p.dataset && p.dataset.page) || '';
  }

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
        // 面板返回 {code,message,data:{...}}：资产字段在 data 里，先剥一层
        const d0 = assets.data && (assets.data.data || assets.data);
        const items = (d0 && d0.items) || [];
        const sa = $('#s-assets'); if (sa) sa.textContent = ((d0 && (d0.skill_count ?? d0.skills)) ?? items.length ?? '—') + ' 技能';
        // 记忆总量：面板 team-assets 常为空，真正的记忆数从分层数据来
        const total = (layers && layers.ok && (() => {
          const dl = layers.data && (layers.data.data || layers.data);
          return dl && (dl.total ?? dl.count);
        })()) || ((d0 && (d0.memory_count ?? d0.memories)) ?? '—');
        const sm = $('#s-mem'); if (sm) sm.textContent = total + ' 条';
      } else if (assets && !assets.ok) {
        // 资产查询失败时，至少把记忆总量从分层数据里补出来
        const total = (layers && layers.ok && (() => {
          const dl = layers.data && (layers.data.data || layers.data);
          return dl && (dl.total ?? dl.count);
        })()) || null;
        if (total != null) { const sm = $('#s-mem'); if (sm) sm.textContent = total + ' 条'; }
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
  //
  // 分层计数的真实形态（memory_layers 不传 layer 时）：
  //   { block_id, counts: { L0_messages: 816, L1: 392, L2: 12, L3: 1 }, total: 1221 }
  // 早先只认 d.layers / d.L1 —— 这个形态一层都匹配不上，于是整块掉进"原始返回"
  // 分支把 JSON 原样打出来（用户看到的正是这个）。现在显式认 counts。
  const LAYER_META = {
    L0_messages: { name: 'L0 · 对话原文', note: '原始对话消息，采集上传的原文层' },
    L0: { name: 'L0 · 对话原文', note: '原始对话消息，采集上传的原文层' },
    L1: { name: 'L1 · 事实记忆', note: '从对话里抽取的事实与偏好' },
    L2: { name: 'L2 · 场景记忆', note: '跨会话归纳的场景认知' },
    L3: { name: 'L3 · 人设记忆', note: '长期稳定的用户画像' },
  };
  const LAYER_ORDER = ['L0_messages', 'L0', 'L1', 'L2', 'L3'];

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

    // ② 分层计数（memory_layers 不传 layer 的返回：{ block_id, counts, total }）
    const counts = d && d.counts;
    if (counts && typeof counts === 'object') {
      const total = Number(d.total != null ? d.total : Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0));
      const seen = new Set();
      const rows = [];
      for (const k of LAYER_ORDER) {
        if (!(k in counts) || seen.has(k)) continue;
        seen.add(k);
        rows.push({ key: k, n: Number(counts[k]) || 0, meta: LAYER_META[k] || { name: k, note: '' } });
      }
      // counts 里还有没枚举到的键：一并列出，别静默丢数据
      for (const k of Object.keys(counts)) {
        if (seen.has(k)) continue;
        rows.push({ key: k, n: Number(counts[k]) || 0, meta: { name: k, note: '' } });
      }
      const maxN = Math.max(1, ...rows.map((x) => x.n));
      box.innerHTML = `
        <div class="mem-head">记忆分层结构 · 共 ${total} 条${d.block_id ? ` · 记忆块 ${esc(String(d.block_id))}` : ''}</div>
        <div class="mem-layers">${rows.map((x) => `
          <div class="mem-lrow">
            <div class="mem-lname"><b>${esc(x.meta.name)}</b>${x.meta.note ? `<span>${esc(x.meta.note)}</span>` : ''}</div>
            <div class="mem-lbar"><i style="width:${Math.round((x.n / maxN) * 100)}%"></i></div>
            <div class="mem-ln">${x.n.toLocaleString('zh-CN')} 条</div>
          </div>`).join('')}
        </div>
        <div class="mem-hint">L0 为对话原文（最大头），L1→L3 为记忆库自动蒸馏出的分层记忆，逐级递减属正常。</div>`;
      return;
    }

    // ③ 分层结构（{layers:[{name,count}]} 或 {L1:{count}} 形态）
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

    // ④ 其它形态：退回原始 JSON（保证一定能看到数据，而不是空白）
    const raw = JSON.stringify(d === undefined ? r.data : d, null, 2);
    box.innerHTML = raw && raw !== '{}'
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
    // 回传状态兜底展示（有历史任务在跑则继续轮询）
    if (typeof tdai.backfillStatus === 'function') {
      try {
        const st = await tdai.backfillStatus();
        const s = st && (st.payload || st);
        if (s) { renderBackfill(s); if (s.running) pollBackfill(); }
      } catch (_) { }
    }
  }

  /* ---------- 历史会话回传（进度展示） ---------- */
  let bfTimer = null;
  function renderBackfill(st) {
    const b = $('#b-backfill');
    if (!b || !st) return;
    if (st.running) {
      b.className = 'banner show ok';
      b.textContent = `回传中：${st.filesDone}/${st.files} 个文件 · 已上传 ${st.msgs} 条` + (st.current ? ` · 当前 ${st.current}` : '');
      return true;
    }
    if (st.doneAt) {
      const bad = st.error ? 'warn' : 'ok';
      b.className = 'banner show ' + bad;
      b.textContent = `回传完成：${st.filesDone}/${st.total || st.files} 个文件 · 共 ${st.msgs} 条已上传入队` +
        (st.error ? `（告警：${st.error}）` : '') + '。蒸馏由记忆库自动进行，L1 一般 15–20 分钟内出现。';
      return false;
    }
    if (st.backfilledFiles) {
      b.className = 'banner show ok';
      b.textContent = `此前已回传 ${st.backfilledFiles} 个文件，无需重复操作；记忆库会自动蒸馏。`;
    }
    return false;
  }
  function pollBackfill() {
    if (bfTimer || typeof tdai.backfillStatus !== 'function') return;
    bfTimer = setInterval(async () => {
      try {
        const r = await tdai.backfillStatus();
        const st = r && (r.payload || r);
        if (!st) return;
        const still = renderBackfill(st);
        if (!still) { clearInterval(bfTimer); bfTimer = null; }
      } catch (_) { /* 守护短暂离线时保持轮询 */ }
    }, 2000);
  }

  /* ---------- 历史会话回传：弹窗（按 agent 选择 / 全部上传） ----------
   * 「一键上传本地记忆」不再直接开跑，而是先打开弹窗让用户看清有哪些内容、
   * 可以只传某个 agent，也可以一键全传。选中的 agent key 走 targets 参数。
   */
  const UP = { inv: null, sel: new Set(), busy: false, timer: null };

  const IC_CHK = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L19.5 7"/></svg>';

  const SRC_LABEL = {
    'zcode': 'ZCode 会话库', 'zcode-db': 'ZCode 会话库',
    'zcode-rollout': 'ZCode Rollout', 'claude-code': 'Claude Code',
  };

  function upEl(id) { return document.getElementById(id); }

  function openUpModal() {
    const m = upEl('upm-modal');
    if (!m) return;
    m.hidden = false;
    UP.sel = new Set();
    loadInventory();
  }
  function closeUpModal() {
    const m = upEl('upm-modal');
    if (m) m.hidden = true;
  }

  // 文件名过长会撑破行：目录取尾两段显示
  function shortDir(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const parts = s.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return s;
    return '…/' + parts.slice(-2).join('/');
  }

  async function loadInventory() {
    const list = upEl('upm-list');
    const lead = upEl('upm-lead');
    if (list) list.innerHTML = '<div class="empty">正在扫描本地会话…</div>';
    if (lead) lead.textContent = '正在读取本地可上传内容…';
    if (typeof tdai.backfillInventory !== 'function') {
      if (list) list.innerHTML = '<div class="empty">应用版本过旧，请升级后重试</div>';
      return;
    }
    let inv = null;
    try { inv = await tdai.backfillInventory(); } catch (e) { inv = { ok: false, error: (e && e.message) || String(e) }; }
    if (!inv || !inv.ok) {
      if (list) list.innerHTML = `<div class="empty">读取失败：${esc((inv && inv.error) || '未知错误')}</div>`;
      if (lead) lead.textContent = '';
      return;
    }
    UP.inv = inv;
    renderInventory();
  }

  function renderInventory() {
    const inv = UP.inv || { items: [], total: {} };
    const items = inv.items || [];
    const list = upEl('upm-list');
    const lead = upEl('upm-lead');
    const t = inv.total || {};
    if (lead) {
      lead.innerHTML = `本地共扫描到 <b>${t.groups || 0}</b> 个 agent / 项目、` +
        `<b>${t.items || 0}</b> 个会话、约 <b>${(t.msgs || 0).toLocaleString('zh-CN')}</b> 条消息。` +
        `其中 <b>${t.pending || 0}</b> 个尚未上传。勾选后可只上传指定 agent。`;
    }
    if (!items.length) {
      if (list) list.innerHTML = '<div class="empty">未扫描到可上传的会话内容</div>';
      updateUpFooter();
      return;
    }
    if (list) {
      list.innerHTML = items.map((g) => {
        const on = UP.sel.has(g.key);
        const done = g.pending === 0;
        return `<div class="up-row${on ? ' on' : ''}" data-key="${esc(g.key)}" title="${esc(g.dir || g.name)}">
          <span class="up-ck">${IC_CHK}</span>
          <div class="up-info">
            <b>${esc(g.name)}</b>
            <span>${esc(SRC_LABEL[g.source] || g.source)} · ${esc(shortDir(g.dir))}</span>
          </div>
          <div class="up-stat">
            <span class="up-cnt">${g.items} 个会话 · 约 ${(g.msgs || 0).toLocaleString('zh-CN')} 条</span>
            <span class="up-tag ${done ? '' : 'pend'}">${done ? '已上传' : '待上传 ' + g.pending}</span>
          </div>
        </div>`;
      }).join('');
      list.querySelectorAll('.up-row').forEach((row) => {
        row.addEventListener('click', () => {
          const k = row.dataset.key;
          if (UP.sel.has(k)) UP.sel.delete(k); else UP.sel.add(k);
          row.classList.toggle('on', UP.sel.has(k));
          updateUpFooter();
        });
      });
    }
    updateUpFooter();
  }

  function selStats() {
    const items = (UP.inv && UP.inv.items) || [];
    let sess = 0, pend = 0;
    for (const g of items) {
      if (!UP.sel.has(g.key)) continue;
      sess += g.items || 0;
      pend += g.pending || 0;
    }
    return { groups: UP.sel.size, sess, pend };
  }

  function updateUpFooter() {
    const note = upEl('upm-ft-note');
    const qn = upEl('upm-quick-note');
    const items = (UP.inv && UP.inv.items) || [];
    const pendingItems = items.filter((g) => (g.pending || 0) > 0).length;
    if (qn) qn.textContent = pendingItems ? `未上传的 agent ${pendingItems} 个` : '全部已上传过';
    if (!note) return;
    if (!UP.sel.size) { note.textContent = '未选择时「上传选中项」不可用；点「上传全部记忆」可一键全传。'; return; }
    const s = selStats();
    note.textContent = `已选 ${s.groups} 个 agent · ${s.sess} 个会话 · 其中待上传 ${s.pend} 个（已上传的会自动跳过）`;
  }

  function setSelAll(mode) {
    const items = (UP.inv && UP.inv.items) || [];
    UP.sel = new Set();
    if (mode === 'all') items.forEach((g) => UP.sel.add(g.key));
    else if (mode === 'pending') items.forEach((g) => { if ((g.pending || 0) > 0) UP.sel.add(g.key); });
    renderInventory();
  }

  function setProgress(show, pct, text) {
    const box = upEl('upm-progress');
    const fill = upEl('upm-pfill');
    const txt = upEl('upm-ptext');
    if (box) box.hidden = !show;
    if (fill && pct != null) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (txt && text != null) txt.textContent = text;
  }

  // 启动回传：targets 为空数组 = 全部
  async function startUpload(targets, label) {
    if (UP.busy) return;
    if (typeof tdai.backfillStart !== 'function') { pushLocal('err', '应用版本过旧，请升级后重试'); return; }
    UP.busy = true;
    const btnGo = upEl('upm-go'), btnAll = upEl('upm-all');
    if (btnGo) btnGo.disabled = true;
    if (btnAll) btnAll.disabled = true;
    setProgress(true, 3, `正在启动${label}…`);
    try {
      const r = await tdai.backfillStart({ targets: targets || [] });
      if (r && r.ok === false) {
        const msg = (r.payload && r.payload.error) || r.error || '无法启动回传';
        setProgress(true, 100, '启动失败：' + msg);
        pushLocal('warn', '回传启动失败：' + msg);
        return;
      }
      const extra = (r && r.local) ? '（已切换为本应用进程内回传）' : '';
      setProgress(true, 5, `回传已启动${extra}：正在解析本地会话并分批上传（已传过的自动跳过）…`);
      pushLocal('ok', `${label}已启动，正在上传…`);
      pollUpBackfill();
    } catch (e) {
      setProgress(true, 100, '启动异常：' + ((e && e.message) || e));
    } finally {
      UP.busy = false;
      if (btnGo) btnGo.disabled = false;
      if (btnAll) btnAll.disabled = false;
    }
  }

  function pollUpBackfill() {
    if (UP.timer || typeof tdai.backfillStatus !== 'function') return;
    UP.timer = setInterval(async () => {
      let st = null;
      try {
        const r = await tdai.backfillStatus();
        st = r && (r.payload || r);
      } catch (_) { return; }
      if (!st) return;
      const done = st.filesDone || 0, total = st.files || st.total || 0;
      const pct = total ? Math.round((done / total) * 100) : 5;
      const msg = st.running
        ? `回传中：${done}/${total} · 已上传 ${st.msgs || 0} 条` + (st.current ? ` · 当前 ${st.current}` : '')
        : (st.doneAt
          ? `回传完成：${done}/${st.total || total} · 共 ${st.msgs || 0} 条` + (st.error ? `（告警：${st.error}）` : '')
          : '等待中…');
      setProgress(true, st.running ? Math.max(5, pct) : 100, msg);
      // 同时刷新面板里的横幅，切页也能看到
      renderBackfill(st);
      if (!st.running) {
        clearInterval(UP.timer); UP.timer = null;
        pushLocal(st.error ? 'warn' : 'ok', msg);
        loadInventory();      // 完成后重算"待上传"，让状态即时归零
      }
    }, 1500);
  }

  // 弹窗事件绑定
  (function bindUpModal() {
    const mask = upEl('upm-modal');
    if (!mask) return;
    const x = upEl('upm-close'), cancel = upEl('upm-cancel');
    if (x) x.addEventListener('click', closeUpModal);
    if (cancel) cancel.addEventListener('click', closeUpModal);
    // 点遮罩空白处关闭（点弹窗内部不关）
    mask.addEventListener('click', (e) => { if (e.target === mask) closeUpModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) closeUpModal(); });
    const sa = upEl('upm-sel-all'), sn = upEl('upm-sel-none'), sp = upEl('upm-sel-pending');
    if (sa) sa.addEventListener('click', () => setSelAll('all'));
    if (sn) sn.addEventListener('click', () => setSelAll('none'));
    if (sp) sp.addEventListener('click', () => setSelAll('pending'));
    const go = upEl('upm-go'), all = upEl('upm-all');
    if (go) go.addEventListener('click', () => {
      if (!UP.sel.size) { setProgress(true, 0, '请先勾选要上传的 agent（或点「上传全部记忆」）'); return; }
      startUpload(Array.from(UP.sel), `已选 ${UP.sel.size} 个 agent 的回传`);
    });
    if (all) all.addEventListener('click', () => startUpload([], '全部记忆的回传'));
  })();

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
    // 「一键上传本地记忆」/「回传历史会话」：打开弹窗，由用户选择范围
    async 'backfill-start'() {
      openUpModal();
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
    const dp = $('#d-port'); if (dp) dp.textContent = `127.0.0.1:${info.port}`;
    const ap = $('#ag-port'); if (ap) ap.textContent = `127.0.0.1:${info.port}`;
  });

  /* ============================================================
     Agent 接入页
     ============================================================ */
  const STATUS_LABEL = { installed: '已接入', missing: '未接入', absent: '未安装' };

  // 开关切换：接入 / 断开单个客户端
  async function toggleAgent(key, enable) {
    const b = $('#b-agent');
    try {
      if (b) { b.className = 'banner show ok'; b.textContent = (enable ? '正在接入 ' : '正在断开 ') + key + '…'; }
      const r = await tdai.agentsToggle(key, enable);
      if (r && r.ok) {
        if (r.items) renderAgentItems(r.items);
        const results = (r.results || []).map((x) => `[${x.action}] ${x.target} — ${x.detail}`).join('\n');
        if (b) { b.className = 'banner show ok'; b.textContent = (enable ? '已接入 ' : '已断开 ') + key + (results ? '：' + results.replace(/\n/g, '；') : ''); }
        const log = $('#agent-log');
        if (log && results) { log.style.display = 'block'; log.textContent = results; }
      } else {
        if (b) { b.className = 'banner show err'; b.textContent = (enable ? '接入 ' : '断开 ') + key + ' 失败：' + ((r && r.error) || '未知错误'); }
      }
      await refreshAgentCore();
    } catch (e) {
      if (b) { b.className = 'banner show err'; b.textContent = '操作失败：' + ((e && e.message) || e); }
    }
  }

  // 统一的客户端行渲染（开关 + 名称 + 状态徽章）
  function renderAgentItems(items) {
    const list = $('#agent-list');
    if (!list) return;
    if (!items || !items.length) { list.innerHTML = '<div class="empty">未检测到客户端</div>'; return; }
    list.innerHTML = items.map((it) => {
      const absent = it.status === 'absent';
      const on = it.status === 'installed';
      // 旧路径接入（node.exe）时给切换提示，但开关仍显示"开"（重新点一下即切换到本应用）
      const oldTip = on && it.byApp === false ? '<span class="ar-old">旧接入路径，建议关→开切换</span>' : '';
      return `<div class="agent-row" data-key="${esc(it.key)}">
        <div class="ar-name">
          <b>${esc(it.name)}</b>
          <span>${esc(it.detail || '')}${oldTip}</span>
        </div>
        <span class="agent-badge ${esc(it.status || '')}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
        <span class="agent-toggle ${on ? 'on' : ''} ${absent ? 'disabled' : ''}" title="${absent ? '未安装该客户端' : (on ? '点击断开' : '点击接入')}">
          <span class="sw"></span>${on ? '已接入' : (absent ? '未安装' : '未接入')}
        </span>
      </div>`;
    }).join('');
    // 事件委托：点整行任意处切换
    list.querySelectorAll('.agent-row').forEach((row) => {
      row.addEventListener('click', () => {
        const key = row.dataset.key;
        const it = (items || []).find((x) => x.key === key);
        if (!it || it.status === 'absent') return;   // 未安装的不响应
        toggleAgent(key, it.status !== 'installed');
      });
    });
  }

  async function loadAgents() {
    let items = [];
    try { items = await tdai.agentsStatus(); } catch (_) { items = []; }
    renderAgentItems(items);
    const installed = (items || []).filter((x) => x.status === 'installed').length;
    const total = (items || []).length;
    const ac = $('#ag-clients'); if (ac) ac.textContent = `${installed} / ${total}`;
    const b = $('#b-agent');
    if (b && items && items.length) {
      const missing = items.filter((x) => x.status === 'missing').length;
      if (missing) { b.className = 'banner show warn'; b.textContent = `有 ${missing} 项已安装但未接入：点对应行开关即可（也可点上方「一键接入全部客户端」）。`; }
      else if (installed) { b.className = 'banner show ok'; b.textContent = `已接入 ${installed} 个客户端，可直接使用 tdai 记忆工具。点击任意行可单独断开 / 重连。`; }
      else { b.className = 'banner show warn'; b.textContent = '尚未接入任何客户端：点任意行开关，或点「一键接入全部客户端」。'; }
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
      if (items) renderAgentItems(items);
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
    // 记忆策略（recallAlways）：服务端返回布尔
    applyRecallMode(!!c.recallAlways);
  }

  // 记忆策略 UI：select 值 + 说明文案
  function applyRecallMode(always) {
    const sel = $('#set-recall');
    if (sel) sel.value = always ? 'always' : 'intent';
    const hint = $('#recall-hint');
    if (hint) hint.textContent = always
      ? '当前：每次对话都存读 — 每次对话自动采集上传，且每次提问前自动检索注入相关记忆。'
      : '当前：仅提到才存读 — 采集上传照常，只有你说「记住」「想一下记忆」等才检索注入。';
  }

  // 记忆策略切换：立即写入 daemon 配置（hook 实时读配置，下次提问即生效）
  const recallSel = $('#set-recall');
  if (recallSel) recallSel.addEventListener('change', async () => {
    const always = recallSel.value === 'always';
    const r = await tdai.recallSet(always);
    if (r && r.ok) {
      applyRecallMode(always);
      banner('b-recall', 'ok', always ? '已切换：每次对话都存读（提问前自动检索注入）。' : '已切换：仅提到「记住/想一下记忆」才存读。');
    } else {
      banner('b-recall', 'err', '切换失败：' + ((r && r.error) || '未知错误'));
      recallSel.value = always ? 'intent' : 'always';   // 回滚
    }
  });
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
      // 守护重启结果必须如实回显：早先主进程把错误吞掉，这里无脑报"已重启"，
      // 用户会以为新地址生效了，实际守护还跑在旧配置上。
      const rs = c.restart || {};
      if (rs.ok === false) {
        banner('b-conn', 'err', `配置已保存，但后台守护重启失败：${rs.error || '未知原因'}。请到「设置 → 更新」或用托盘菜单重启应用。`);
      } else if (rs.external) {
        banner('b-conn', 'ok', '配置已保存。端口被外部守护进程占用，已切换为外部守护模式（由该进程继续提供本地服务）。');
      } else {
        banner('b-conn', 'ok', '配置已保存（原文件备份为 .bak），后台守护已按新配置重启。');
      }
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
  // 注：设置页曾有一套重复的 "Agent 接入" 面板（#agents-register / #agents-reload /
  // #open-web-console），已移除。Agent 接入统一走顶栏 tab：
  //   #agent-register / #agent-refresh / #agent-copy-cmd / #agent-open-console

  /* ============================================================
     波纹反馈（原型 v3 同款）：把点击点坐标写进 --rx / --ry，
     由 CSS 的 .btn-*::after 径向渐变在按下时从该点扩散。
     ============================================================ */
  (function bindRipple() {
    const SEL = '.btn-primary, .btn-ghost, .btn-danger, .ghost, .mini, .icon-btn';
    document.addEventListener('pointerdown', (e) => {
      const el = e.target.closest && e.target.closest(SEL);
      if (!el || el.disabled) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      el.style.setProperty('--rx', (((e.clientX - r.left) / r.width) * 100).toFixed(2) + '%');
      el.style.setProperty('--ry', (((e.clientY - r.top) / r.height) * 100).toFixed(2) + '%');
    }, { passive: true });
  })();

  /* ---------- 启动 ---------- */
  onHomeShown();
  loadOverview();
})();
