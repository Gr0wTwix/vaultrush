import { randomBot } from '../data.js';
import { state, debit, credit, round2, debitError } from '../state.js';
import { bet, crashPoint, annotate } from '../fair.js';
import { pushBet } from '../feed.js';
import { $, $$, esc, fmt, money, icon, avatar, toast, amountField, wireAmount } from '../ui.js';
import { sfx } from '../sfx.js';

const GROWTH = 0.00012;                 // multiplier = e^(GROWTH * ms)
const WAIT_MS = 7000, AFTER_MS = 3500;
const history = [];

export function render(el) {
  let alive = true, raf = 0, timer = 0;   // timers use window.setTimeout so the handle is a number
  let phase = 'waiting', phaseStart = performance.now(), cp = 1, players = [];
  // myBet: { amount, riding, locked, auto, done, cashouts: [mult] } — partial cashouts lock part of the bet.
  let myBet = null, queued = null, part = 1;

  el.innerHTML = `
    <div class="page-head"><h1>${icon('crash')} Crash</h1></div>
    <div class="crash-layout">
      <div class="panel controls">
        ${amountField('amt', 1)}
        <div class="field"><label>Auto cash-out</label><div class="amount"><input id="auto" type="number" min="1.01" step="0.01" placeholder="Off"><button data-q="1.5">1.5×</button><button data-q="2">2×</button><button data-q="10">10×</button></div></div>
        <div class="field"><label>Cash out share</label><div class="seg" id="part">${[[0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, 'All']].map(([v, l]) => `<button data-p="${v}" class="${v === 1 ? 'active' : ''}">${l}</button>`).join('')}</div></div>
        <button class="btn btn-primary btn-lg block" id="actBtn">Place bet</button>
        <div class="muted small center" id="hint">Round starts in a few seconds</div>
      </div>
      <div class="crash-stage panel">
        <div class="history" id="hist"></div>
        <div class="canvas-wrap"><canvas id="cv"></canvas><div class="crash-mult" id="mult"></div></div>
      </div>
      <div class="panel players">
        <div class="panel-head"><h2>Players</h2><span class="muted small" id="pcount"></span></div>
        <div id="plist" class="plist"></div>
      </div>
    </div>`;

  const cv = $('#cv', el), ctx = cv.getContext('2d');
  const multEl = $('#mult', el), act = $('#actBtn', el), hint = $('#hint', el);
  const amt = $('#amt', el), auto = $('#auto', el);
  wireAmount(el, amt, () => state.balance);
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { auto.value = b.dataset.q; });
  $$('#part button', el).forEach(b => b.onclick = () => { part = +b.dataset.p; $$('#part button', el).forEach(x => x.classList.toggle('active', x === b)); updateButton(); });

  const multAt = t => Math.pow(Math.E, GROWTH * t);
  const elapsed = () => performance.now() - phaseStart;

  const drawHistory = () => {
    $('#hist', el).innerHTML = history.slice(0, 14).map(v => `<span class="hpill ${v >= 2 ? (v >= 10 ? 'h-gold' : 'h-good') : 'h-bad'}">${fmt(v)}×</span>`).join('') || '<span class="muted small">No rounds yet</span>';
  };

  const drawPlayers = () => {
    const me = myBet ? [{ name: state.name, amount: myBet.amount, me: true, bet: myBet }] : [];
    const all = [...me, ...players];
    $('#pcount', el).textContent = `${all.length} playing`;
    $('#plist', el).innerHTML = all.map(p => {
      let status;
      if (p.me) {
        const b = p.bet;
        const parts = b.cashouts.length ? `${b.cashouts.map(m => `${fmt(m)}×`).join(' · ')} → +${fmt(b.locked)}` : '';
        status = b.done ? (b.locked ? `<span class="pos">${parts}</span>` : '<span class="neg">busted</span>')
          : phase === 'crashed' ? `<span class="neg">busted${b.locked ? ` · kept ${fmt(b.locked)}` : ''}</span>`
          : `<span class="muted">${parts || 'playing'}${b.riding < b.amount && !b.done ? ` · ${fmt(b.riding)} riding` : ''}</span>`;
      } else status = p.cashed ? `<span class="pos">${fmt(p.cashed)}× · +${fmt(round2(p.amount * p.cashed))}</span>` : phase === 'crashed' ? '<span class="neg">busted</span>' : '<span class="muted">playing</span>';
      return `<div class="prow ${p.me ? 'mine' : ''}">${avatar(p.name, 24)}<span class="pname">${esc(p.name)}</span>${money(p.amount)}<span class="pstat">${status}</span></div>`;
    }).join('');
  };

  const live = () => myBet && !myBet.done;
  const updateButton = () => {
    if (phase === 'running' && live()) {
      act.className = 'btn btn-cash btn-lg block';
      act.innerHTML = `Cash out ${part < 1 ? `${part * 100}% ` : ''}${money(round2(myBet.riding * part * multAt(elapsed())))}`;
      act.disabled = false;
    } else if (phase === 'waiting' && myBet) {
      act.className = 'btn btn-ghost btn-lg block'; act.textContent = 'Cancel bet'; act.disabled = false;
    } else if (queued) {
      act.className = 'btn btn-ghost btn-lg block'; act.textContent = 'Cancel (next round)'; act.disabled = false;
    } else {
      act.className = 'btn btn-primary btn-lg block'; act.textContent = phase === 'waiting' ? 'Place bet' : 'Bet next round'; act.disabled = false;
    }
  };

  /** Cash out `frac` of what is still riding at multiplier m. */
  const cashOut = (m, frac) => {
    if (!live()) return;
    const mult = Math.floor(m * 100) / 100;
    let take = round2(myBet.riding * frac);
    if (frac >= 1 || myBet.riding - take < 0.01 || myBet.cashouts.length >= 7) take = myBet.riding;
    const got = round2(take * mult);
    myBet.riding = round2(myBet.riding - take);
    myBet.locked = round2(myBet.locked + got);
    myBet.cashouts.push(mult);
    credit(got); sfx.win();
    toast(`Cashed out ${take < myBet.amount || myBet.cashouts.length > 1 ? `${fmt(take)} ` : ''}at ${fmt(mult)}×: +${fmt(got)}`, 'win');
    if (myBet.riding <= 0) finish();
    drawPlayers(); updateButton();
  };

  const finish = () => {
    myBet.done = true;
    pushBet({ user: state.name, game: 'Crash', amount: myBet.amount, multi: round2(myBet.locked / myBet.amount), payout: myBet.locked, mine: true });
  };

  act.onclick = () => {
    if (phase === 'running' && live()) return cashOut(multAt(elapsed()), part);
    if (phase === 'waiting' && myBet) { credit(myBet.amount); myBet = null; drawPlayers(); return updateButton(); }
    if (queued) { queued = null; return updateButton(); }
    const amount = round2(+amt.value);
    if (!(amount >= 0.1)) return toast('Minimum bet is 0.10', 'error');
    const autoV = +auto.value >= 1.01 ? +auto.value : null;
    if (phase === 'waiting') {
      if (!debit(amount)) return toast(debitError(amount), 'error');
      myBet = { amount, riding: amount, locked: 0, auto: autoV, done: false, cashouts: [] }; sfx.click(); drawPlayers();
    } else queued = { amount, auto: autoV };
    updateButton();
  };

  const startWaiting = () => {
    phase = 'waiting'; phaseStart = performance.now();
    myBet = null;
    if (queued) {
      if (debit(queued.amount)) myBet = { amount: queued.amount, riding: queued.amount, locked: 0, auto: queued.auto, done: false, cashouts: [] };
      else toast(debitError(queued.amount), 'error');
      queued = null;
    }
    players = Array.from({ length: 3 + Math.floor(Math.random() * 6) }, () => ({
      name: randomBot(), amount: round2(Math.exp(Math.random() * 5 - 1)), target: round2(1.1 + Math.pow(Math.random(), 2) * 8), cashed: null,
    }));
    drawPlayers(); updateButton();
    // Crash point is fixed by the provably fair roll before the round starts.
    bet('crash', 1).then(({ floats, entry }) => { cp = crashPoint(floats[0]); annotate(entry, `crashed at ${fmt(cp)}×`, cp.toFixed(2)); });
    timer = window.setTimeout(() => { if (alive) { phase = 'running'; phaseStart = performance.now(); sfx.click(); updateButton(); } }, WAIT_MS);
  };

  const crashNow = () => {
    phase = 'crashed'; phaseStart = performance.now();
    history.unshift(cp); drawHistory();
    sfx.boom();
    if (live()) finish();
    drawPlayers(); updateButton();
    timer = window.setTimeout(() => alive && startWaiting(), AFTER_MS);
  };

  const resize = () => {
    const r = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize); ro.observe(cv.parentElement); resize();

  const draw = () => {
    const W = cv.width / (window.devicePixelRatio || 1), H = cv.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 44, b: 28, t: 16, r: 16 };
    const t = phase === 'running' ? elapsed() : phase === 'crashed' ? Math.log(cp) / GROWTH : 0;
    const m = phase === 'waiting' ? 1 : Math.min(multAt(t), phase === 'crashed' ? cp : Infinity);
    const maxT = Math.max(8000, t * 1.15), maxM = Math.max(2, m * 1.25);
    const X = tt => pad.l + (tt / maxT) * (W - pad.l - pad.r);
    const Y = mm => H - pad.b - ((mm - 1) / (maxM - 1)) * (H - pad.b - pad.t);

    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '11px Inter'; ctx.lineWidth = 1;
    const stepM = maxM <= 3 ? 0.5 : maxM <= 8 ? 1 : Math.pow(10, Math.floor(Math.log10(maxM))) / 2;
    for (let v = 1; v <= maxM; v += stepM) { const y = Y(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillText(`${v.toFixed(v % 1 ? 1 : 0)}×`, 6, y + 4); }
    for (let s = 0; s <= maxT / 1000; s += Math.ceil(maxT / 8000)) ctx.fillText(`${s}s`, X(s * 1000) - 6, H - 8);

    if (phase !== 'waiting') {
      const col = phase === 'crashed' ? '#ff4d5e' : '#c6ff3d';
      ctx.beginPath(); ctx.moveTo(X(0), Y(1));
      const steps = 80;
      for (let i = 1; i <= steps; i++) { const tt = (t * i) / steps; ctx.lineTo(X(tt), Y(multAt(tt))); }
      ctx.lineWidth = 4; ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.stroke(); ctx.shadowBlur = 0;
      ctx.lineTo(X(t), Y(1)); ctx.closePath();
      const g = ctx.createLinearGradient(0, Y(m), 0, Y(1)); g.addColorStop(0, phase === 'crashed' ? 'rgba(255,77,94,.25)' : 'rgba(198,255,61,.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fill();
      // Cash-out markers on the curve (you and the bots), like the avatars on the reference sites.
      const marks = [...players.filter(p => p.cashed).map(p => ({ m: p.cashed, me: false })), ...(myBet ? myBet.cashouts.map(c => ({ m: c, me: true })) : [])];
      marks.forEach(k => { const tt = Math.log(k.m) / GROWTH; ctx.beginPath(); ctx.arc(X(tt), Y(k.m), k.me ? 6 : 4, 0, Math.PI * 2); ctx.fillStyle = k.me ? '#ffc53d' : 'rgba(255,255,255,.55)'; ctx.fill(); });
      ctx.beginPath(); ctx.arc(X(t), Y(m), 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }

    if (phase === 'waiting') {
      const left = Math.max(0, (WAIT_MS - elapsed()) / 1000);
      multEl.className = 'crash-mult waiting';
      multEl.innerHTML = `<span class="small muted">Next round in</span>${left.toFixed(1)}s<div class="bar"><i style="width:${(left / (WAIT_MS / 1000)) * 100}%"></i></div>`;
      hint.textContent = myBet ? 'Bet placed. Good luck!' : 'Place your bet before the round starts';
    } else if (phase === 'running') {
      multEl.className = 'crash-mult running';
      multEl.innerHTML = `${fmt(m)}×${live() ? `<span class="potential">${money(round2(myBet.riding * m + myBet.locked))}</span>` : ''}`;
      hint.textContent = live() ? 'Cash out before it crashes! Pick a share to cash out part of it.' : 'Round in progress';
    } else {
      multEl.className = 'crash-mult crashed'; multEl.innerHTML = `<span class="small">Crashed at</span>${fmt(cp)}×`;
      hint.textContent = myBet ? (myBet.locked ? `You kept ${fmt(myBet.locked)}` : 'Busted. Next round starting soon') : 'Next round starting soon';
    }
  };

  const loop = () => {
    if (!alive) return;
    if (phase === 'running') {
      const m = multAt(elapsed());
      if (m >= cp) crashNow();
      else {
        let changed = false;
        players.forEach(p => { if (!p.cashed && m >= p.target) { p.cashed = p.target; changed = true; } });
        if (live() && myBet.auto && m >= myBet.auto) cashOut(myBet.auto, 1);
        if (changed) drawPlayers();
        if (live()) act.innerHTML = `Cash out ${part < 1 ? `${part * 100}% ` : ''}${money(round2(myBet.riding * part * m))}`;
      }
    }
    draw();
    raf = requestAnimationFrame(loop);
  };

  drawHistory();
  startWaiting();
  loop();

  return () => {
    alive = false; cancelAnimationFrame(raf); clearTimeout(timer); ro.disconnect();
    // Leaving: refund a bet that hasn't started; a live bet is cashed out in full at the current multiplier.
    if (live()) {
      if (phase === 'waiting') credit(myBet.amount);
      else if (phase === 'running' && multAt(elapsed()) < cp) cashOut(multAt(elapsed()), 1);
    }
  };
}
