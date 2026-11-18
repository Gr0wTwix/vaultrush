// Coinflip: one coin, two players, 50/50. Create a game on a side or join someone else's.
// Opponents are bots (play money). Your games use the provably fair roll; bot-vs-bot games are cosmetic.
import { randomBot } from '../data.js';
import { state, debit, credit, round2, debitError } from '../state.js';
import { bet, annotate, HOUSE } from '../fair.js';
import { pushBet } from '../feed.js';
import { $, $$, esc, fmt, money, icon, toast, avatar, coin, modal, confetti, sleep } from '../ui.js';
import { sfx } from '../sfx.js';

const SIDES = {
  bolt: { label: 'Bolt', svg: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
  star: { label: 'Star', svg: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>' },
};
const PAYOUT = 2 * HOUSE.coinflip;   // winner takes the pot minus 3%
const other = s => (s === 'bolt' ? 'star' : 'bolt');
const sideChip = (s, size = 22) => `<span class="cf-side ${s}" style="width:${size}px;height:${size}px" title="${SIDES[s].label}"><svg viewBox="0 0 24 24">${SIDES[s].svg}</svg></span>`;

// ---- 3D chip coin -------------------------------------------------------------------------------------
// A real 3D object: two faces pushed out by half the thickness, plus a cylinder edge made of thin
// segments (striped like a poker chip). Lighting and the floor shadow are driven per frame in flipCoin.
const D = 150, T = 16, SEG = 44;
export function coin3d() {
  const r = D / 2, w = (Math.PI * D) / SEG + 0.6;
  const edge = Array.from({ length: SEG }, (_, i) => {
    const a = (360 / SEG) * i;
    return `<i class="cf-edge ${Math.floor(i / 2) % 2 ? 'b' : 'a'}" style="width:${w}px;height:${T}px;margin:${-T / 2}px 0 0 ${-w / 2}px;transform:rotateZ(${a}deg) translateY(${-r + 0.5}px) rotateX(90deg)"></i>`;
  }).join('');
  const face = s => `<div class="cf-face ${s}" style="transform:${s === 'star' ? 'rotateY(180deg) ' : ''}translateZ(${T / 2}px)"><div class="cf-ring-notch"></div><div class="cf-core"><svg viewBox="0 0 24 24">${SIDES[s].svg}</svg></div><div class="cf-shade"></div></div>`;
  return `<div class="cf-scene"><div class="cf-shadow"></div><div class="cf-coin" id="cfCoin">${edge}${face('bolt')}${face('star')}</div></div>`;
}

/**
 * Toss the coin: it flies up spinning, slows as it falls, and lands flat on `result`. Faces are lit
 * by their angle. onPhase('toss') at the start and onPhase('landed') at the end.
 */
function flipCoin(el: any, result: string, ms: number, alive: () => boolean, { onPhase }: { onPhase?: (phase: 'toss' | 'landed') => void } = {}) {
  const scene = el.parentElement, shadow = scene.querySelector('.cf-shadow');
  const shades = [...el.querySelectorAll('.cf-shade')];
  const final = 7 * 360 + (result === 'star' ? 180 : 0);
  const easeOut = (x, p) => 1 - Math.pow(1 - x, p);
  return new Promise<void>(done => {
    const t0 = performance.now();
    el.classList.add('spin');
    let finished = false, lastFace = null;
    onPhase?.('toss');
    const finish = () => {
      if (finished) return; finished = true;
      el.style.transform = `rotateX(6deg) rotateY(${final}deg)`;
      shades[0].style.opacity = result === 'bolt' ? 0 : 0.55; shades[1].style.opacity = result === 'star' ? 0 : 0.55;
      shadow.style.transform = 'translateX(-50%) scale(1, 1)'; shadow.style.opacity = 0.6;
      el.classList.add('landed'); onPhase?.('landed'); done();
    };
    setTimeout(finish, ms + 200);                   // frames pause in background tabs; still end on time
    const frame = now => {
      if (finished) return;
      if (!alive()) return finish();
      const k = Math.min(1, (now - t0) / ms);
      const ry = final * easeOut(k, 3);               // fast spin, smoothly slowing to the result
      const lift = Math.sin(Math.PI * k) * 95;        // up and back down, landing exactly at the end
      const rx = 22 - 16 * k;
      el.style.transform = `translateY(${-lift}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      const c = Math.cos((ry * Math.PI) / 180);
      shades[0].style.opacity = (0.55 * (1 - Math.max(0, c))).toFixed(3);
      shades[1].style.opacity = (0.55 * (1 - Math.max(0, -c))).toFixed(3);
      shadow.style.transform = `translateX(-50%) scale(${(1 - lift / 160).toFixed(3)}, 1)`;
      shadow.style.opacity = (0.6 - lift / 190).toFixed(3);
      const face = c >= 0 ? 'bolt' : 'star';
      if (face !== lastFace) { lastFace = face; sfx.flick(k); }
      if (k < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
  });
}

// Games live at module level so they survive leaving and coming back to the page.
const games = [];
let seq = 36150;
/** One coinflip lobby/match. `mine` says which seat the player holds (false = a bot-only game). */
interface CfGame {
  id: number; creator: { name: string; side: string }; joiner: { name: string } | null; amount: number; status: string;
  result: string | null; winner: string | null; mine: false | 'creator' | 'joiner'; at: number;
  doubled?: boolean; autoJoin?: ReturnType<typeof setTimeout>; hash?: string; nonce?: number;
}
const mk = (creator: string, side: string, amount: number, mine: false | 'creator' | 'joiner' = false): CfGame => ({ id: ++seq, creator: { name: creator, side }, joiner: null, amount, status: 'waiting', result: null, winner: null, mine, at: Date.now() });
for (let i = 0; i < 5; i++) games.push(mk(randomBot(), Math.random() < 0.5 ? 'bolt' : 'star', round2(Math.exp(Math.random() * 4 - 1))));

export function render(el) {
  let alive = true, view = null;           // view = { g, m } for the open match window
  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(() => alive && fn(), ms));

  el.innerHTML = `
    <section class="panel cf-top">
      <div class="cf-title"><span class="cf-badge">${icon('coin')}</span><div><h1>Coinflip</h1><span class="muted small">The classic 50/50 game mode · winner takes ${fmt(PAYOUT)}× the bet</span></div></div>
      <div class="cf-create">
        <label class="dbl-amt cf-amt"><span class="amount-coin">${coin()}</span><input id="cfAmt" type="number" min="0.1" step="0.1" value="1" aria-label="Bet amount"></label>
        <button class="dbtn" data-op="half">1/2</button><button class="dbtn" data-op="double">X2</button><button class="dbtn" data-op="max">Max</button>
        <button class="btn cf-make bolt" data-needs-auth="bet" data-side="bolt">${sideChip('bolt', 20)} Create</button>
        <button class="btn cf-make star" data-needs-auth="bet" data-side="star">${sideChip('star', 20)} Create</button>
      </div>
    </section>
    <section><h2 class="cf-h">My games <span class="muted" id="myCount">0</span></h2><div class="cf-list" id="myGames"></div></section>
    <section><h2 class="cf-h">Open games <span class="muted" id="openCount">0</span></h2><div class="cf-list" id="openGames"></div></section>`;

  const amt = $('#cfAmt', el);
  $$('[data-op]', el).forEach(b => b.onclick = () => {
    const v = +amt.value || 0, op = b.dataset.op;
    amt.value = op === 'half' ? round2(Math.max(0.1, v / 2)) : op === 'double' ? round2(v * 2) : Math.floor(state.balance * 100) / 100;
  });

  // ---- list rendering -------------------------------------------------------------------------------
  const seat = (p, side, g) => p
    ? `<div class="cf-seat ${g.winner && g.winner === p.name ? 'won' : g.winner ? 'lost' : ''}">${avatar(p.name, 34)}${sideChip(side, 18)}<span class="cf-name">${esc(p.name)}</span></div>`
    : `<div class="cf-seat empty"><span class="cf-ghost">${sideChip(side, 18)}</span><span class="cf-name muted">Waiting…</span></div>`;
  const row = g => {
    const mineIn = g.mine;
    const action = g.status === 'waiting' && !g.mine
      ? `<button class="btn btn-primary btn-sm" data-join="${g.id}" data-needs-auth="bet">Join ${money(g.amount)}</button>`
      : `<button class="btn btn-ghost btn-sm" data-view="${g.id}">${g.status === 'done' ? 'Result' : 'View'}</button>`;
    return `<div class="cf-row ${mineIn ? 'mine' : ''} ${g.status}">
      ${seat(g.creator, g.creator.side, g)}
      <span class="cf-vs">VS</span>
      ${seat(g.joiner, other(g.creator.side), g)}
      <div class="cf-amtcol">${money(g.amount)}<span class="muted small">#${g.id}</span></div>
      ${g.status === 'done' ? `<span class="cf-res">${sideChip(g.result, 24)}</span>` : g.status !== 'waiting' ? '<span class="cf-live"><span class="live-dot"></span>Live</span>' : '<span></span>'}
      ${action}</div>`;
  };
  const drawLists = () => {
    if (!alive) return;
    const mine = games.filter(g => g.mine).slice(0, 8);
    const open = games.filter(g => !g.mine).slice(0, 12);
    $('#myGames', el).innerHTML = mine.map(row).join('') || '<div class="cf-empty muted">You have no games. Pick a side above to create one.</div>';
    $('#openGames', el).innerHTML = open.map(row).join('') || '<div class="cf-empty muted">No open games right now.</div>';
    $('#myCount', el).textContent = mine.length; $('#openCount', el).textContent = open.filter(g => g.status === 'waiting').length;
    $$('[data-join]', el).forEach(b => b.onclick = () => join(games.find(g => g.id === +b.dataset.join)));
    $$('[data-view]', el).forEach(b => b.onclick = () => openMatch(games.find(g => g.id === +b.dataset.view)));
  };

  // ---- match window ---------------------------------------------------------------------------------
  const COIN = coin3d();
  const player = (p, side, amount) => p
    ? `<div class="cf-player" data-side="${side}">${avatar(p.name, 72)}${sideChip(side, 26)}<b>${esc(p.name)}</b>${money(amount)}</div>`
    : `<div class="cf-player empty" data-side="${side}"><span class="cf-ghost big">${sideChip(side, 26)}</span><b class="muted">Waiting for player…</b>${money(amount)}</div>`;
  const drawMatch = () => {
    if (!view) return;
    const { g, m } = view;
    // Build only the current state (the "done" view needs a result that doesn't exist earlier).
    const centers = {
      waiting: () => `<div class="cf-center"><div class="cf-ring">${COIN}</div><span class="muted">Waiting for an opponent</span>${g.mine ? '<button class="btn btn-primary" id="callBot">Call bot</button>' : ''}</div>`,
      countdown: () => `<div class="cf-center"><div class="cf-ring"><b class="cf-count" id="cfCount">3</b></div><span class="muted">Game starting</span></div>`,
      flipping: () => `<div class="cf-center"><div class="cf-ring">${COIN}</div><span class="muted">Flipping…</span></div>`,
      done: () => `<div class="cf-center"><div class="cf-ring win">${avatar(g.winner, 120)}${sideChip(g.result, 34)}</div><b class="cf-winner">${g.winner === state.name ? 'You win!' : `${esc(g.winner)} wins`}</b>${money(round2(g.amount * PAYOUT))}
        ${canDouble(g) ? `<div class="row"><button class="btn btn-cash" id="dd">Double down? ${money(round2(g.amount * 2))}</button></div>` : ''}</div>`,
    };
    const center = centers[g.status]();
    m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button>
      <div class="cf-mhead">${icon('coin')} Coinflip <span class="muted">#${g.id}</span></div>
      <div class="cf-stage">${player(g.creator, g.creator.side, g.amount)}${center}${player(g.joiner, other(g.creator.side), g.amount)}</div>
      ${g.hash ? `<div class="game-hash"><code>${g.hash}</code><span>Provably fair · nonce ${g.nonce}</span></div>` : ''}`;
    m.el.querySelector('.modal-x').onclick = m.close;
    $('#callBot', m.el)?.addEventListener('click', () => botJoins(g));
    $('#dd', m.el)?.addEventListener('click', () => {
      if (!canDouble(g)) return;
      g.ddUsed = true;                       // one double-down per win
      m.close();
      create(g.mine === 'creator' ? g.creator.side : other(g.creator.side), round2(g.amount * 2), true);
    });
  };
  /** Double down is offered only to the winner, once, and never on a game that was itself a double-down. */
  const canDouble = g => !!g.mine && g.winner === state.name && !g.ddUsed && !g.doubled;
  function openMatch(g) {
    if (!g) return;
    if (view) view.m.close();
    const m = modal('', { wide: true, label: 'Coinflip', onClose: () => { if (view && view.m === m) view = null; } });
    m.el.classList.add('cf-modal');
    view = { g, m };
    drawMatch();
  }
  const refresh = g => { drawLists(); if (view && view.g === g) drawMatch(); };

  // ---- game flow ------------------------------------------------------------------------------------
  function create(side, amount = round2(+amt.value), doubled = false) {
    if (!(amount >= 0.1)) return toast('Minimum bet is 0.10', 'error');
    if (!debit(amount)) return toast(debitError(amount), 'error');
    const g = mk(state.name, side, amount, 'creator');
    g.doubled = doubled;
    games.unshift(g); sfx.click();
    // A bot picks it up on its own after a few seconds, unless you call one first.
    g.autoJoin = setTimeout(() => botJoins(g), 4000 + Math.random() * 5000);
    drawLists(); openMatch(g);
  }
  function join(g) {
    if (!g || g.status !== 'waiting') return;
    if (!debit(g.amount)) return toast(debitError(g.amount), 'error');
    g.joiner = { name: state.name }; g.mine = 'joiner';
    games.splice(games.indexOf(g), 1); games.unshift(g);
    sfx.click(); openMatch(g); start(g);
  }
  function botJoins(g) {
    if (g.status !== 'waiting') return;
    clearTimeout(g.autoJoin);
    g.joiner = { name: randomBot([g.creator.name]) };
    sfx.click(); start(g);
  }
  async function start(g) {
    g.status = 'countdown'; refresh(g);
    for (let n = 3; n >= 1; n--) {
      const c = view && view.g === g && $('#cfCount', view.m.el);
      if (c) { c.textContent = n; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
      if (alive && view && view.g === g) sfx.heartbeat(0.4 + (3 - n) * 0.3);
      await sleep(850);
    }
    // Your games use your provably fair seed; bot-only games are cosmetic.
    let f;
    if (g.mine) {
      const { floats, entry } = await bet('coinflip', 1, {});
      f = floats[0]; g.hash = entry.serverHash; g.nonce = entry.nonce;
      g.entry = entry;
    } else f = Math.random();
    g.result = f < 0.5 ? 'bolt' : 'star';
    g.winner = g.creator.side === g.result ? g.creator.name : g.joiner.name;
    g.status = 'flipping'; refresh(g);
    const coinEl = view && view.g === g && $('#cfCoin', view.m.el);
    if (coinEl) {
      const box = view.m.el;
      const players = [...box.querySelectorAll('.cf-player')];
      await flipCoin(coinEl, g.result, 3400, () => alive, {
        onPhase: ph => {
          if (ph === 'toss') sfx.whoosh();
          if (ph === 'landed') {
            // Only now does the winner light up.
            players.forEach(p => p.classList.toggle('facing', p.dataset.side === g.result));
            box.style.setProperty('--win', g.result === 'bolt' ? '#c6ff3d' : '#33d6ff');
            box.classList.remove('cf-impact'); void box.offsetWidth; box.classList.add('cf-impact');
            sfx.thud();
          }
        },
      });
      await sleep(650);                    // let the landing breathe before the winner card
    } else await sleep(3400);
    settle(g);
  }
  function settle(g) {
    if (g.status === 'done') return;
    g.status = 'done';
    if (g.mine) {
      const won = g.winner === state.name, payout = won ? round2(g.amount * PAYOUT) : 0;
      if (won) credit(payout);
      annotate(g.entry, `#${g.id}: ${g.creator.name} (${g.creator.side}) vs ${g.joiner.name} → ${g.result}, ${g.winner} wins`, g.result);
      pushBet({ user: state.name, game: 'Coinflip', amount: g.amount, multi: won ? PAYOUT : 0, payout, mine: true });
      if (alive && view && view.g === g) { if (won) { sfx.big(); confetti(); } else sfx.lose(); }
      else if (won) toast(`Coinflip #${g.id}: you won ${fmt(payout)}`, 'win');
    }
    refresh(g);
    // Finished games drop off the lists after a while.
    setTimeout(() => { const i = games.indexOf(g); if (i >= 0 && (!view || view.g !== g)) { games.splice(i, 1); drawLists(); } }, g.mine ? 60000 : 12000);
  }

  $$('.cf-make', el).forEach(b => b.onclick = () => create(b.dataset.side));

  // ---- bots: open new games and sometimes take each other's ------------------------------------------
  const tick = setInterval(() => {
    if (!alive) return;
    const waiting = games.filter(g => !g.mine && g.status === 'waiting');
    if (waiting.length < 6 && Math.random() < 0.7) { games.push(mk(randomBot(), Math.random() < 0.5 ? 'bolt' : 'star', round2(Math.exp(Math.random() * 4 - 1)))); drawLists(); }
    if (waiting.length > 2 && Math.random() < 0.45) botJoins(waiting[Math.floor(Math.random() * waiting.length)]);
  }, 3500);

  drawLists();
  return () => {
    alive = false; clearInterval(tick); timers.forEach(clearTimeout);
    if (view) view.m.close();
    // Leaving: a game of yours still waiting is cancelled and refunded; a running one finishes right away.
    games.filter(g => g.mine && g.status !== 'done').forEach(g => {
      if (g.status === 'waiting') { clearTimeout(g.autoJoin); credit(g.amount); games.splice(games.indexOf(g), 1); }
      else if (g.status === 'flipping') settle(g);
    });
  };
}
