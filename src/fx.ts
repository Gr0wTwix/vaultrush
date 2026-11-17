// Canvas particle effects (explosions, sparkles) layered over a host element.
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const ease = k => 1 - (1 - k) ** 3;

export function createFx(host) {
  const cv = document.createElement('canvas');
  cv.className = 'fx-layer';
  host.append(cv);
  const ctx = cv.getContext('2d');
  const parts = [];
  let raf = 0, last = 0, W = 0, H = 0;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const add = p => parts.push({ age: 0, delay: 0, vx: 0, vy: 0, g: 0, drag: 0, rot: 0, vr: 0, ...p });

  function draw(p, k) {
    const { x, y } = p;
    ctx.globalCompositeOperation = p.kind === 'smoke' || p.kind === 'debris' ? 'source-over' : 'lighter';
    switch (p.kind) {
      case 'flash': {
        const r = p.size * (0.6 + k * 0.8);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,240,${1 - k})`);
        g.addColorStop(0.4, `rgba(255,200,120,${(1 - k) * 0.7})`);
        g.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'fire': {
        const r = p.size * (0.35 + ease(k) * 0.9), a = (1 - k) ** 1.4;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,250,220,${a})`);
        g.addColorStop(0.3, `rgba(255,190,70,${a * 0.9})`);
        g.addColorStop(0.65, `rgba(230,70,20,${a * 0.6})`);
        g.addColorStop(1, 'rgba(120,20,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'ring': {
        ctx.strokeStyle = p.color.replace('A', (1 - k) * 0.85);
        ctx.lineWidth = p.w * (1 - k) + 0.5;
        ctx.beginPath(); ctx.arc(x, y, p.size * ease(k), 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'spark': {
        ctx.strokeStyle = p.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = p.size * (1 - k * 0.5); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - p.vx * 0.03, y - p.vy * 0.03); ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case 'ember': {
        const a = (1 - k) * (0.6 + Math.random() * 0.4);
        ctx.fillStyle = `rgba(255,${140 + Math.floor(Math.random() * 60)},50,${a})`;
        ctx.beginPath(); ctx.arc(x, y, p.size * (1 - k * 0.6), 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'debris': {
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot); ctx.globalAlpha = 1 - k ** 3;
        ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
        break;
      }
      case 'smoke': {
        const r = p.size * (0.5 + k * 1.3), a = 0.34 * Math.sin(Math.PI * Math.min(1, k * 1.15));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(70,66,72,${a})`); g.addColorStop(1, 'rgba(40,40,48,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'glint': {
        const s = p.size * Math.sin(Math.PI * k);
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.22 : s; const a = (i * Math.PI) / 4; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        ctx.closePath(); ctx.fill(); ctx.restore();
        break;
      }
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { parts.splice(i, 1); continue; }
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp; p.vy = p.vy * damp + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    }
    // Draw oldest first so newer flashes sit on top of smoke.
    for (const p of parts) if (p.delay <= 0) draw(p, p.age / p.life);
    ctx.globalCompositeOperation = 'source-over';
    raf = parts.length ? requestAnimationFrame(frame) : 0;
    if (!raf) ctx.clearRect(0, 0, W, H);
  }
  const run = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; parts.length = 0; ctx.clearRect(0, 0, W, H); };
  // A hidden tab pauses animation frames, which would leave the last frame of a blast frozen on the canvas: drop the effect instead.
  const onVis = () => { if (document.hidden) stop(); };
  document.addEventListener('visibilitychange', onVis);

  /** Position of an element's centre inside the effects canvas. Call it while the element is at rest: a mid-flip tile reports a skewed box. */
  const centerOf = el => {
    const a = el.getBoundingClientRect(), c = cv.getBoundingClientRect();
    return { x: a.left + a.width / 2 - c.left, y: a.top + a.height / 2 - c.top, s: Math.min(1.35, a.width / 80) };
  };

  function explode(x, y, s = 1) {
    // Tuned to be quick and punchy: the whole blast is over in well under a second.
    for (let i = 0; i < 10; i++) add({ kind: 'smoke', x: x + rand(-14, 14) * s, y: y + rand(-10, 10) * s, delay: rand(0.03, 0.1), life: rand(0.7, 1.1), size: rand(24, 42) * s, vx: rand(-60, 60) * s, vy: -rand(40, 110) * s, drag: 1.2 });
    for (let i = 0; i < 18; i++) {
      const a = rand(0, Math.PI * 2), v = rand(320, 820) * s;
      add({ kind: 'debris', x, y, life: rand(0.5, 0.8), size: rand(3, 7) * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 260 * s, g: 2200 * s, drag: 0.6, vr: rand(-16, 16), color: pick(['#2a2f3d', '#3b4254', '#1a1d26', '#5a4030']) });
    }
    add({ kind: 'flash', x, y, life: 0.14, size: 130 * s });
    for (let i = 0; i < 5; i++) add({ kind: 'fire', x: x + rand(-12, 12) * s, y: y + rand(-12, 12) * s, delay: i * 0.012, life: rand(0.28, 0.45), size: rand(55, 85) * s, vx: rand(-50, 50) * s, vy: -rand(20, 80) * s, drag: 2 });
    add({ kind: 'ring', x, y, life: 0.28, size: 160 * s, w: 10 * s, color: 'rgba(255,225,170,A)' });
    add({ kind: 'ring', x, y, life: 0.42, size: 240 * s, w: 5 * s, delay: 0.03, color: 'rgba(255,160,90,A)' });
    for (let i = 0; i < 46; i++) {
      const a = rand(0, Math.PI * 2), v = rand(500, 1400) * s;
      add({ kind: 'spark', x, y, life: rand(0.22, 0.5), size: rand(1.5, 3) * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 1200 * s, drag: 2.4, color: pick(['#fff3c4', '#ffd36b', '#ff9a3c']) });
    }
    for (let i = 0; i < 22; i++) {
      const a = rand(0, Math.PI * 2), v = rand(120, 400) * s;
      add({ kind: 'ember', x, y, delay: rand(0, 0.06), life: rand(0.45, 0.8), size: rand(1.5, 3.5) * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 100 * s, g: 400 * s, drag: 1.6 });
    }
    run();
  }

  function sparkle(x, y, s = 1, color = '#c6ff3d') {
    add({ kind: 'ring', x, y, life: 0.35, size: 48 * s, w: 4 * s, color: 'rgba(198,255,61,A)' });
    for (let i = 0; i < 16; i++) {
      const a = rand(0, Math.PI * 2), v = rand(120, 420) * s;
      add({ kind: 'spark', x, y, life: rand(0.3, 0.6), size: rand(1.2, 2.4) * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 300 * s, drag: 3, color: Math.random() < 0.5 ? color : '#ffffff' });
    }
    for (let i = 0; i < 3; i++) add({ kind: 'glint', x: x + rand(-20, 20) * s, y: y + rand(-20, 20) * s, delay: i * 0.08, life: rand(0.45, 0.7), size: rand(6, 11) * s, vy: -20 * s, rot: rand(0, 1), vr: 2, color: '#ffffff' });
    run();
  }

  return {
    explode, sparkle, centerOf,
    destroy() { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); ro.disconnect(); cv.remove(); parts.length = 0; },
  };
}
