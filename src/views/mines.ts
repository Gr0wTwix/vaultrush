import { state, debit, credit, round2, debitError } from '../state.js';
import { bet, minePositions, minesMultiplier, annotate } from '../fair.js';
import { pushBet } from '../feed.js';
import { $, $$, fmt, money, icon, coin, toast, avatar, esc } from '../ui.js';
import { randomBot } from '../data.js';
import { sfx } from '../sfx.js';
import { createFx } from '../fx.js';
import { serverWallet, minesStart, minesPick, minesCashout, minesCancel, minesActive, type MinesEnd } from '../wallet.js';

const GEM = `<svg class="gem-svg" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="gemA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4ffd0"/><stop offset=".45" stop-color="#c6ff3d"/><stop offset="1" stop-color="#5fa800"/></linearGradient></defs>
  <path d="M14 8h20l9 11-19 23L5 19z" fill="url(#gemA)"/>
  <path d="M5 19h38M14 8l5 11 5-11 5 11 5-11M19 19l5 23 5-23" fill="none" stroke="#2f5a00" stroke-opacity=".4" stroke-width="1.2"/>
  <path d="M14 8h10l-5 11H5z" fill="#fff" opacity=".5"/></svg>`;

const BOMB = `<svg class="bomb-svg" viewBox="0 0 48 48" aria-hidden="true"><defs><radialGradient id="bombA" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#6b7389"/><stop offset=".5" stop-color="#2a2f3d"/><stop offset="1" stop-color="#0d1017"/></radialGradient></defs>
  <rect x="27" y="9" width="8" height="7" rx="1.5" transform="rotate(35 31 12)" fill="#3b4254"/>
  <path d="M33 9c2-4 6-4 8-2" fill="none" stroke="#a07a4a" stroke-width="2" stroke-linecap="round"/>
  <circle cx="22" cy="28" r="14" fill="url(#bombA)"/>
  <ellipse cx="17" cy="22" rx="4" ry="2.5" fill="#fff" opacity=".35" transform="rotate(-35 17 22)"/>
  <circle cx="41" cy="7" r="2.2" fill="#ffc53d"/></svg>`;

const CRATER = `<svg class="crater-svg" viewBox="0 0 48 48" aria-hidden="true"><defs><radialGradient id="crA"><stop offset="0" stop-color="#ffd58a"/><stop offset=".2" stop-color="#ff7a1a"/><stop offset=".5" stop-color="#5a1a08"/><stop offset="1" stop-color="#2a0c04" stop-opacity="0"/></radialGradient></defs>
  <circle cx="24" cy="24" r="23" fill="url(#crA)"/>
  <path d="M24 24 7 13M24 24l19-7M24 24l-4 20M24 24l15 15M24 24 4 31M24 24l2-21" stroke="#1a0804" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="24" cy="24" r="4.5" fill="#fff1c9"/></svg>`;

const FLIP_MS = 300, QUICK_MS = 240;

// Live games feed: recent boards (bots + yours) shown as mini grids, like the reference sites.
const liveGames = [];
function simGame() {
  const sizes = [16, 25, 25, 25, 36];
  const N = sizes[Math.floor(Math.random() * sizes.length)];
  const mines = 1 + Math.floor(Math.random() * Math.min(10, N / 3));
  const tiles = [...Array(N).keys()].sort(() => Math.random() - 0.5);
  const bombs = new Set(tiles.slice(0, mines));
  const safe = tiles.slice(mines);
  const picks = 1 + Math.floor(Math.random() * Math.min(8, safe.length));
  const lost = Math.random() < 0.45;
  const revealed = new Set(safe.slice(0, lost ? picks - 1 : picks));
  const hit = lost ? [...bombs][0] : null;
  const amount = Math.round(Math.exp(Math.random() * 4 - 1) * 100) / 100;
  const multi = lost ? 0 : minesMultiplier(mines, revealed.size, N);
  return { user: randomBot(), N, bombs, revealed, hit, amount, multi, at: Date.now() };
}
for (let i = 0; i < 6; i++) liveGames.push(simGame());
const miniBoard = g => {
  const cols = Math.sqrt(g.N);
  return `<div class="mini-board" style="--cols:${cols}">${Array.from({ length: g.N }, (_, i) => `<i class="${i === g.hit ? 'b' : g.revealed.has(i) ? 'g' : g.bombs.has(i) ? 'x' : ''}"></i>`).join('')}</div>`;
};
const gameCard = g => `<div class="lg-card ${g.mine ? 'mine' : ''}">${miniBoard(g)}<div class="lg-info"><div class="lg-user">${avatar(g.user, 20)}<b>${esc(g.user)}</b></div>
  <div><span class="muted small">Bet</span>${money(g.amount)}</div><div><span class="muted small">Multi</span><b class="${g.multi ? 'pos' : 'neg'}">${fmt(g.multi)}×</b></div>
  <div><span class="muted small">Profit</span><b class="${g.multi ? 'pos' : 'neg'}">${g.multi ? '+' : '-'}${fmt(g.multi ? round2(g.amount * g.multi - g.amount) : g.amount)}</b></div></div></div>`;

