// pet.js — 宠物运行时
// 造型：三层等轴菱形堆叠(呼应 logo)。每层 = 一条呼吸圣环。
// 状态：online / offline / thinking / alert
/* global tdai */
(function () {
  'use strict';

  const stage = document.getElementById('stage');
  const petBox = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  const dot = document.getElementById('dot');

  /* ---------- Canvas ---------- */
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  petBox.appendChild(canvas);

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = stage.clientWidth; H = stage.clientHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);

  /* ---------- 状态机 ---------- */
  const S = {
    mode: 'boot',           // boot | online | offline | thinking | alert
    lastMode: 'boot',
    t: 0,                    // 累计时间(秒)
    breathePhase: 0,         // 呼吸相位
    blinkAt: 2.2,            // 下次眨眼时间
    blinkAmt: 0,             // 0..1 (1 = 完全闭上)
    glanceX: 0, glanceY: 0,  // 视线
    mx: 0.5, my: 0.5,        // 归一化鼠标
    message: null,           // {who, txt, until}
    latencyMs: 0,
    hit: false,              // 刚被拍
    hitAmt: 0,
  };

  function setMode(m) { if (S.mode !== m) { S.lastMode = S.mode; S.mode = m; } }

  /* ---------- 事件 ---------- */
  if (window.tdai) {
    tdai.getHealth().then(applyHealth);
    tdai.on('health', ({ payload }) => applyHealth(payload));
  }
  function applyHealth(h) {
    S.latencyMs = h.latencyMs || 0;
    setMode(h.ok ? 'online' : 'offline');
    dot.className = h.ok ? 'on' : 'err';
  }

  stage.addEventListener('mousemove', (e) => {
    const r = stage.getBoundingClientRect();
    S.mx = (e.clientX - r.left) / r.width;
    S.my = (e.clientY - r.top) / r.height;
  });
  stage.addEventListener('mouseleave', () => { S.mx = 0.5; S.my = 0.5; });

  // 拖拽移动 + 轻拍
  let dragInfo = null;
  stage.addEventListener('mousedown', (e) => {
    dragInfo = { x: e.screenX, y: e.screenY, t: performance.now(), moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragInfo) return;
    const dx = e.screenX - dragInfo.x, dy = e.screenY - dragInfo.y;
    if (!dragInfo.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) dragInfo.moved = true;
    if (dragInfo.moved && window.tdai && dragInfo.winx != null) {
      // 通过 screenX 估算移动窗口：tdai 没有 move API,用 DOM 眨眼 hint。主进程负责 moved 保存。
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragInfo) return;
    if (!dragInfo.moved && performance.now() - dragInfo.t < 300) {
      // 轻拍
      S.hit = true; S.hitAmt = 1;
      say(['嗯？', '在呢', '看记忆呢', '别拍我～', '已连接'][Math.floor(Math.random() * 5)]);
    }
    if (dragInfo.moved && window.tdai) {
      // 拖动结束:通过 IPC 没有 move 接口,简单做法——直接改 screen 位置不行。让 HTML5 拖拽 native 拖动?这里退一步:用 CSS 固定位置无效。
      // 改走:发送自定义协议给主进程移动窗口。
    }
    dragInfo = null;
  });

  // 双击打开 console
  stage.addEventListener('dblclick', () => { if (window.tdai) tdai.openConsole(); });

  document.getElementById('btn-console').addEventListener('click', () => window.tdai && tdai.openConsole());
  document.getElementById('btn-ping').addEventListener('click', async () => {
    if (!window.tdai) return;
    setMode('thinking');
    say('探一下记忆…', 1800);
    const h = await tdai.refresh();
    applyHealth(h);
  });

  /* ---------- 说话 ---------- */
  const whoEl = bubble.querySelector('.who');
  const txtEl = bubble.querySelector('.txt');
  function say(txt, ms) {
    whoEl.textContent = 'MEMO';
    txtEl.textContent = txt;
    bubble.classList.add('show');
    clearTimeout(say._t);
    say._t = setTimeout(() => bubble.classList.remove('show'), ms || 2400);
  }

  /* ---------- 渲染 ---------- */

  const LAYERS = [
    // 从下往上:底层(灰) 中层(浅) 顶层(珊瑚)
    { color: [124, 124, 132], y: 62,  w: 96, h: 46, amp: 1.0, phase: 0.0,  alpha: 0.55 },
    { color: [200, 200, 207], y: 38,  w: 110, h: 52, amp: 1.3, phase: 1.2, alpha: 0.85 },
    { color: [255, 81, 57],   y: 12,  w: 122, h: 58, amp: 1.7, phase: 2.4, alpha: 1.0 },
  ];
  // 瞳仁(顶层菱心) — 视觉锚点
  const EYE = { rBase: 8 };

  function drawDiamond(c, cx, cy, w, h, fill, alpha, stroke) {
    c.beginPath();
    c.moveTo(cx, cy - h / 2);
    c.lineTo(cx + w / 2, cy);
    c.lineTo(cx, cy + h / 2);
    c.lineTo(cx - w / 2, cy);
    c.closePath();
    if (fill) {
      c.globalAlpha = alpha;
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.globalAlpha = Math.min(1, alpha + 0.15);
      c.strokeStyle = stroke;
      c.lineWidth = 1;
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  function drawEye(c, cx, cy, gazeX, gazeY, scale, blink, mode) {
    const r = EYE.rBase * scale;
    const openness = 1 - blink;
    const h = r * 2 * Math.max(0.04, openness);
    // 底
    c.beginPath();
    c.ellipse(cx, cy, r * 1.15, h / 2 * 1.15, 0, 0, Math.PI * 2);
    c.fillStyle = 'rgba(8,8,10,0.85)';
    c.fill();
    // 瞳孔
    const px = cx + gazeX * r * 0.55;
    const py = cy + gazeY * h * 0.3;
    c.beginPath();
    c.ellipse(px, py, r * 0.55, Math.max(0.6, h * 0.3), 0, 0, Math.PI * 2);
    c.fillStyle = mode === 'offline' ? 'rgba(120,120,128,.85)' : 'rgba(255,238,232,.95)';
    c.fill();
    // 高光
    c.beginPath();
    c.ellipse(px - r * 0.2, py - r * 0.18, r * 0.16, r * 0.12, 0, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,.85)';
    c.fill();
  }

  function drawGlow(c, cx, cy, radius, color, intensity) {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${intensity})`);
    g.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    c.fillStyle = g;
    c.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  let prevTs = performance.now();
  function frame(ts) {
    const dt = Math.min(0.05, (ts - prevTs) / 1000); prevTs = ts;
    S.t += dt;
    S.breathePhase += dt * (S.mode === 'thinking' ? 3.2 : S.mode === 'offline' ? 0.7 : 1.4);
    S.hitAmt = Math.max(0, S.hitAmt - dt * 4);

    // 眨眼
    if (S.t >= S.blinkAt) { S.blinkAt = S.t + 1.6 + Math.random() * 3.2; S._blinkStart = S.t; }
    const blinkT = S._blinkStart ? (S.t - S._blinkStart) : Infinity;
    S.blinkAmt = blinkT < 0.18 ? Math.sin((blinkT / 0.18) * Math.PI) : 0;

    // 视线缓动
    const wantX = (S.mx - 0.5) * 2, wantY = (S.my - 0.5) * 2;
    S.glanceX += (wantX - S.glanceX) * 0.08;
    S.glanceY += (wantY - S.glanceY) * 0.08;

    // 清屏
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 - 4 + Math.sin(S.breathePhase * 0.5) * 1.5;
    const unit = Math.min(W, H) / 160; // 尺度
    const hitSquash = 1 - S.hitAmt * 0.12;

    // 底光
    const glow = S.mode === 'online' ? [255, 81, 57] : S.mode === 'offline' ? [100, 100, 108] : [255, 150, 120];
    drawGlow(ctx, cx, cy + 18 * unit, 58 * unit, glow, S.mode === 'online' ? 0.22 : 0.1);

    // 三层菱形,自下而上
    for (let i = 0; i < LAYERS.length; i++) {
      const L = LAYERS[i];
      const breathe = Math.sin(S.breathePhase + L.phase) * L.amp * unit * 1.2;
      const wTilt = 1 + Math.sin(S.breathePhase * 0.6 + L.phase) * 0.005;
      const ly = cy + L.y * unit + breathe;
      const lw = L.w * unit * wTilt * hitSquash;
      const lh = L.h * unit * hitSquash;
      const col = `rgb(${L.color[0]},${L.color[1]},${L.color[2]})`;
      const alpha = S.mode === 'offline' ? L.alpha * 0.4 : L.alpha;

      // 阴影先画(下一层的影响)
      if (i === 0) {
        ctx.beginPath();
        ctx.ellipse(cx, cy + 30 * unit, lw * 0.32, 4 * unit, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,.32)';
        ctx.fill();
      }

      // 立体厚度感:画一层稍暗偏下的菱形做底
      drawDiamond(ctx, cx, ly + 3.5 * unit, lw, lh, shade(col, 0.55), alpha * 0.95);
      // 主面
      drawDiamond(ctx, cx, ly, lw, lh, col, alpha, S.mode === 'offline' ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.1)');
    }

    // 顶层瞳仁(被注视的中心)
    const eyeScale = unit * (S.mode === 'thinking' ? 1.1 : 1);
    drawEye(
      ctx,
      cx,
      cy + LAYERS[2].y * unit - 4 * unit,
      S.glanceX, S.glanceY,
      eyeScale,
      S.blinkAmt * (1 - S.hitAmt),
      S.mode
    );

    // 离线时叠加一点噪波线
    if (S.mode === 'offline') {
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      for (let i = 0; i < 3; i++) {
        const yy = cy - 50 * unit + i * 40 * unit + Math.sin(S.t * 2 + i) * 2;
        ctx.fillRect(cx - 80 * unit, yy, 160 * unit, 1);
      }
    }

    requestAnimationFrame(frame);
  }

  function shade(rgb, k) {
    const m = rgb.match(/\d+/g);
    return `rgb(${Math.floor(m[0] * k)},${Math.floor(m[1] * k)},${Math.floor(m[2] * k)})`;
  }

  /* ---------- 启动 ---------- */
  resize();
  requestAnimationFrame(frame);

  // 定时碎嘴
  const CHATTERS = [
    '在听记忆里…', '层与层在呼吸', '8125 还连着', '今天有新记忆吗',
    '帮我记下这个', 'L1 抽取跑得飞快', 'memory_online',
  ];
  function chatterLoop() {
    if (S.mode === 'online' && Math.random() < 0.6) {
      say(CHATTERS[Math.floor(Math.random() * CHATTERS.length)]);
    }
    setTimeout(chatterLoop, 26000 + Math.random() * 30000);
  }
  setTimeout(chatterLoop, 9000);
})();
