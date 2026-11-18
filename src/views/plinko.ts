// Plinko: the ball bounces down `rows` rows of pegs; each bounce is one provably fair float.
import { state, debit, credit, round2, debitError } from '../state.js';
import { bet, annotate, plinkoTable, plinkoPath } from '../fair.js';
import type { Risk } from '../types.js';
import { pushBet } from '../feed.js';
import { $, $$, fmt, money, icon, toast, amountField, wireAmount } from '../ui.js';
import { sfx } from '../sfx.js';

const SEG_MS = 240;        // slower, weightier drop (was 105)

export function render(el) {
  let rows = 12, risk: Risk = 'normal', alive = true, raf = 0;
  const balls = [];        // { path, start, amount, mult, bucket, done }
  const hits = new Map();  // peg key -> time of last hit (for glow)

  el.innerHTML = `
    <div class="page-head"><h1>${icon('plinko')} Plinko</h1><p class="muted">Drop balls through the pegs. Edges pay the most, the middle the least. 97% return to player.</p></div>
    <div class="game-layout">
      <div class="panel controls">
        ${amountField('amt', 1)}
        <div class="field"><label>Risk</label><div class="seg" id="risk"><button data-r="low">Low</button><button data-r="normal" class="active">Normal</button><button data-r="high">High</button></div></div>
        <div class="field"><label>Rows</label><div class="seg wrap" id="rows">${[8, 10, 12, 14, 16].map(n => `<button data-n="${n}" class="${n === 12 ? 'active' : ''}">${n}</button>`).join('')}</div></div>
        <div class="field"><label for="balls">Balls per drop: <b id="ballsV">1</b></label><input id="balls" type="range" min="1" max="10" value="1"></div>
        <div class="muted small" style="margin-bottom:10px">Total bet <b id="total"></b></div>
        <button class="btn btn-primary btn-lg block" id="drop" data-needs-auth="bet">Drop ball</button>
      </div>
      <div class="panel plinko-stage">
        <canvas id="cv"></canvas>
        <div class="buckets" id="buckets"></div>
      </div>
    </div>`;

  const amt = $('#amt', el), cv = $('#cv', el), ctx = cv.getContext('2d');
  let W = 0, H = 0;
  const geo = () => {
    const sx = Math.min(44, (W * 0.94) / (rows + 1));
    const sy = Math.min(sx * 0.92, (H - 30) / (rows + 0.6));
    return { sx, sy, cx: W / 2, top: 22 };
  };

  const drawBuckets = () => {
    const t = plinkoTable(rows, risk);
    const max = Math.max(...t);
    const { sx } = geo();
    $('#buckets', el).style.gridTemplateColumns = `repeat(${rows + 1}, ${sx - 3}px)`;
    $('#buckets', el).innerHTML = t.map((m, i) => {
      const heat = Math.log(Math.max(m, 0.2) / 0.2) / Math.log(max / 0.2);
      return `<div class="bucket" data-i="${i}" style="--heat:${heat.toFixed(3)}">${m >= 100 ? Math.round(m) : m}×</div>`;
    }).join('');
  };
  const drawTotal = () => { $('#total', el).innerHTML = money(round2((+amt.value || 0) * +$('#balls', el).value)); };

  const resize = () => {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBuckets();
  };
  const ro = new ResizeObserver(resize); ro.observe(cv); resize();

  wireAmount(el, amt, () => state.balance, drawTotal);
  $('#balls', el).oninput = e => { $('#ballsV', el).textContent = e.target.value; drawTotal(); };
  const lockable = () => balls.some(b => !b.done);
  $$('#risk button', el).forEach(b => b.onclick = () => { if (lockable()) return toast('Wait for the balls to land', 'error'); risk = b.dataset.r; $$('#risk button', el).forEach(x => x.classList.toggle('active', x === b)); drawBuckets(); });
  $$('#rows button', el).forEach(b => b.onclick = () => { if (lockable()) return toast('Wait for the balls to land', 'error'); rows = +b.dataset.n; $$('#rows button', el).forEach(x => x.classList.toggle('active', x === b)); drawBuckets(); });

  /** Ball position at time t along its path. */
  const posAt = (ball: any, now: number): { x: number; y: number; seg?: number; k?: number; hop?: number } => {
    const { sx, sy, cx, top } = geo();
    const n = ball.path.length;
    const tt = (now - ball.start) / SEG_MS;
    const seg = Math.min(Math.floor(tt), n);
    const k = Math.min(1, tt - seg);
    const rightsBefore = j => ball.path.slice(0, j).reduce((a, b) => a + b, 0);
    const pt = j => {
      if (j < 0) return { x: cx, y: top - sy * 0.9 };
      if (j >= n) return { x: cx + (rightsBefore(n) - n / 2) * sx, y: top + n * sy + 6 };
      return { x: cx + (rightsBefore(j) - j / 2) * sx, y: top + j * sy - 9 };
    };
    if (tt < 0) return pt(-1);
    const a = pt(seg - 1), b = pt(seg);
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k * k - Math.sin(Math.PI * k) * sy * 0.35;
    return { x, y, seg, k, hop: Math.sin(Math.PI * k) };
  };

  const frame = now => {
    if (!alive) return;
    const { sx, sy, cx, top } = geo();
    ctx.clearRect(0, 0, W, H);
    // pegs
    for (let i = 0; i < rows; i++) {
      for (let k = 0; k < i + 3; k++) {
        const x = cx + (k - 1 - i / 2) * sx, y = top + i * sy;
        const hit = hits.get(`${i}-${k}`);
        const glow = hit ? Math.max(0, 1 - (now - hit) / 300) : 0;
        ctx.beginPath(); ctx.arc(x, y, 3.2 + glow * 2, 0, Math.PI * 2);
        ctx.fillStyle = glow ? `rgba(198,255,61,${0.5 + glow * 0.5})` : 'rgba(230,236,250,.75)';
        if (glow) { ctx.shadowColor = '#c6ff3d'; ctx.shadowBlur = 12 * glow; }
        ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    // balls
    for (const ball of balls) {
      if (ball.done) continue;
      const p = posAt(ball, now);
      if (p.seg !== ball.lastSeg && p.seg >= 1 && p.seg <= ball.path.length) {
        const i = p.seg - 1;
        const rights = ball.path.slice(0, i).reduce((a, b) => a + b, 0);
        hits.set(`${i}-${rights + 1}`, now);
        if (ball.sound) sfx.tick();
      }
      ball.lastSeg = p.seg;
      if (now - ball.start >= (ball.path.length + 1) * SEG_MS) { land(ball); continue; }
      (ball.trail ||= []).push({ x: p.x, y: p.y }); if (ball.trail.length > 12) ball.trail.shift();
      // fading trail
      (ball.trail || []).forEach((t, i, arr) => {
        const f = (i + 1) / arr.length;
        ctx.beginPath(); ctx.arc(t.x, t.y, 2 + f * 5, 0, Math.PI * 2); ctx.fillStyle = `rgba(255,178,31,${f * 0.16})`; ctx.fill();
      });
      // shadow on the board, offset down-right; shrinks as the ball hops up
      const air = Math.max(0, (p.hop || 0));
      ctx.fillStyle = `rgba(0,0,0,${0.42 - air * 0.18})`;
      ctx.beginPath(); ctx.ellipse(p.x + 4 + air * 8, p.y + 11 + air * 6, 9 - air * 2, 4.5 - air, 0, 0, Math.PI * 2); ctx.fill();
      // the ball: lit sphere with a specular dot and a warm rim
      const R = 9 + air * 1.2;
      const bg = ctx.createRadialGradient(p.x - R * 0.38, p.y - R * 0.42, 1, p.x, p.y, R * 1.1);
      bg.addColorStop(0, '#fffdf0'); bg.addColorStop(0.28, '#ffe38a'); bg.addColorStop(0.7, '#ff9f1c'); bg.addColorStop(1, '#a84f00');
      ctx.shadowColor = 'rgba(255,170,30,.85)'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill(); ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(p.x - R * 0.36, p.y - R * 0.4, R * 0.22, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill();
    }
    for (let i = balls.length - 1; i >= 0; i--) if (balls[i].done) balls.splice(i, 1);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  function land(ball) {
    ball.done = true;
    const payout = round2(ball.amount * ball.mult);
    if (payout > 0) credit(payout);
    const bk = $(`.bucket[data-i="${ball.bucket}"]`, el);
    if (bk) { bk.classList.remove('hit'); void bk.offsetWidth; bk.classList.add('hit'); }
    if (ball.mult >= 2) sfx.win(); else sfx.click();
    pushBet({ user: state.name, game: 'Plinko', amount: ball.amount, multi: ball.mult, payout, mine: true });
  }

  $('#drop', el).onclick = async () => {
    const amount = round2(+amt.value);
    const n = +$('#balls', el).value;
    if (!(amount >= 0.1)) return toast('Minimum bet is 0.10', 'error');
    for (let i = 0; i < n; i++) {
      if (!debit(amount)) { toast(debitError(amount), 'error'); break; }
      const { floats, entry } = await bet('plinko', rows, { rows, risk });
      const path = plinkoPath(floats, rows);
      const bucket = path.reduce((a, b) => a + b, 0);
      const mult = plinkoTable(rows, risk)[bucket];
      annotate(entry, `${rows} rows ${risk}: bucket ${bucket} → ${fmt(mult)}×`, path.map(x => (x ? 'R' : 'L')).join(''));
      if (!alive) return;
      balls.push({ path, start: performance.now(), amount, mult, bucket, sound: i === 0, lastSeg: -1, trail: [] });
      if (i < n - 1) await new Promise(r => setTimeout(r, 320));
    }
  };

  drawTotal();
  // Balls still falling when you leave are paid out immediately.
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); balls.filter(b => !b.done).forEach(b => { b.done = true; const p = round2(b.amount * b.mult); if (p > 0) credit(p); pushBet({ user: state.name, game: 'Plinko', amount: b.amount, multi: b.mult, payout: p, mine: true }); }); };
}