export function render(el) {
  let game = null; // { amount, bombs:Set, revealed:Set, over, busy, entry, last }; with the server wallet also { server, sid, final } and the bombs stay unknown until the game ends
  let mineCount = 3, N = 25, cols = 5;
  let timers = [];
  const later = (fn, ms) => { const id = setTimeout(() => { timers = timers.filter(t => t !== id); fn(); }, ms); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  el.innerHTML = `
    <div class="page-head"><h1>${icon('mines')} Mines</h1><p class="muted">Reveal gems and cash out whenever you like. Hit a bomb and you lose the bet.</p></div>
    <div class="mines-layout">
      <div class="panel controls">
        <div class="field"><label>Bet amount</label><div class="amount"><span class="amount-coin">${coin()}</span><input id="amt" type="number" min="0.1" step="0.1" value="1"><button data-a="half">½</button><button data-a="double">2×</button></div></div>
        <div class="field"><label>Grid</label><div class="seg wrap" id="grid">${[16, 25, 36, 49, 64].map(n => `<button data-g="${n}" class="${n === 25 ? 'active' : ''}">${Math.sqrt(n)}×${Math.sqrt(n)}</button>`).join('')}</div></div>
        <div class="field"><label for="mcI">Mines</label><div class="amount"><input id="mcI" type="number" min="1" max="24" value="3"><span id="mc">${[1, 3, 5, 10].map(n => `<button data-n="${n}">${n}</button>`).join('')}</span></div></div>
        <div class="mines-stats"><div><span class="muted small">Next tile</span><b id="next">–</b></div><div><span class="muted small">Current</span><b id="cur">–</b></div></div>
        <button class="btn btn-primary btn-lg block" id="act" data-needs-auth="bet">Start game</button>
        <button class="btn btn-ghost block" id="rand" disabled>Pick random tile</button>
      </div>
      <div class="panel board-wrap" id="boardWrap">
        <div class="board" id="board"></div>
        <div class="board-banner" id="banner"></div>
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h2><span class="live-dot"></span> Live games</h2><span class="muted small">Recent boards from other players and you</span></div><div class="lg-grid" id="liveGames"></div></div>`;
  const drawLive = () => { const box = $('#liveGames', el); if (box) box.innerHTML = liveGames.slice(0, 8).map(gameCard).join(''); };
  const pushLive = g => { liveGames.unshift(g); liveGames.length = Math.min(liveGames.length, 16); drawLive(); };
  drawLive();
  const liveTimer = setInterval(() => pushLive(simGame()), 4500);

  const amt = $('#amt', el), act = $('#act', el), wrap = $('#boardWrap', el), board = $('#board', el);
  let tiles = [];
  const fx = createFx(wrap);

  const buildBoard = () => {
    board.style.setProperty('--cols', cols);
    board.dataset.cols = cols;
    board.innerHTML = Array.from({ length: N }, (_, i) => `<button class="tile" data-i="${i}" disabled aria-label="Tile ${i + 1}"></button>`).join('');
    tiles = $$('.tile', board);
  };
  buildBoard();
  const locked = () => game && !game.over;
  const setMines = n => { mineCount = Math.max(1, Math.min(N - 1, Math.round(n) || 1)); $('#mcI', el).value = mineCount; $('#mcI', el).max = N - 1; stats(); };

  el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { if (locked()) return; const v = +amt.value || 0; amt.value = b.dataset.a === 'half' ? round2(Math.max(0.1, v / 2)) : round2(v * 2); stats(); });
  $$('#mc button', el).forEach(b => b.onclick = () => { if (!locked()) setMines(+b.dataset.n); });
  $('#mcI', el).oninput = e => { if (locked()) { e.target.value = mineCount; return; } setMines(+e.target.value); };
  $$('#grid button', el).forEach(b => b.onclick = () => {
    if (locked() || (game && game.busy)) return;
    N = +b.dataset.g; cols = Math.sqrt(N); game = null;
    $$('#grid button', el).forEach(x => x.classList.toggle('active', x === b));
    $('#banner', el).className = 'board-banner';
    buildBoard(); setMines(mineCount);
  });

  const stats = () => {
    const live = game && !game.over;
    const picks = live ? game.revealed.size : 0;
    const a = live ? game.amount : +amt.value || 0;
    const nextM = N - mineCount - picks > 0 ? minesMultiplier(mineCount, picks + 1, N) : null;
    const two = (m, amt) => `<span class="ms-m">${fmt(m)}×</span><span class="ms-a">${money(round2(amt * m))}</span>`;
    $('#next', el).innerHTML = nextM ? two(nextM, a) : '–';
    $('#cur', el).innerHTML = picks ? two(minesMultiplier(mineCount, picks, N), a) : '–';
    if (live) {
      act.className = 'btn btn-cash btn-lg block';
      act.disabled = picks === 0 || game.busy;
      act.innerHTML = picks ? `Cash out ${money(round2(game.amount * minesMultiplier(mineCount, picks, N)))}` : 'Pick a tile';
    } else {
      act.className = 'btn btn-primary btn-lg block';
      act.disabled = !!(game && game.busy);
      act.textContent = 'Start game';
    }
    $('#rand', el).disabled = !live || game.busy;
  };

  const bump = sel => { const n = $(sel, el); n.classList.remove('bump'); void n.offsetWidth; n.classList.add('bump'); };
  const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

  /** 3D flip: the face swaps at the midpoint (when the tile is edge-on). */
  const flip = (t: any, html: string, classes: string[], ms: number, onSwap?: () => void) => new Promise<void>(res => {
    t.style.setProperty('--fd', `${ms}ms`);
    restart(t, 'flip');
    later(() => { t.innerHTML = html; t.classList.add(...classes); onSwap?.(); }, ms * 0.5);
    later(() => { t.classList.remove('flip'); res(); }, ms);
  });

  const coords = i => [i % cols, Math.floor(i / cols)];

  /** Reveal every hidden tile in a ripple spreading out from `origin`. Resolves when done. */
  const cascade = (origin, startDelay, perStep = 70) => {
    const [ox, oy] = coords(origin);
    let maxDelay = 0;
    tiles.forEach((t, i) => {
      t.disabled = true;
      if (game.revealed.has(i) || i === game.exploded) return;
      const [x, y] = coords(i);
      const d = startDelay + Math.hypot(x - ox, y - oy) * perStep;
      maxDelay = Math.max(maxDelay, d);
      const bomb = game.bombs.has(i);
      later(() => flip(t, bomb ? BOMB : GEM, ['dim', bomb ? 'bomb' : 'gem'], QUICK_MS * 0.75), d);
    });
    return new Promise(r => later(r, maxDelay + QUICK_MS * 0.75));
  };

  const showBanner = (html, kind) => {
    const b = $('#banner', el);
    b.className = `board-banner show ${kind}`;
    b.innerHTML = html;
  };

  const settle = won => {
    game.over = true;
    const picks = game.revealed.size;
    // With the server wallet the database has already paid; the multiplier and payout shown are the ones it returned.
    const m = won ? (game.server ? Number(game.final?.mult ?? minesMultiplier(mineCount, picks, N)) : minesMultiplier(mineCount, picks, N)) : 0;
    const payout = game.server ? (won ? Number(game.final?.payout ?? 0) : 0) : round2(game.amount * m);
    if (won) credit(payout);
    if (game.entry) annotate(game.entry, `${cols}×${cols} grid, ${mineCount} mines at ${[...game.bombs].map(b => b + 1).sort((a, b) => a - b).join(', ')}, ${picks} gems, ${won ? `cashed ${fmt(m)}×` : 'hit a bomb'}`, [...game.bombs].map(b => b + 1).sort((a, b) => a - b).join(','));
    pushBet({ user: state.name, game: 'Mines', amount: game.amount, multi: m, payout, mine: true });
    pushLive({ user: state.name, mine: true, N, bombs: game.bombs, revealed: new Set(game.revealed), hit: won ? null : game.exploded, amount: game.amount, multi: m });
    return { m, payout };
  };

  const explodeAt = (i, at) => {
    const { x, y, s } = at;
    sfx.explosion();
    fx.explode(x, y, Math.max(0.7, s));
    restart(wrap, 'quake');
    restart(wrap, 'hit');
    // Shove the neighbouring tiles away from the blast.
    const [bx, by] = coords(i);
    tiles.forEach((n, j) => {
      const [x2, y2] = coords(j);
      const d = Math.hypot(x2 - bx, y2 - by);
      if (d === 0 || d > 2.2) return;
      const f = (d < 1.5 ? 9 : 4);
      n.style.setProperty('--jx', `${((x2 - bx) / d) * f}px`);
      n.style.setProperty('--jy', `${((y2 - by) / d) * f}px`);
      restart(n, 'jolt');
    });
  };

  const lose = async i => {
    game.exploded = i;
    settle(false);   // the bet is lost the moment the bomb is picked; the rest is presentation
    stats();
    const t = tiles[i];
    const at = fx.centerOf(t);   // measured before the flip, while the tile is flat
    await flip(t, CRATER, ['bomb', 'exploded'], 120, () => explodeAt(i, at));
    showBanner(`<b>LOSS</b><span>-${fmt(game.amount)}</span>`, 'lose');
    await cascade(i, 260, 40);
    game.busy = false;
    stats();
  };

  const win = async () => {
    if (game.server && !game.final) {
      game.busy = true; stats();
      try { const r = await minesCashout(game.sid); game.final = r; game.bombs = new Set(r.bombs); }
      catch (e) { game.busy = false; stats(); return toast(e instanceof Error ? e.message : 'Could not cash out', 'error'); }
    }
    const { m, payout } = settle(true);
    sfx.win();
    toast(`Cashed out ${fmt(m)}×: +${fmt(payout)}`, 'win');
    showBanner(`<b>${fmt(m)}×</b><span>+${fmt(payout)}</span>`, 'win');
    tiles.forEach((t, i) => { if (game.revealed.has(i)) { t.style.animationDelay = `${(i % cols) * 40}ms`; restart(t, 'celebrate'); } });
    game.busy = true; stats();
    await cascade(game.last ?? Math.floor(N / 2), 150, cols > 5 ? 45 : 70);
    game.busy = false;
    stats();
  };

  const pick = i => {
    if (!game || game.over || game.busy || game.revealed.has(i)) return;
    game.busy = true;
    const t = tiles[i];
    t.disabled = true;
    sfx.press();
    stats();
    restart(t, 'press');
    later(async () => {
      t.classList.remove('press');
      let bomb: boolean;
      if (game.server) {
        // The bombs are secret: the database says whether this tile is one (and reveals them all when the game ends).
        let r;
        try { r = await minesPick(game.sid, i); }
        catch (e) { toast(e instanceof Error ? e.message : 'Could not pick that tile', 'error'); game.busy = false; t.disabled = false; stats(); return; }
        bomb = r.bomb;
        if (r.bombs) game.bombs = new Set(r.bombs);
        if (r.done) game.final = r;                       // the last safe tile was revealed: the database cashed out by itself
      } else bomb = game.bombs.has(i);
      if (bomb) return lose(i);
      game.revealed.add(i);
      game.last = i;
      const step = game.revealed.size;
      const at = fx.centerOf(t);
      await flip(t, GEM, ['gem', 'found'], FLIP_MS, () => {
        const { x, y, s } = at;
        fx.sparkle(x, y, Math.max(0.7, s));
        sfx.gemChime(step - 1);
      });
      game.busy = false;
      bump('#cur');
      if (game.revealed.size === N - mineCount) return win();
      stats();
    }, 70);
  };

  board.onclick = e => { const t = e.target.closest('.tile'); if (t) pick(+t.dataset.i); };
  $('#rand', el).onclick = () => {
    if (!game || game.over || game.busy) return;
    const free = [...Array(N).keys()].filter(i => !game.revealed.has(i));
    pick(free[Math.floor(Math.random() * free.length)]);
  };

  act.onclick = async () => {
    if (game && !game.over) { if (game.revealed.size && !game.busy) win(); return; }
    const amount = round2(+amt.value);
    if (!(amount >= 0.1)) return toast('Minimum bet is 0.10', 'error');
    if (!debit(amount)) return toast(debitError(amount), 'error');
    clearTimers();
    act.disabled = true;
    if (serverWallet()) {
      try {
        const s = await minesStart(amount, N, mineCount);
        game = { amount, bombs: new Set(), revealed: new Set(), over: false, busy: false, entry: null, last: null, exploded: null, server: true, sid: s.game, final: null };
      } catch (e) {
        act.disabled = false; stats();
        const again = e instanceof Error && /current game/.test(e.message);
        toast(e instanceof Error ? e.message : 'Could not start the game', 'error');
        if (again) void resume();
        return;
      }
    } else {
      const { floats, entry } = await bet('mines', N - 1, { grid: N, mines: mineCount });
      game = { amount, bombs: new Set(minePositions(floats, mineCount, N)), revealed: new Set(), over: false, busy: false, entry, last: null, exploded: null };
    }
    $('#banner', el).className = 'board-banner';
    wrap.classList.remove('quake', 'hit');
    tiles.forEach((t, i) => {
      t.className = 'tile deal';
      t.style.animationDelay = `${(i % cols + Math.floor(i / cols)) * 22}ms`;
      t.innerHTML = '';
      t.disabled = false;
    });
    later(() => tiles.forEach(t => { t.classList.remove('deal'); t.style.animationDelay = ''; }), 700);
    sfx.click(); stats();
  };

  /** A game was left open (page closed, another device): carry on where it stopped. The database never tells us where the bombs are. */
  async function resume(): Promise<void> {
    let a;
    try { a = await minesActive(); } catch { return; }
    if (!a || !el.isConnected || locked()) return;
    N = a.grid; cols = Math.sqrt(N); mineCount = a.mines; amt.value = a.amount;
    $$('#grid button', el).forEach(x => x.classList.toggle('active', +x.dataset.g === N));
    $('#banner', el).className = 'board-banner';
    buildBoard(); setMines(a.mines);
    game = { amount: a.amount, bombs: new Set(), revealed: new Set(a.picks), over: false, busy: false, entry: null, last: a.picks[a.picks.length - 1] ?? null, exploded: null, server: true, sid: a.game, final: null };
    tiles.forEach((t, i) => {
      if (game.revealed.has(i)) { t.innerHTML = GEM; t.classList.add('gem', 'found'); t.disabled = true; } else t.disabled = false;
    });
    stats();
    toast('Your game in progress was restored');
  }
  if (serverWallet()) void resume();

  stats();
  // Leaving mid-game: cash out what's revealed, or refund if no tile was picked yet.
  return () => {
    clearInterval(liveTimer);
    clearTimers();
    if (game && !game.over) {
      if (game.server) {
        // The database settles it for us: cash out what is revealed, or give the stake back when nothing was picked.
        game.over = true;
        if (game.revealed.size) void minesCashout(game.sid).then((r: MinesEnd) => pushBet({ user: state.name, game: 'Mines', amount: game.amount, multi: Number(r.mult ?? 0), payout: Number(r.payout), mine: true })).catch(() => {});
        else void minesCancel(game.sid).catch(() => {});
      } else if (game.revealed.size) settle(true); else { game.over = true; credit(game.amount); }
    }
    fx.destroy();
  };
}
