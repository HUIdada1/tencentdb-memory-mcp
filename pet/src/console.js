// console.js — 控制台渲染逻辑
/* global tdai */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 延迟历史采样已移除：延迟波形（最近 60s）整块删除，不再需要逐拍累积的采样数组。
  // 延迟只以「面板延迟」单个最新值呈现（hero 体征条 + 副标题），不留历史副本。
  const S = { snap: null, appInfo: null, sessTimer: null, live: { items: [], filtered: [], page: 1, perPage: 40, q: '', source: '', state: '' }, lastLogSeq: 0, logPaused: false, logClearSeq: 0, scanAnchor: 0, scanInterval: 120, guardEnabled: true, stoppedExternal: false, guideOpen: null, agents: [] };

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
  // 偏好首次加载：**必须先完成**再渲染总览（见文件末尾的启动段）。
  // 抽成命名变量，让末尾的启动段能 await 同一份 Promise，不会重复请求。
  const prefsReady = tdai.prefsLoad().then((p) => {
    applyTheme(p.ui.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p.ui.theme);
    const st = $('#set-theme'); if (st) st.value = p.ui.theme || 'dark';
    const sa = $('#set-autostart'); if (sa) sa.checked = !!p.system.autoStart;
    const su = $('#set-autoupdate'); if (su) su.checked = !!p.update.autoCheck;
    const ca = $('#set-close-action'); if (ca) ca.value = p.system.closeAction === 'quit' ? 'quit' : 'hide';
    refreshSystemStatus();
    // 守护服务开关状态（右上角 pill 点击切换）：持久化在应用偏好里
    if (p.system && p.system.guardEnabled === false) {
      S.guardEnabled = false;
      // 走统一的 setHealthPill，别手写 classList：
      // 它同时维护 HEALTH.connected（总览「连接状态」卡的权威源）与 pill 的 title，
      // 早先只改了 pill 的两个类名，导致首帧连接状态卡仍按旧判据走一遍。
      setHealthPill('off', '守护已停止', '守护服务已手动停止：采集上传与本地 recall 服务暂停。点击此按钮重新开启。');
    }
    return p;
  });
  prefsReady.catch(() => { });   // 偏好读不到也要让启动段继续（避免总览永远空白）
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
  bindPref('#set-close-action', 'change', async () => {
    const value = $('#set-close-action').value === 'quit' ? 'quit' : 'hide';
    await tdai.prefsSave({ system: { closeAction: value } });
    refreshSystemStatus();
  });

  async function refreshSystemStatus() {
    if (typeof tdai.systemStatus !== 'function') return;
    try {
      const r = await tdai.systemStatus();
      const ca = $('#set-close-action'); if (ca) ca.value = r.closeAction === 'quit' ? 'quit' : 'hide';
      const close = $('#close-action-status');
      if (close) close.textContent = r.closeAction === 'quit'
        ? '当前：关闭窗口会停止本应用的守护、采集上传、recall 服务和会话扫描。'
        : '当前：关闭窗口只隐藏控制台，托盘、守护、采集上传、recall 服务和会话扫描继续运行。';
      const auto = $('#autostart-status');
      const a = r.autoStart || {};
      if (auto) auto.textContent = a.supported === false
        ? '开发模式不会写入系统自启；打包安装版才会注册 Windows 开机启动。'
        : `系统自启：${a.openAtLogin ? '已注册' : '未注册'} · 启动方式：${a.openAsHidden ? '后台隐藏' : '会显示窗口'}${a.wasOpenedAtLogin ? ' · 本次由自启启动' : ''}`;
    } catch (_) { }
  }

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
   * 判定口径（按优先级）：
   *   ⓪ 守护被手动停止 → 一律"未连接"（采集上传链路已断，面板再通也没意义）
   *   ① 未配置面板地址     → 未配置
   *   ② panelOk === false → 连接失败（最近一次真实往返失败）
   *   ③ 延迟样本新鲜（latency>0 且未过期）→ 已连接
   *   ④ 守护探活成功       → 已连接（尚无延迟样本）
   *   ⑤ 延迟样本已过期     → 待确认（不能继续举着"已连接"）
   */
  const HEALTH = { connected: null, text: '检测中', detail: '' };

  /* ---------- 守护是否真的在跑：连接判定的第一道闸 ----------
   * 2026-09-22 修复。用户点「停止守护」后，pill 与连接状态卡反而显示"已连接"：
   *   停止 → 采集循环停摆 → 最后一批 /health 探活的延迟样本留在 30s TTL 内
   *   → refreshHealthPill 的 `m.latency > 0` 分支命中 → 点亮"已连接"。
   * 界面说"连着呢"，实际一个字节都没在上传 —— 这是最误导人的一种状态。
   * 现在：守护被手动停止（S.guardEnabled === false）时，连接判定直接置为"未连接"，
   * 总览的「连接状态」卡随之显示"离线"，与右上角 pill 口径完全一致。
   */
  function daemonStopped() { return S.guardEnabled === false; }

  function setHealthPill(state, text, detail) {
    const pill = $('#health-pill');
    const label = $('#health-text');
    // 守护已停止：无论面板能不能通，都不算"已连接"（采集上传这条链路已经断了）
    HEALTH.connected = daemonStopped() ? false : (state === 'ok' ? true : (state === 'err' ? false : null));
    HEALTH.text = text;
    HEALTH.detail = detail || '';
    if (label) label.textContent = text;
    if (pill) {
      pill.classList.remove('on', 'err', 'off', 'wait');
      // 守护已停止 → 用 off 类（灰色），别再用 wait（那是"正在检测"的语义）
      const cls = daemonStopped() ? 'off' : (state === 'ok' ? 'on' : (state === 'err' ? 'err' : 'wait'));
      pill.classList.add(cls);
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
        // 外部守护进程不是本应用能结束的：停止后端口 8100 仍由它服务。
        // 记下来，让"已停止"文案不至于谎报"本地服务已暂停"。
        S.stoppedExternal = !next && !!r.stoppedExternal;
        // 立刻清空旧的探活/倒计时残留，别等 15s 定时器：
        // 否则停止后这一段时间里界面还挂着"运行中 / 即将采集…"的旧值，
        // 用户以为守护还在偷偷上传（本机实测就是这个现象）。
        S.scanAnchor = 0;
        const ns = $('#d-nextscan'); if (ns) { ns.textContent = '—'; setCls(ns, ''); }
        if (!next) { const dn = $('#d-since'); if (dn) dn.textContent = '—'; }
        pushLocal(next ? 'ok' : 'warn', next ? '守护服务已开启'
          : (r.stoppedExternal ? '本应用已退出守护角色（外部守护进程仍在提供服务）' : '守护服务已停止'));
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
    let state = 'wait', text = '检测中', detail = '';
    if (S.guardEnabled === false) {
      // 守护被手动停止：pill 固定显示"守护已停止"，不跑其它判据（避免盖住用户意图）
      state = 'off'; text = '守护已停止';
      detail = '守护服务已手动停止：采集上传与本地 recall 服务暂停。点击此按钮重新开启。';
    } else {
      const snap = S.snap;
      const panelUrl = (S.appInfo && S.appInfo.panelUrl) || (snap && snap.panelUrl) || '';
      if (!panelUrl) {
        state = 'wait'; text = '未配置';
        detail = '尚未配置记忆库面板地址，请到「设置 → 记忆库连接」填写';
      } else if (!snap) {
        state = 'wait'; text = '检测中';
        detail = '已配置面板，等待首次心跳…';
      } else {
        const host = sanitizePanel(panelUrl);
        const m = snap.metrics || {};
        // 延迟是 30s TTL 的滑窗样本：刚停止守护时最后一次探活仍有值，
        // 不能拿它当"还连着"的证据（守护停止 = 面板往返链路已停）。
        const latencyFresh = m.latency > 0 && !m.latencyStale;
        if (snap.panelOk === false) {
          // 区分"地址错 / 面板挂了"与"地址对但 key 不行"：后者别喊"连接失败"，
          // 否则用户会去改地址（越改越乱），真正该做的是重新签发 userKey。
          if (snap.panelAuthFail) {
            state = 'err'; text = '认证失败';
            detail = `${host} 可达，但 userKey 失效或权限不足${snap.panelError ? '：' + snap.panelError : ''}。请到面板重新签发 userKey。`;
          } else {
            state = 'err'; text = '连接失败';
            detail = `${host} 不可达${snap.panelError ? '：' + snap.panelError : ''}`;
          }
        } else if (latencyFresh) {
          state = 'ok'; text = '已连接'; detail = `${host} · 延迟 ${m.latency}ms`;
        } else if (snap.daemonOk) {
          state = 'ok'; text = '已连接'; detail = `${host} · 守护在线（尚未发请求，暂无延迟）`;
        } else if (m.latency > 0) {
          // 有过往返但样本已过期（>30s 无新样本）。
          // 注意：守护在线时这个分支**不该出现** —— 10s 探活会持续刷新延迟。
          // 真正会走到这里的是"守护还开但探活一路失败"，说明本地服务已不可达，
          // 此时既不能举着"已连接"，也不该像面板挂了那样喊"连接失败"（面板可能好好的）。
          state = 'wait'; text = '待确认';
          detail = `${host} · 本地守护探活失败，最近一次成功的往返已过期`;
        } else {
          state = 'wait'; text = '检测中';
          detail = `${host} · 已配置，等待首次成功往返…`;
        }
      }
    }
    setHealthPill(state, text, detail);
  }

  /* ---------- 首排布局 ----------
   * 三张指标卡（进行中会话 / 累计请求 / 失败请求）**恒定一行等宽**，
   * 由 CSS 的 .home-top>.stat-row{flex-wrap:nowrap} 保证，不再随连接状态切换。
   * 早先这里有 syncHomeSplit()，按 HEALTH.connected 在 .split/.nosplit 间切，
   * 未连接时三张卡被挤成 2+1 两行、左右不对称 —— 用户明确要求取消该行为。
   * hero 的宽窄也不再由状态决定（恒为整行），故此处无需任何版式逻辑。
   */

  /* ---------- 顶部体征条副标题 = 唯一的实时链路读数 ----------
   * 用户要求「总览页面中最顶部卡片」的数据实时刷新。
   * 这里的口径：面板地址 · 面板延迟 · 上/下行速率，全部来自 1s 心跳快照。
   * 面板地址放在这里，是为了替掉原先那张只会静态显示域名的「记忆库面板」卡
   * （那张卡的数据来源 panelUrl 与 pill 的 title 完全重复，属于重复展示）。
   */
  function renderLiveSub(snap, m) {
    const lat = m.latency > 0 && m.latencyStale !== true ? m.latency + 'ms' : '—';
    let sub = `${sanitizePanel(snap.panelUrl)} · 面板延迟 ${lat}`;
    // 守护已停止：采集停摆，必须直说，否则用户会误以为仍在上传
    if (daemonStopped()) sub += ' · 采集已停止';
    return sub;
  }

  /* ============================================================
     ② 关键指标卡
     ============================================================ */
  /* 「连接状态 / 上传速度 / 下传速度」三张卡已删除：
   * 连接状态与右上角 pill、hero 的 live-text 是同一份数据；
   * 上传/下载速度与下方上下行流量卡的「当前速率」是同一份数据。
   * 三张卡只是把同一批数字换个地方再显示一遍，属于典型重复展示。 */
  function renderStats(m, snap) {
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
  const SRC_NAME = { zcode: 'ZCode CLI', 'zcode-db': 'ZCode 会话库', 'zcode-rollout': 'ZCode Rollout', 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', trae: 'Trae', 'deepseek-harness': 'DeepSeek Harness', codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy', opencode: 'OpenCode', hermes: 'Hermes', openclaw: 'OpenClaw', pi: 'Pi' };

  // sqlite 权威源降级警告：必须显示，否则用户只会看到"最新会话停在几个月前"
  // 而误判程序坏了（Node < 22.16 时 node:sqlite 不可用 → 只统计归档文件）
  function renderSessionWarnings(warnings) {
    const box = $('#sess-warn');
    if (!box) return;
    const w = (warnings || []).find((x) => x && x.code === 'sqlite');
    if (!w) { box.className = 'banner warn'; box.textContent = ''; return; }
    box.className = 'banner warn show';
    box.textContent = w.message + (w.hint ? ' ' + w.hint : '');
    box.title = w.path ? '会话库路径：' + w.path : '';
  }

  const LIVE_PAGE_SIZE = 40;

  function renderSessionSourceOptions(list) {
    const sel = $('#sess-source');
    if (!sel) return;
    const current = S.live.source;
    const keys = Array.from(new Set((list || []).map((x) => x && x.source).filter(Boolean))).sort();
    sel.innerHTML = '<option value="">全部来源</option>' + keys.map((k) => `<option value="${esc(k)}">${esc(SRC_NAME[k] || srcName(k))}</option>`).join('');
    sel.value = keys.includes(current) ? current : '';
  }

  function filteredSessions(list) {
    const q = S.live.q.trim().toLowerCase();
    return (list || []).filter((s) => {
      if (S.live.source && s.source !== S.live.source) return false;
      if (S.live.state && s.state !== S.live.state) return false;
      if (q) {
        const text = [s.id, s.label, s.source, s.lastNote, s.file].filter(Boolean).join(' ').toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }

  function renderSessionPager(total) {
    const box = $('#sess-pager');
    if (!box) return;
    const pages = Math.max(1, Math.ceil(total / LIVE_PAGE_SIZE));
    const page = Math.min(Math.max(S.live.page, 1), pages);
    S.live.page = page;
    if (pages <= 1) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `
      <button class="pg-btn" data-session-pg="first" ${page <= 1 ? 'disabled' : ''} title="首页">«</button>
      <button class="pg-btn" data-session-pg="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="pg-info"><b>${page}</b> / ${pages}<em>共 ${total.toLocaleString('zh-CN')} 个</em></span>
      <button class="pg-btn" data-session-pg="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
      <button class="pg-btn" data-session-pg="last" ${page >= pages ? 'disabled' : ''} title="末页">»</button>`;
  }

  function renderSessions(list) {
    const box = $('#sess-list');
    if (!box) return;
    list = Array.isArray(list) ? list : [];
    S.live.items = list;
    renderSessionSourceOptions(list);
    const view = filteredSessions(list);
    S.live.filtered = view;
    const pages = Math.max(1, Math.ceil(view.length / LIVE_PAGE_SIZE));
    S.live.page = Math.min(Math.max(S.live.page, 1), pages);
    const pageItems = view.slice((S.live.page - 1) * LIVE_PAGE_SIZE, S.live.page * LIVE_PAGE_SIZE);
    const cnt = $('#sess-count');
    if (cnt) {
      const act = view.filter((x) => x.state === 'thinking' || x.state === 'active').length;
      cnt.textContent = `共 ${list.length} 个 · 显示 ${view.length} · 第 ${S.live.page}/${pages} 页 · 进行中 ${act}`;
    }
    if (!view.length) {
      box.innerHTML = '<div class="empty">未扫描到会话文件（与任一 Agent 对话后出现）</div>';
      renderSessionPager(0);
      return;
    }
    box.innerHTML = pageItems.map((s) => {
      const state = ST[s.state] || s.state || '—';
      const stale = (s.state === 'stale') ? ' dim' : '';
      const file = s.file || '';
      return `<div class="sess-row${stale}" title="${esc(file)}">
        <div class="sess-name">
          <b title="${esc(s.id)}">${esc(s.label || s.id)}</b>
          <span class="source-chip" data-source="${esc(s.source || '')}">${esc(SRC_NAME[s.source] || srcName(s.source))}</span>
          ${file ? `<span class="sess-file">${esc(file)}</span>` : ''}
        </div>
        <span class="badge-st ${esc(s.state || '')}">${esc(state)}</span>
        <span>${esc(String(s.turns || 0))} 轮</span>
        <span>${esc(fmtAgo(s.lastTs))}</span>
        <span class="sess-sum" title="${esc(s.lastNote || '')}">${esc(s.lastNote || '—')}</span>
      </div>`;
    }).join('');
    renderSessionPager(view.length);
  }

  async function refreshSessions(force) {
    try {
      const r = await tdai.sessionsScan({ force: !!force, limit: 0 });
      if (r && r.ok) {
        renderSessionWarnings(r.warnings);
        renderSessions(r.sessions);
        renderLiveMeta(r.sessions);
      }
    } catch (_) { /* 扫描失败不阻塞界面 */ }
  }

  ['#sess-q', '#sess-source', '#sess-state'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
      if (sel === '#sess-q') S.live.q = el.value;
      if (sel === '#sess-source') S.live.source = el.value;
      if (sel === '#sess-state') S.live.state = el.value;
      S.live.page = 1;
      renderSessions(S.live.items);
    });
  });
  const sessClear = $('#sess-clear-filter');
  if (sessClear) sessClear.addEventListener('click', () => {
    S.live.q = ''; S.live.source = ''; S.live.state = ''; S.live.page = 1;
    ['#sess-q', '#sess-source', '#sess-state'].forEach((sel) => { const el = $(sel); if (el) el.value = ''; });
    renderSessions(S.live.items);
  });

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
    // 守护已停止：上行卡文案要直说"不会再上传"，否则用户盯着一个静止的 0 B/s 猜原因
    const unote = $('#up-bytes-note');
    if (unote) unote.textContent = daemonStopped()
      ? '守护已停止 · 不会发起任何上传'
      : '真实 socket 计量 · 近 2s 窗口';

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
    // 上行卡文案已在上面按守护状态设置（守护停止时直说"不会发起上传"）
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
    // 守护已停止：没有"下次采集"这回事，别让它停在"即将采集…"（那是假的）
    if (S.guardEnabled === false) { el.textContent = '—'; setCls(el, ''); return; }
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
      // 与右上角 pill 用同一套文案：两处都写"已停止"，用户不会以为是两种状态。
      // ⚠️ 外部守护模式的例外：外部进程本应用停不掉，端口 8100 仍由它提供服务，
      //    这时写"已停止"是谎报（会让用户以为本地 recall 挂了）。据实区分文案。
      const ext = !!S.stoppedExternal;
      const mode = $('#d-mode');
      if (mode) { mode.textContent = ext ? '已退出（外部守护在跑）' : '已停止'; setCls(mode, 'warn'); }
      const up = $('#d-upload');
      if (up) { up.textContent = ext ? '由外部守护决定' : '已停止'; setCls(up, 'warn'); }
      const ns = $('#d-nextscan'); if (ns) { ns.textContent = '—'; setCls(ns, ''); }
      // 顶部三个体征字段也要清：否则"守护探活 4ms""运行时长 3:12:45"会一直挂着，
      // 看起来守护还活着（这两个值最后一次写入后没人再更新，是纯粹的陈旧残留）。
      const hb = $('#h-beat'); if (hb) hb.textContent = ext ? '外部守护' : '已停止';
      const hu = $('#h-uptime'); if (hu) hu.textContent = '—';
      // 本地服务地址与守护无关（端口是配置常量），停止时也该照常显示，
      // 否则整张卡片一排"—"看起来像渲染坏了。
      const port = $('#d-port');
      if (port && S.appInfo) port.textContent = `127.0.0.1:${S.appInfo.port}（${ext ? '外部守护提供服务' : '已停止'}）`;
      S.scanAnchor = 0;
      return;
    }
    try {
    const r = await tdai.daemonPing().catch(() => ({ ok: false, error: 'ipc 异常' }));
    const mode = $('#d-mode');
    if (r && r.ok && r.payload) {
      const p = r.payload;
      if (mode) { mode.textContent = '运行中'; setCls(mode, 'ok'); }
      const since = $('#d-since'); if (since) since.textContent = p.uptimeSince ? localTime(p.uptimeSince) : '—';
      // 这一行就是"到底还在不在上传"的答案：守护在线但采集关了 = 零上行。
      // 早先只有绿色的"运行中"，用户看到流量不动也不知道是被哪一层关了。
      const up = $('#d-upload');
      if (up) {
        // 老版本守护不上报 enabledSources：字段缺失时不臆断，显示"—"
        const srcs = p.uploadSources && typeof p.uploadSources === 'object' ? p.uploadSources : null;
        const on = srcs ? Object.keys(srcs).filter((k) => srcs[k]) : null;
        if (on && on.length) { up.textContent = '开启（' + on.length + ' 个来源）'; setCls(up, 'ok'); }
        else if (on) { up.textContent = '已关闭'; setCls(up, 'warn'); }
        else { up.textContent = '—'; setCls(up, ''); }
      }
      const lp = $('#d-lastpush'); if (lp) lp.textContent = p.lastPush ? fmtAgo(Date.parse(p.lastPush)) : '尚未上传';
      // ZCode 会话库来源可用性：守护跑在 Electron 内嵌 Node（<22.16）时该来源永远采不到，
      // 表现为「最近上传」停在某个时刻、之后再不动。必须显式报出来，
      // 否则用户只能看到"对话没上传"却没有任何线索（真实故障，2026-09-22）。
      const zb = $('#d-zdb');
      if (zb) {
        const z = p.zdb;
        if (!z) { zb.textContent = '—'; setCls(zb, ''); }
        else if (z.ok) { zb.textContent = '可用'; setCls(zb, 'ok'); }
        else if (z.reason === 'no-db') { zb.textContent = '无会话库'; setCls(zb, ''); }
        else { zb.textContent = '不可用（该来源不会被采集）'; setCls(zb, 'err'); }
        zb.title = (z && z.message) || '';
      }
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
      const up = $('#d-upload'); if (up) { up.textContent = '未采集'; setCls(up, 'err'); }
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

    // 守护已停止：顶部"运行时长"不再按推送值刷新。
    // 它由 1s 心跳推送驱动，而心跳在停止后仍在发（metrics 是应用级累计量），
    // 早先照写 → 停止后时长照样从 1:00 往前走，用户以为守护还活着。
    if (daemonStopped()) {
      const hu = $('#h-uptime'); if (hu) hu.textContent = '—';
    } else {
      const up = $('#h-uptime'); if (up) up.textContent = fmtUptime(snap.uptime);
    }

    // 延迟过期（metrics.latencyStale）时不显示，避免"幽灵延迟"。
    // ⚠️ 面板延迟只在 hero 副标题（renderLiveSub）里展示一次 ——
    //    hero 体征条里的重复项已删除（用户要求「面板延迟重复了留下一个即可」）。
    const latFresh = m.latency > 0 && m.latencyStale !== true;

    // 连接状态 pill 必须跟着心跳一起更新（它就是权威状态源）。
    refreshHealthPill();

    renderStats(m, snap);
    renderFlow(m, snap.series);
    renderSessionWarnings(snap.warnings);
    renderSessions(snap.sessions);
    renderLogs(snap.logs, snap.logSeq);
    renderLiveMeta(snap.sessions);

    // 与 pill 严格同口径：pill 是权威源，这里不再自己判一次，
    // 否则「pill=检测中」而横幅写「实时连接正常」会自相矛盾（早先 null 时就是如此）。
    const connected = HEALTH.connected;
    setLive(
      connected !== false,
      connected === false ? '面板连接已中断' : (connected === true ? '实时连接正常' : '等待首次往返…'),
      // 副标题 = 唯一的实时链路读数（面板地址 / 延迟 / 上下行速率），随 1s 心跳刷新
      renderLiveSub(snap, m)
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

  document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-session-pg]') : null;
    if (!el || el.disabled) return;
    const totalPages = Math.max(1, Math.ceil(S.live.items.length / LIVE_PAGE_SIZE));
    const map = { first: 1, prev: S.live.page - 1, next: S.live.page + 1, last: totalPages };
    const next = map[el.dataset.sessionPg];
    if (!next) return;
    S.live.page = Math.min(Math.max(next, 1), totalPages);
    renderSessions(S.live.items);
    const list = $('#sess-list');
    if (list) list.scrollTop = 0;
  });

  /* ---------- 实时会话页：动态来源统计 ----------
   * 不再写死"ZCode CLI / Claude Code"：按扫描结果实际出现的 source 动态列出行，
   * 未出现的来源不出现在列表里；同时生成对应的来源说明文案。
   */
  const SRC_DESC = {
    'zcode': { name: 'ZCode CLI', dir: '~/.zcode/cli/agents/' },
    'zcode-db': { name: 'ZCode 会话库', dir: '~/.zcode/cli/db/db.sqlite' },
    'zcode-rollout': { name: 'ZCode Rollout', dir: '~/.zcode/cli/rollout/' },
    'claude-code': { name: 'Claude Code', dir: '~/.claude/projects/' },
    codex: { name: 'Codex', dir: '~/.codex/sessions/ + archived_sessions/' },
    cursor: { name: 'Cursor', dir: '~/.cursor/projects/ 或 chats/' },
    trae: { name: 'Trae', dir: '~/.trae/projects/ 或 sessions/' },
    'deepseek-harness': { name: 'DeepSeek Harness', dir: '~/.dsh/storages/session_projcache/sessions/' },
    codebuddy: { name: 'CodeBuddy', dir: '~/.codebuddy/sessions/ 或 conversations/' },
    workbuddy: { name: 'WorkBuddy', dir: '~/.workbuddy-ai/logs/<日期>/sdk/conversations/' },
    opencode: { name: 'OpenCode', dir: '~/.local/share/opencode/storage/' },
    hermes: { name: 'Hermes', dir: '~/.hermes/sessions/ 或 conversations/' },
    openclaw: { name: 'OpenClaw', dir: '~/.openclaw/sessions/ 或 conversations/' },
    pi: { name: 'Pi', dir: '~/.pi/agent/sessions/' },
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
    // 守护已停止：停止推进（否则秒数照走，看着像守护还在后台跑）
    if (S.guardEnabled === false) return;
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
  // 需要富文本（如 .empty 占位块）时用这个 —— setOut 走 textContent，会把标签当字面量显示
  function setOutHtml(sel, html) { const el = $(sel); if (el) el.innerHTML = html; }
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

  /* ---------- 分页状态 ----------
   * 两种模式的分页方式不同，这是面板能力决定的（已实测）：
   *   layers：/chat-memory/layer 支持真 offset，返回 {items,total,limit,offset} → 服务端分页
   *   search：/chat-memory/search 是 top-K 相似度查询，面板**忽略 offset**
   *           （传 offset=3 返回的仍是第一条），total 只等于返回条数 → 只能客户端分页
   * 所以这里统一存一份"当前页数据"，只是取数方式不同。
   */
  const MEM_PER_PAGE = 10;
  const MEM = {
    mode: 'layers',        // 'search' | 'layers'
    page: 1,
    perPage: MEM_PER_PAGE,
    total: 0,              // 服务端(分层)或客户端(检索)已知总数
    summaryTotal: 0,       // 分层概览的真实总量（概览不参与分页）
    items: [],             // 当前页要渲染的条目
    query: '',             // 最近一次检索词（翻页时复用）
    source: '',             // 来源类型筛选（面板返回 source/agent/source_type 时客户端过滤）
    layer: '',             // 分层模式当前层：'' = 概览，L0~L3 = 明细
    serverPaged: false,    // 该模式是否走服务端分页
    loadedAt: 0,
    requestId: 0,
  };

  // 时间格式化：面板给的是 ISO UTC（如 2026-09-21T17:37:15.404Z），
  // 直接打出来又长又难读，统一转成本地 "YYYY-MM-DD HH:mm"。
  function fmtTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 正文取值：面板字段是 body；其余候选是为了容忍别的形态（别删，之前就是漏了 body 才打 JSON）
  function itemBody(it) {
    const v = it.body ?? it.content ?? it.text ?? it.memory ?? it.value;
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  // 标题：L1~L3 常见 work_task / work_method 之类；L0 的 title 就是 role，别当标题重复显示
  function itemTitle(it) {
    const t = it.title;
    if (!t) return '';
    if (it.role && String(t) === String(it.role)) return '';
    return String(t);
  }
  function itemSource(it) {
    return String(it.source || it.source_type || it.agent || it.agent_name || it.origin || '').trim();
  }
  // 单条卡片：标题 + 正文 + 标签 + 分值 + 时间
  function itemCard(it) {
    const body = itemBody(it);
    const title = itemTitle(it);
    // role 色标：user(蓝) / assistant(紫) / 其它灰
    const role = it.role ? String(it.role) : '';
    const roleCls = role === 'user' ? 'is-user' : (role === 'assistant' ? 'is-asst' : '');
    const score = (it.score != null && !isNaN(Number(it.score)))
      ? Number(it.score) : null;
    const tags = Array.isArray(it.tags) ? it.tags.filter(Boolean) : [];
    const refs = Array.isArray(it.refs) ? it.refs.length : 0;
    const source = itemSource(it);
    const layer = it.layer || it.level || MEM.layer || '';
    const type = layer ? String(layer).replace('_messages', '') : 'memory';

    return `<div class="mem-item">
      <div class="mem-itop">
        <span class="mem-type">${esc(type)}</span>
        ${source ? `<span class="mem-source">${esc(SRC_NAME[source] || source)}</span>` : ''}
        ${role ? `<span class="mem-role ${roleCls}">${esc(role)}</span>` : ''}
        ${title ? `<span class="mem-title">${esc(title)}</span>` : ''}
        ${score != null ? `<span class="mem-score" title="匹配分值">${score.toFixed(2)}</span>` : ''}
      </div>
      <div class="mem-txt">${esc(body)}</div>
      <div class="mem-meta">
        ${it.created_at ? `<span class="mem-time">${esc(fmtTime(it.created_at))}</span>` : ''}
        ${refs ? `<span class="mem-refs">${refs} 引用</span>` : ''}
        ${tags.map((t) => `<span class="mem-tag">${esc(String(t))}</span>`).join('')}
      </div>
    </div>`;
  }

  function setMemoryContext(mode, total, label) {
    const modeEl = $('#mem-summary-mode');
    const totalEl = $('#mem-summary-total');
    const crumb = $('#mem-breadcrumb');
    const name = label || (mode === 'search' ? '关键词检索' : (MEM.layer ? `记忆层 ${MEM.layer}` : '分层概览'));
    if (modeEl) modeEl.textContent = name;
    if (totalEl) totalEl.textContent = Number(total) > 0 ? Number(total).toLocaleString('zh-CN') + ' 条' : '—';
    if (crumb) crumb.textContent = mode === 'layers'
      ? (MEM.layer ? `全部记忆 · ${name}` : '全部记忆 · 分层概览')
      : (MEM.query ? `检索：${MEM.query}` : '输入关键词开始检索');
    const back = $('#mem-layer-back');
    if (back) back.hidden = !(mode === 'layers' && MEM.layer);
  }

  function setMemoryBusy(busy) {
    const wrap = $('.mem-wrap');
    const badge = $('#mem-busy');
    if (wrap) {
      wrap.classList.toggle('is-loading', !!busy);
      wrap.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (badge) badge.hidden = !busy;
  }

  // 分页控件（底部居中）：只有一页时不占位
  function renderPager() {
    const box = $('#mem-pager');
    if (!box) return;
    const totalPages = Math.max(1, Math.ceil(MEM.total / MEM.perPage));
    if (totalPages <= 1) { box.innerHTML = ''; box.classList.remove('show'); return; }
    const cur = Math.min(Math.max(MEM.page, 1), totalPages);
    box.classList.add('show');
    box.innerHTML = `
      <button class="pg-btn" data-pg="first" ${cur <= 1 ? 'disabled' : ''} title="首页">«</button>
      <button class="pg-btn" data-pg="prev" ${cur <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="pg-info"><b>${cur}</b> / ${totalPages}<em>共 ${MEM.total.toLocaleString('zh-CN')} 条</em></span>
      <button class="pg-btn" data-pg="next" ${cur >= totalPages ? 'disabled' : ''}>下一页</button>
      <button class="pg-btn" data-pg="last" ${cur >= totalPages ? 'disabled' : ''} title="末页">»</button>`;
  }

  function renderMemResult(r, opts) {
    const box = $('#mem-out');
    if (!box) return;
    const when = opts && opts.loadedAt;
    const stamp = when ? `<span class="mem-stamp">刷新于 ${new Date(when).toLocaleTimeString('zh-CN', { hour12: false })}</span>` : '';
    if (!r || !r.ok) {
      box.innerHTML = `<div class="empty">检索失败：${esc((r && (r.error || r.hint)) || '未知错误')}</div>`;
      setMemoryContext(MEM.mode, 0, '加载失败');
      renderPager();
      return;
    }
    const d = r.data && (r.data.data || r.data);

    // ① 记忆条目列表（memory_search / memory_layers 传 layer 的典型返回）
    //    形态：{ items:[{id,role,title,body,tags,refs,score,created_at}], total }
    const rawList = (d && (d.items || d.list || d.results || d.memories)) || (Array.isArray(d) ? d : null);
    const list = rawList && MEM.source
      ? rawList.filter((it) => { const s = itemSource(it); return !s || s === MEM.source; })
      : rawList;
    if (list && list.length) {
      const isLayerDetail = !!(d && d.layer);
      const head = [
        isLayerDetail ? `记忆层 ${esc(String(d.layer))}` : '检索结果',
        `本页 ${list.length} 条`,
        MEM.total > list.length ? `共 ${MEM.total.toLocaleString('zh-CN')} 条` : '',
      ].filter(Boolean).join(' · ');
      box.innerHTML = `<div class="mem-head">${head}${stamp}</div>` + list.map(itemCard).join('');
      setMemoryContext(MEM.mode, MEM.total, isLayerDetail ? `记忆层 ${String(d.layer)}` : '关键词检索');
      renderPager();
      return;
    }

    // ①' 命中但该页为空（翻过头 / 该层无数据）
    if (list && !list.length) {
      box.innerHTML = `<div class="empty">这一页没有内容${MEM.total ? `（共 ${MEM.total} 条）` : ''}</div>`;
      setMemoryContext(MEM.mode, MEM.total, MEM.mode === 'search' ? '关键词检索' : `记忆层 ${MEM.layer}`);
      renderPager();
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
      // 分层行可点击 → 下钻到该层明细（服务端分页）
      box.innerHTML = `
        <div class="mem-head">记忆分层结构 · 共 ${total} 条${d.block_id ? ` · 记忆块 ${esc(String(d.block_id))}` : ''}${stamp}</div>
        <div class="mem-layers">${rows.map((x) => `
          <div class="mem-lrow" data-layer="${esc(x.key.replace(/_messages$/, ''))}" role="button" tabindex="0">
            <div class="mem-lname"><b>${esc(x.meta.name)}</b>${x.meta.note ? `<span>${esc(x.meta.note)}</span>` : ''}</div>
            <div class="mem-lbar"><i style="width:${Math.round((x.n / maxN) * 100)}%"></i></div>
            <div class="mem-ln">${x.n.toLocaleString('zh-CN')} 条</div>
          </div>`).join('')}
        </div>
        <div class="mem-hint">L0 为对话原文（最大头），L1→L3 为记忆库自动蒸馏出的分层记忆，逐级递减属正常。点任意一层可查看该层明细。</div>`;
      // 概览页没有分页
      MEM.summaryTotal = total;
      setMemoryContext('layers', total, '分层概览');
      MEM.total = 0;
      renderPager();
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
      box.innerHTML = `<div class="mem-head">记忆分层结构 · 共 ${layerItems.length} 层${stamp}</div>` + layerItems.map((it) => `
        <div class="mem-item">
          <div class="mem-lv"><b>${esc(String(it.name))}</b><span>${esc(String(it.count))} 条</span></div>
          ${it.note ? `<div class="mem-meta"><span>${esc(String(it.note))}</span></div>` : ''}
        </div>`).join('');
      MEM.total = 0;
      setMemoryContext('layers', layerItems.reduce((sum, x) => sum + (Number(x.count) || 0), 0), '分层概览');
      renderPager();
      return;
    }

    // ④ 其它形态：退回原始 JSON（保证一定能看到数据，而不是空白）
    const raw = JSON.stringify(d === undefined ? r.data : d, null, 2);
    box.innerHTML = raw && raw !== '{}'
      ? `<div class="mem-head">原始返回${stamp}</div><pre class="mem-raw">${esc(raw.slice(0, 8000))}</pre>`
      : '<div class="empty">返回为空（该记忆库暂无数据）</div>';
    MEM.total = 0;
    setMemoryContext(MEM.mode, 0, '原始返回');
    renderPager();
  }

  // 进入记忆页即自动加载一次，避免"页面空白"
  let memLoaded = false;

  // 统一的「加载」入口：按钮点击、切模式、翻页都走这里。
  //
  // 为什么要单独抽一层（2026-09-22 修 bug）：
  // 旧实现里点击按钮直接 await tdai.toolCall()，有两个问题：
  //   ① 面板不可达 / 守护是老版本时 toolCall 会 reject，异常把 #mem-out 永久钉在
  //      "加载分层…" 上，用户看到的就是"点了没反应"；
  //   ② 进入页面时已经自动渲染过同一份数据，点击后内容完全一样又没有任何提示，
  //      即使成功了也像是"没反应"。
  // 现在：加"载入中"态 → try/catch 兜底 → 渲染后写明刷新时间，让每次点击都可见。
  function memLayersBusy(busy, btn) {
    if (btn) { btn.disabled = !!busy; btn.classList.toggle('busy', !!busy); }
    $$('[data-act="memory-layers"]').forEach((b) => { b.disabled = !!busy; });
  }

  // 统一调用包一层：异常收敛成 {ok:false}，绝不让 reject 逃逸出去钉住界面
  async function memCall(tool, args) {
    try {
      return await tdai.toolCall(tool, args);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), hint: '面板不可达或本地服务未就绪' };
    }
  }

  function memLoading(text) {
    const box = $('#mem-out');
    if (!box) return;
    const hasContent = box.querySelector('.mem-layers, .mem-item, .mem-lrow');
    if (!hasContent) box.innerHTML = `<div class="empty">${esc(text)}</div>`;
  }

  function memFail(r) {
    const box = $('#mem-out');
    if (!box) return;
    setMemoryBusy(false);
    const why = (r && (r.error || r.hint)) || '';
    box.innerHTML = `<div class="empty">尚未取到记忆数据${why ? '：' + esc(why) : '（请先在「设置 → 记忆库连接」完成配置）'}</div>`;
    MEM.total = 0;
    renderPager();
  }

  // 分层模式：
  //   无 layer → 拉四层计数概览（概览不分页）
  //   有 layer → 拉该层明细，走**服务端分页**（面板返回真实 total，认 limit/offset）
  async function loadMemLayers(opts) {
    const o = opts || {};
    const btn = o.btn || null;
    const requestId = ++MEM.requestId;
    if (o.mark) memLayersBusy(true, btn);
    setMemoryBusy(true);
    memLoading(MEM.layer ? '正在加载该层记忆…' : '正在加载记忆分层…');
    let r;
    if (MEM.layer) {
      const offset = (MEM.page - 1) * MEM.perPage;
      r = await memCall('memory_layers', { layer: MEM.layer, limit: MEM.perPage, offset });
      MEM.serverPaged = true;
    } else {
      r = await memCall('memory_layers', {});
      MEM.serverPaged = false;
      MEM.total = 0;
    }
    if (requestId !== MEM.requestId) return r;
    if (o.mark) memLayersBusy(false);
    if (r && r.ok) {
      const d = r.data && (r.data.data || r.data);
      // 服务端分页时用返回的 total / offset 回写状态，保证页码与实际数据一致
      if (MEM.serverPaged && d) {
        MEM.total = Number(d.total) || 0;
        if (d.offset != null) MEM.page = Math.floor(Number(d.offset) / MEM.perPage) + 1;
      }
      renderMemResult(r, { loadedAt: Date.now() });
      setMemoryBusy(false);
    } else {
      memFail(r);
    }
    return r;
  }

  // 检索模式：面板对 search **不支持 offset**（实测传 offset 无效），
  // 所以一次拉满（面板上限 20）后客户端分页。
  async function loadMemSearch(opts) {
    const o = opts || {};
    const btn = o.btn || null;
    const requestId = ++MEM.requestId;
    if (o.mark) memLayersBusy(true, btn);
    setMemoryBusy(true);
    memLoading('检索中…');
    const args = { query: MEM.query, top_k: 20 };
    if (MEM.layer) args.layer = MEM.layer;   // 全部层时让面板用默认（L0）
    const r = await memCall('memory_search', args);
    if (requestId !== MEM.requestId) return r;
    if (o.mark) memLayersBusy(false);
    if (r && r.ok) {
      const d = r.data && (r.data.data || r.data);
      const raw = (d && (d.items || d.list || d.results || d.memories)) || (Array.isArray(d) ? d : []);
      const all = MEM.source ? raw.filter((it) => { const s = itemSource(it); return !s || s === MEM.source; }) : raw;
      MEM.serverPaged = false;
      MEM.items = all;
      MEM.total = all.length;
      MEM.page = 1;
      // 客户端切片后交给同一个渲染器（它只认识"当前页 items"）
      const pageItems = all.slice(0, MEM.perPage);
      renderMemResult({ ok: true, data: Object.assign({}, d, { items: pageItems }), hint: r.hint }, { loadedAt: Date.now() });
      setMemoryBusy(false);
    } else {
      memFail(r);
    }
    return r;
  }

  // 翻页 / 刷新当前模式。检索模式翻页不重新请求（已在内存里），分层模式才重新取数。
  async function memGoPage(page, opts) {
    const totalPages = Math.max(1, Math.ceil(MEM.total / MEM.perPage));
    const target = Math.min(Math.max(page, 1), totalPages);
    if (target === MEM.page && !(opts && opts.force)) return;
    MEM.page = target;
    if (MEM.mode === 'layers') {
      await loadMemLayers(opts);
    } else if (MEM.serverPaged) {
      await loadMemLayers(opts);
    } else {
      // 检索：本地切片渲染，不重新打面板
      const all = MEM.items || [];
      const pageItems = all.slice((MEM.page - 1) * MEM.perPage, MEM.page * MEM.perPage);
      renderMemResult({ ok: true, data: { items: pageItems } }, { loadedAt: MEM.loadedAt || Date.now() });
    }
    const box = $('#mem-out');
    if (box) box.scrollTop = 0;   // 翻页后回到顶部，否则停在上一页的滚动位置
  }

  // 模式/层 切换
  function setMemMode(mode, opts) {
    const o = opts || {};
    const prev = MEM.mode;
    MEM.mode = mode === 'layers' ? 'layers' : 'search';
    MEM.page = 1;
    // 模式切换本身先让旧请求失效。尤其是切到检索但尚未输入关键词时，
    // 没有新请求可覆盖旧响应，必须在这里主动截断旧响应的写回资格。
    if (prev !== MEM.mode) MEM.requestId++;
    // 切换模式时把"层"重置为全部层：
    // 两个模式共用同一个选择器，若不重置，从 L1 明细切到检索会静默把 layer=L1 带过去，
    // 用户以为在搜全库、实际只在搜 L1（这是实跑测试抓到的真实问题）。
    if (prev !== MEM.mode && !o.keepLayer) MEM.layer = '';
    $$('[data-memmode]').forEach((b) => {
      const active = b.dataset.memmode === MEM.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const q = $('#mem-q'), lsel = $('#mem-layer'), sbtn = $('[data-act="memory-search"]'), lbtn = $('[data-act="memory-layers"]');
    const searchControls = $('#mem-search-controls'), layerControls = $('#mem-layer-controls');
    const isLayers = MEM.mode === 'layers';
    if (searchControls) searchControls.hidden = isLayers;
    if (layerControls) layerControls.hidden = !isLayers;
    if (q) q.classList.toggle('hide', isLayers);
    if (sbtn) sbtn.classList.toggle('hide', isLayers);
    if (lbtn) lbtn.classList.toggle('hide', !isLayers);
    if (lsel) { lsel.value = MEM.layer; }
    const back = $('#mem-layer-back');
    if (back) back.hidden = !isLayers || !MEM.layer;
    setMemoryContext(MEM.mode, MEM.mode === 'layers' ? (MEM.layer ? MEM.total : MEM.summaryTotal) : MEM.total);
    if (!o.silent) {
      if (isLayers) loadMemLayers({ mark: true, btn: lbtn });
      else if (MEM.query) loadMemSearch({ mark: true, btn: sbtn });
      else {
        memLayersBusy(false);
        setMemoryBusy(false);
        memLoading('输入关键词后回车检索。');
      }
    }
  }

  async function onMemoryShown() {
    if (memLoaded) return;
    memLoaded = true;
    setMemMode('layers', { silent: true, keepLayer: true });
    try {
      await loadMemLayers();
    } catch (_) { /* 内部已兜底，这里只防极端情况 */ }
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
      const source = st.source && st.source !== 'all' ? (SRC_LABEL[st.source] || st.source) : '全部来源';
      b.textContent = `回传中：${source} · ${st.filesDone}/${st.files} 个文件 · 已上传 ${st.msgs} 条` + (st.current ? ` · 当前 ${st.current}` : '');
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
    codex: 'Codex', cursor: 'Cursor', trae: 'Trae', 'deepseek-harness': 'DeepSeek Harness',
    codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy', opencode: 'OpenCode', hermes: 'Hermes', openclaw: 'OpenClaw', pi: 'Pi',
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
            <span><i class="source-chip">${esc(SRC_LABEL[g.source] || g.source)}</i> · ${esc(shortDir(g.dir))}</span>
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
    async 'memory-search'(btn) {
      const q = $('#mem-q');
      const v = q ? q.value.trim() : '';
      if (!v) { pushLocal('warn', '请先输入检索关键词'); if (q) q.focus(); return; }
      MEM.query = v;
      MEM.page = 1;
      MEM.loadedAt = Date.now();
      await loadMemSearch({ mark: true, btn });
    },
    // 「刷新」：
    //   检索模式 → 重跑当前检索词
    //   分层模式 → 概览时刷新计数；已下钻某层时刷新该层当前页
    async 'memory-layers'(btn) {
      if (MEM.mode === 'search') { await actions['memory-search'](btn); return; }
      await loadMemLayers({ mark: true, btn });
    },
    // 「一键上传本地记忆」/「回传历史会话」：打开弹窗，由用户选择范围
    async 'backfill-start'() {
      openUpModal();
    },
    async 'reload-layers'() { await loadOverview(); },
    async 'sess-refresh'() { await refreshSessions(true); pushLocal('info', '已手动刷新会话列表'); },
    async 'guard-ping'() {
      // 守护被手动停止时探活只会得到 ECONNREFUSED，白白刷一条"连接失败"日志。
      // 直接给出可操作结论，不打探。
      if (S.guardEnabled === false) { pushLocal('warn', '守护服务已停止，探活已跳过（点击右上角状态按钮可重新开启）'); return; }
      await refreshDaemon(true);
    },
    async 'agent-refresh'() { await loadAgents(); await refreshAgentCore(); },
    // 「三步接入」折叠：教程只对首次接入有用，接入完成后收起可让首屏直接看到客户端列表。
    // 状态存 S.guideOpen（用户手动切换过就尊重用户选择，不再自动收起）。
    'agent-guide'() { setGuide(!S.guideOpen); },
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
    // 把触发按钮作为第二个参数传进去：动作需要按钮载入态 / 禁用时用得上。
    // 顺手挡住重复点击（连点按钮不会叠加请求）。
    if (t) {
      const act = t.dataset.act;
      if (actions[act]) {
        if (t.disabled) return;
        try { actions[act](t); } catch (err) { pushLocal('err', `操作失败：${(err && err.message) || err}`); }
      }
    }
  });

  // 记忆页：回车即检索
  const memQ = $('#mem-q');
  if (memQ) memQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') actions['memory-search'](); });

  /* 记忆页：模式切换 / 层选择 / 翻页 / 分层下钻
   * 这几组用各自的事件目标，避免和全局 [data-act] 分发器互相干扰。 */
  document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-memmode],[data-pg],[data-layer]') : null;
    if (!el) return;

    // 搜索 / 分层 分段切换
    if (el.dataset.memmode) { setMemMode(el.dataset.memmode); return; }

    // 翻页
    if (el.dataset.pg) {
      const totalPages = Math.max(1, Math.ceil(MEM.total / MEM.perPage));
      const map = { first: 1, prev: MEM.page - 1, next: MEM.page + 1, last: totalPages };
      memGoPage(map[el.dataset.pg]);
      return;
    }

    // 分层下钻：点某一行 → 进入该层明细（服务端分页）
    if (el.dataset.layer) {
      MEM.layer = el.dataset.layer;
      MEM.page = 1;
      // 点分层行本身就意味着要看分层明细，顺带把模式切过去（否则按钮/输入框状态对不上）
      if (MEM.mode !== 'layers') setMemMode('layers', { silent: true, keepLayer: true });
      const lsel = $('#mem-layer');
      if (lsel) lsel.value = MEM.layer;
      loadMemLayers({ mark: true });
    }
  });

  document.addEventListener('keydown', (e) => {
    const row = e.target.closest ? e.target.closest('.mem-lrow[data-layer]') : null;
    if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    row.click();
  });

  const memBack = $('#mem-layer-back');
  if (memBack) memBack.addEventListener('click', () => {
    MEM.layer = '';
    MEM.page = 1;
    setMemMode('layers', { silent: true, keepLayer: true });
    loadMemLayers({ mark: true, btn: $('[data-act="memory-layers"]') });
  });
  const memClear = $('#mem-clear');
  if (memClear) memClear.addEventListener('click', () => {
    const q = $('#mem-q');
    if (q) { q.value = ''; q.focus(); }
    MEM.query = '';
    MEM.layer = '';
    MEM.source = '';
    MEM.page = 1;
    MEM.items = [];
    MEM.total = 0;
    MEM.requestId++;
    setMemoryContext('search', 0, '输入关键词开始检索');
    setMemoryBusy(false);
    const box = $('#mem-out');
    if (box) box.innerHTML = '<div class="empty">输入关键词后回车检索。</div>';
    const ms = $('#mem-source'); if (ms) ms.value = '';
    const mf = $('#mem-layer-filter'); if (mf) mf.value = '';
    renderPager();
  });

  // 层选择器：'' = 全部层（回概览）
  const memLayerSel = $('#mem-layer');
  if (memLayerSel) memLayerSel.addEventListener('change', () => {
    MEM.layer = memLayerSel.value || '';
    MEM.page = 1;
    if (MEM.mode === 'layers') loadMemLayers({ mark: true });
    else if (MEM.query) loadMemSearch({ mark: true });
  });
  function populateMemorySources() {
    const sel = $('#mem-source');
    if (!sel) return;
    const entries = Object.entries(SRC_NAME).filter(([k]) => !k.endsWith('-db') && !k.endsWith('-rollout'));
    sel.innerHTML = '<option value="">全部来源</option>' + entries.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    sel.value = MEM.source || '';
  }
  populateMemorySources();
  const memSourceSel = $('#mem-source');
  if (memSourceSel) memSourceSel.addEventListener('change', () => {
    MEM.source = memSourceSel.value || '';
    MEM.page = 1;
    if (MEM.mode === 'layers' && MEM.layer) loadMemLayers({ mark: true });
    else if (MEM.mode === 'search' && MEM.query) loadMemSearch({ mark: true });
  });
  const memLayerFilter = $('#mem-layer-filter');
  if (memLayerFilter) memLayerFilter.addEventListener('change', () => {
    MEM.layer = memLayerFilter.value || '';
    const layerSel = $('#mem-layer'); if (layerSel) layerSel.value = MEM.layer;
    MEM.page = 1;
    loadMemLayers({ mark: true });
  });

  /* ============================================================
     应用信息
     ============================================================ */
  tdai.appInfo().then((info) => {
    S.appInfo = info;
    if (Array.isArray(info.sources)) info.sources.forEach((x) => { if (x && x.key && x.name) SRC_NAME[x.key] = x.name; });
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

  // 接入结果的「动作」徽章文案。写入/移除/跳过/失败各有固定语义，
  // 未知动作原样显示（新增动作时不至于变成空白）。
  const ACTION_LABEL = {
    '新增': '已开启', '追加': '已开启', '覆盖': '已更新', '新建': '已创建',
    '移除': '已断开', '跳过': '无需改动', '失败': '失败',
  };
  // 跳过原因 → 用户能看懂的一句话（后端返回的是面向开发者/日志的原文）
  function skipReason(detail) {
    const d = String(detail || '');
    if (/未安装/.test(d)) return '未安装该客户端';
    if (/已存在|已是本应用接入|已注册|已在|已写入|已注入|patch 已存在/.test(d)) return '此前已接入';
    if (/无 3 个|无 .* 目录/.test(d)) return '未安装对应客户端';
    if (/无 tdai|配置文件不存在|无 .* 条目/.test(d)) return '本来就没接入';
    if (/无 cordis\.patch/.test(d)) return '未初始化';
    return d || '无需处理';
  }
  // 接入结果明细：动作徽章 + 名称 + 说明 的三列网格。
  // 早先是 `[动作] 目标 — 说明` 的原始拼接（等宽字体、开发者口径的 `/mcp/servers/tdai`
  // 这种路径直接摊给用户），既看不懂也和上方列表对不齐。
  //
  // 「跳过」行的处理：只有**用户会关心**的跳过才显示（例如"此前已接入"）；
  // 纯噪音的（未安装的客户端、本来就没接入）直接不展示 —— 这类信息
  // 上方列表的状态徽章已经表达过了，逐条列出来只会淹没真正的写入动作。
  const SKIP_NOISE = /未安装|无 .* 目录|无 tdai|配置文件不存在|无 .* 条目/;
  function renderAgentResults(results) {
    const log = $('#agent-log');
    if (!log) return;
    const rows = (results || []).filter(Boolean).filter((r) => {
      if (String(r.action) !== '跳过') return true;
      return !SKIP_NOISE.test(String(r.detail || ''));
    });
    if (!rows.length) { log.style.display = 'none'; log.innerHTML = ''; return; }
    log.style.display = 'block';
    log.innerHTML = rows.map((r) => {
      const act = String(r.action || '');
      const cls = act === '失败' ? 'err' : (act === '跳过' ? 'skip' : 'ok');
      const label = ACTION_LABEL[act] || act;
      const detail = act === '跳过' ? skipReason(r.detail) : String(r.detail || '');
      return `<div class="ar-res">
        <span class="arres-act ${cls}">${esc(label)}</span>
        <span class="arres-name" title="${esc(r.target || '')}">${esc(r.target || '')}</span>
        <span class="arres-desc" title="${esc(detail)}">${esc(detail)}</span>
      </div>`;
    }).join('');
  }

  // 开关切换：接入 / 断开单个客户端
  async function toggleAgent(key, enable) {
    const b = $('#b-agent');
    try {
      if (b) { b.className = 'banner show ok'; b.textContent = (enable ? '正在接入 ' : '正在断开 ') + key + '…'; }
      const r = await tdai.agentsToggle(key, enable);
      if (r && r.ok) {
        if (r.items) renderAgentItems(r.items);
        renderAgentResults(r.results);
        // 顶部横幅只报结论，不再把每条明细挤进一行（长到不可读）
        const n = (r.results || []).length;
        if (b) { b.className = 'banner show ok'; b.textContent = (enable ? '已接入 ' : '已断开 ') + key + (n ? `（${n} 项）` : '') + '。'; }
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
    S.agents = Array.isArray(items) ? items : [];
    const filter = ($('#agent-filter') && $('#agent-filter').value) || 'all';
    const shown = S.agents.filter((it) => {
      if (filter === 'capture') return !!(it.injection && it.injection.capture);
      if (filter === 'partial') return it.status === 'installed' && it.effective === false;
      return filter === 'all' || it.status === filter;
    });
    if (!shown.length) { list.innerHTML = '<div class="empty">当前筛选没有客户端</div>'; return; }
    list.innerHTML = shown.map((it) => {
      const absent = it.status === 'absent';
      const on = it.status === 'installed';
      const isInstruction = it.key === 'instructions';
      const kinds = it.injection && Array.isArray(it.injection.kinds) ? it.injection.kinds.join(' / ') : 'mcp';
      const configPath = it.config && it.config.file ? it.config.file : '';
      const readiness = it.status === 'absent' ? '未安装' : (it.effective === false ? '需处理' : (on ? '可用' : '待接入'));
      // 旧路径接入（node.exe）时给切换提示，但开关仍显示"开"（重新点一下即切换到本应用）
      const oldTip = on && it.byApp === false ? '<span class="ar-old">旧接入路径，建议关→开切换</span>' : '';
      return `<div class="agent-row" data-key="${esc(it.key)}">
        <div class="ar-name">
          <b>${esc(it.name)}</b>
          <span class="agent-meta"><i>${esc(it.injection && it.injection.label || kinds)}</i><i>${esc(readiness)}</i>${it.injection && it.injection.capture ? '<i>可采集</i>' : ''}${it.injection && it.injection.requiresRestart ? '<i>需重启客户端</i>' : ''}</span>
          <span title="${esc(configPath)}">${esc(it.detail || '')}${configPath ? ` · ${esc(configPath)}` : ''}${oldTip}</span>
        </div>
        <span class="agent-badge ${esc(it.status || '')}">${esc(STATUS_LABEL[it.status] || it.status)}</span>
        ${isInstruction ? '<span class="muted">由全局指令文件兜底</span>' : `<span class="agent-toggle ${on ? 'on' : ''} ${absent ? 'disabled' : ''}" title="${absent ? '未安装该客户端' : (on ? '点击断开' : '点击接入')}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-disabled="${absent ? 'true' : 'false'}"><span class="sw"></span>${on ? '已接入' : (absent ? '未安装' : '未接入')}</span>`}
      </div>`;
    }).join('');
    // 事件委托：点整行任意处切换
    list.querySelectorAll('.agent-row').forEach((row) => {
      row.addEventListener('click', () => {
        const key = row.dataset.key;
        const it = (items || []).find((x) => x.key === key);
        if (!it || it.status === 'absent' || it.key === 'instructions') return;   // 未安装/说明文件不响应
        toggleAgent(key, it.status !== 'installed');
      });
    });
  }

  // 「三步接入」折叠状态。S.guideOpen 为 null 表示"还没打算过"（让 loadAgents
  // 按是否已接入决定默认值）；用户点过一次后就固定下来，不再被自动改写。
  function setGuide(open) {
    S.guideOpen = !!open;
    const steps = $('#ag-steps');
    const card = $('#ag-guide');
    const btn = $('[data-act="agent-guide"]');
    const note = $('#ag-guide-note');
    if (steps) steps.classList.toggle('hide', !open);
    if (card) card.classList.toggle('collapsed', !open);
    if (note) note.textContent = open ? '首次接入按这三步走' : '已可一键接入，说明已收起';
    if (btn) {
      btn.textContent = open ? '收起说明' : '展开说明';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  async function loadAgents() {
    let items = [];
    try { items = await tdai.agentsStatus(); } catch (_) { items = []; }
    renderAgentItems(items);
    const installed = (items || []).filter((x) => x.key !== 'instructions' && x.status === 'installed').length;
    const total = (items || []).filter((x) => x.key !== 'instructions').length;
    const ac = $('#ag-clients'); if (ac) ac.textContent = `${installed} / ${total}`;
    // 首屏默认：已经接入过就收起教程（用户来这页是看状态，不是看说明）；
    // 一个都没接入（或者是新装的）则展开，因为这时说明才是有用的。
    if (S.guideOpen == null) setGuide(installed === 0);
    const b = $('#b-agent');
    if (b && items && items.length) {
      const missing = items.filter((x) => x.status === 'missing').length;
      if (missing) { b.className = 'banner show warn'; b.textContent = `有 ${missing} 项已安装但未接入：点对应行开关即可（也可点上方「一键接入全部客户端」）。`; }
      else if (installed) { b.className = 'banner show ok'; b.textContent = `已接入 ${installed} 个客户端，可直接使用 tdai 记忆工具。点击任意行可单独断开 / 重连。`; }
      else { b.className = 'banner show warn'; b.textContent = '尚未接入任何客户端：点任意行开关，或点「一键接入全部客户端」。'; }
    }
    return items;
  }

  const agentFilter = $('#agent-filter');
  if (agentFilter) agentFilter.addEventListener('change', () => renderAgentItems(S.agents));

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
      renderAgentResults(results);
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
      // nas 与 auth 现在**会分别成立**（面板活着但 key 错了 = nas true / auth false），
      // 三态分开报，别让用户看到笼统的"连接失败"去乱改地址。
      if (j.nas && j.auth) {
        banner('b-conn', 'ok', `连接成功：面板可达且认证通过（${j.latencyMs}ms）。`);
      } else if (j.nas && !j.auth) {
        banner('b-conn', 'warn', '面板可达，但认证未通过：' + (j.hint || '请检查 User Key / serviceId。'));
      } else {
        banner('b-conn', 'err', '连接失败：' + (j.hint || '面板不可达。'));
      }
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
    s = s || {};
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#up-current', fmt(s.currentVersion));
    const map = {
      idle: '空闲', checking: '检查中…', 'up-to-date': '已是最新',
      available: `有新版本 ${s.latestVersion}`, downloading: `下载中 ${s.percent}%`,
      downloaded: '已下载，待安装', error: '出错',
    };
    set('#up-status', map[s.status] || fmt(s.status));
    const progress = $('#up-progress');
    const pg = progress && progress.querySelector('.update-progress-fill');
    const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
    if (progress) {
      progress.classList.toggle('indeterminate', s.status === 'checking');
      progress.setAttribute('aria-valuenow', String(pct));
      progress.dataset.status = String(s.status || 'idle');
    }
    // 用 transform 驱动整条填充层，而不是依赖 inline width；这样不会被
    // 上传弹窗的同名样式或浏览器重排吞掉视觉变化。
    if (pg) pg.style.setProperty('--progress-scale', String(pct / 100));
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

  /* ---------- 启动 ----------
   * ⚠️ 必须先等偏好加载完再渲染总览。
   * `S.guardEnabled` 的初值是 true，真实值由异步的 prefsLoad() 回填；
   * 早先这里同步直跑 onHomeShown()，于是"守护已停止"的用户在首帧会看到
   * 守护卡片走了一遍"运行中/超时"的逻辑（顶部「守护探活」被写成"超时"且不再纠正，
   * 「运行时长」也开始走秒），看起来就像守护还在跑。
   * 现在把首屏渲染挂到偏好就绪之后，从第一帧起就是正确的停止态。
   *
   * ⚠️ 并且**不能无条件重跑 onHomeShown()**：偏好加载是异步的，用户完全可能在
   * 它完成之前就点了 Agent / 记忆 等 tab（冷启动时很容易命中）。
   * 若这里不管当前页照跑总览初始化，就会出现"tab 高亮在 Agent、页面却显示总览"
   * —— 而 onHomeShown() 还会顺手把 home 页的会话刷新重新拉起来。
   * 所以：只有当用户**确实还停在总览页**时才跑首屏渲染。
   */
  const activeTab = () => {
    const b = $('#tabs button.active');
    return (b && b.dataset.tab) || 'home';
  };
  prefsReady.catch(() => { }).then(() => {
    if (activeTab() !== 'home') return;   // 用户已切走，首屏总览渲染让位
    onHomeShown();
    loadOverview();
  });
})();
