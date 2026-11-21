import { CASES, CASE, RARITY, randomBot, entryForTicket, ticketOf } from '../data.js';
import { state, save, debit, credit, round2, debitError, handoff } from '../state.js';
import { bet, annotate, pickWeighted, floatsFor } from '../fair.js';
import { tellBalance, isLive, liveMe, createLiveBattle, joinLiveBattle, callLiveBot, leaveLiveBattle, getLiveBattle, openLiveBattles, myLiveBattles, liveBattleSeed, watchBattles, refundOnce, settleOnce, isSettled, onReconcile, type LiveBattle } from '../live.js';
import { pushBet, pushDrop } from '../feed.js';
import { $, $$, esc, fmt, money, caseArt, itemCard, spinReel, toast, confetti, icon, avatar, sleep, SPEEDS, reelMs, speedSeg, modal, itemArt, preloadImages } from '../ui.js';
import { sfx } from '../sfx.js';

import { FORMATS, decide, shareOf } from '../battle-math.js';
import { serverWallet, freezeBalance, unfreezeBalance } from '../wallet.js';
export { FORMATS };
export const MODES = {
  normal: { label: 'Normal', desc: 'Highest total wins everything.' },
  crazy: { label: 'Crazy', desc: 'Lowest total wins everything.' },
  terminal: { label: 'Terminal', desc: 'Only the last case counts.' },
  jackpot: { label: 'Jackpot', desc: 'Your chance grows with the value you unbox.' },
  crazyjackpot: { label: 'Crazy Jackpot', desc: 'Your chance grows the less you unbox.' },
  pointrush: { label: 'Point Rush', desc: 'Best pull each round scores a point; most points wins.' },
  group: { label: 'Group', desc: 'Everyone splits the pot evenly.' },
};
const TEAM_MODES = ['normal', 'crazy', 'terminal'];

const battles = new Map();
let seq = 1;
const costOf = ids => round2(ids.reduce((s, id) => s + CASE[id].price, 0));

// Simulated open lobbies: bots hold some seats, the rest are open. They rotate while you browse.
let lobSeq = 1;
function makeLobby() {
  const fmtKeys = Object.keys(FORMATS);
  const format = fmtKeys[Math.floor(Math.random() * fmtKeys.length)];
  const modeKeys = FORMATS[format].teams ? TEAM_MODES : Object.keys(MODES);
  const mode = modeKeys[Math.floor(Math.random() * modeKeys.length)];
  const pool = CASES.filter(c => c.price < 25);
  const n = 1 + Math.floor(Math.random() * 6);
  const ids = Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)].id);
  const seats = FORMATS[format].size;
  const botCount = 1 + Math.floor(Math.random() * (seats - 1));
  const bots = []; for (let i = 0; i < botCount; i++) bots.push(randomBot(bots));
  return { uid: lobSeq++, ids, format, mode, bots };
}
const lobbies = Array.from({ length: 8 }, makeLobby);

async function createBattle(ids, format, mode, preBots = []) {
  const cost = costOf(ids);
  if (!debit(cost)) { toast(debitError(cost), 'error'); return null; }
  sfx.click();
  if (isLive()) {
    try { const r = await createLiveBattle(ids, format, mode); return { id: r.id }; }
    catch (e) { credit(cost); toast(e instanceof Error ? e.message : 'Could not create the battle', 'error'); return null; }
  }
  const size = FORMATS[format].size;
  const bots = [...preBots];
  while (bots.length < size - 1) bots.push(randomBot([...bots, state.name]));
  const players = [{ name: state.name, bot: false }, ...bots.map(b => ({ name: b, bot: true }))];
  // One float per player per round, plus one for tie-breaks / jackpot draws: all from one provably fair bet.
  const { floats, entry } = await bet('battles', players.length * ids.length + 1, { cases: ids, players: players.length });
  const tickets = players.map((_, p) => ids.map((cid, r) => ticketOf(floats[r * players.length + p])));
  const results = players.map((_, p) => ids.map((cid, r) => entryForTicket(CASE[cid], tickets[p][r]).item));
  const outcome = decide(mode, format, results, floats[floats.length - 1]);
  const pot = round2(outcome.totals.reduce((a, b) => a + b, 0));
  const id = `b${seq++}`;
  // Seats taken by lobby bots are already filled; the rest wait until you "Call bot".
  const joined = players.map((_, i) => i === 0 || i <= preBots.length);
  const b = { id, ids, format, mode, players, results, tickets, ...outcome, pot, cost, credited: false, jackpotF: floats[floats.length - 1], joined, started: false, cancelled: false, viewers: 1 + Math.floor(Math.random() * 9) };
  annotate(entry, `${FORMATS[format].label} ${MODES[mode].label}: totals ${outcome.totals.map(fmt).join(' / ')}; winner(s) ${outcome.winners.map(i => players[i].name).join(', ')}`, `${tickets.flat().join(',')}|${floats[floats.length - 1].toFixed(6)}`);
  battles.set(id, b);
  return b;
}

function settle(b) {
  if (b.credited || !b.results) return;
  const mi = b.live ? b.me : 0;                       // my seat: always the first one in a simulated battle
  if (mi < 0) return;                                 // watching a live battle: nothing to pay
  b.credited = true;
  const mine = b.winners.includes(mi);
  const payout = mine ? shareOf(b.pot, b.winners.length) : 0;      // the database pays exactly this
  if (b.live && !settleOnce(`b:${b.id}`)) { b.payout = payout; if (serverWallet()) unfreezeBalance(); return; }   // already paid (a reload, or another tab)
  if (serverWallet()) unfreezeBalance();                           // the server paid when the last seat filled; now the animation is over, show it
  else if (payout) credit(payout);
  pushBet({ user: state.name, game: 'Battles', amount: b.cost, multi: round2(payout / b.cost), payout, mine: true });
  b.payout = payout;
}

// ---- live battles: the server seats the players and draws the seed; every browser derives the same result from it ----
const validBattle = (r: LiveBattle): boolean => !!FORMATS[r.format] && !!MODES[r.mode] && r.seats.length === FORMATS[r.format].size && r.case_ids.length > 0 && r.case_ids.every(id => !!CASE[id]);
function toBattle(r: LiveBattle): any {
  const me = liveMe();
  return {
    live: true, id: r.id, ids: [...r.case_ids], format: r.format, mode: r.mode, cost: costOf(r.case_ids), hash: r.server_hash, clientSeed: r.client_seed,
    players: r.seats.map(x => (x ? { name: x.name, bot: x.bot, uid: x.uid } : { name: '', bot: false, uid: null })),
    joined: r.seats.map(Boolean), me: r.seats.findIndex(x => !!x && x.uid === me), isCreator: r.creator === me,
    running: r.status === 'running', started: false, cancelled: r.status === 'cancelled', credited: false, viewers: r.seats.filter(Boolean).length,
  };
}
/** Same maths as a simulated battle: one float per player per round plus one for ties and jackpots, all from the revealed seed. */
async function resolveLive(b: any, seed: string): Promise<void> {
  const P = b.players.length;
  const floats = await floatsFor(seed, b.clientSeed, 0, P * b.ids.length + 1);
  const tickets = b.players.map((_, p) => b.ids.map((_c, r) => ticketOf(floats[r * P + p])));
  const results = b.players.map((_, p) => b.ids.map((cid, r) => entryForTicket(CASE[cid], tickets[p][r]).item));
  const extra = floats[floats.length - 1];
  const outcome = decide(b.mode, b.format, results, extra);
  Object.assign(b, { seed, tickets, results, ...outcome, pot: round2(outcome.totals.reduce((a, c) => a + c, 0)), jackpotF: extra });
}
async function seedWithRetry(id: string): Promise<string | null> {
  for (let i = 0; i < 6; i++) { const seed = await liveBattleSeed(id).catch(() => null); if (seed) return seed; await sleep(400); }
  return null;
}

// After a reload: a battle left waiting is left and refunded, a cancelled one is refunded, a finished one is paid (or marked lost) once.
onReconcile(async () => {
  const me = liveMe();
  for (const r of await myLiveBattles()) {
    if (!validBattle(r)) continue;
    const key = `b:${r.id}`, cost = costOf(r.case_ids);
    if (isSettled(key)) continue;
    if (r.status === 'waiting') {
      try { await leaveLiveBattle(r.id); if (refundOnce(r.creator === me ? key : `bl:${r.id}:${Date.now()}`, cost)) toast(`A battle you left open was closed: ${fmt(cost)} refunded`); } catch { /* it just started: the next sign-in settles it */ }
    } else if (r.status === 'cancelled') {
      if (refundOnce(key, cost)) toast(`A battle was cancelled: ${fmt(cost)} refunded`);
    } else {
      const seed = await liveBattleSeed(r.id); if (!seed) continue;
      const b = toBattle(r); await resolveLive(b, seed);
      if (b.me < 0 || !settleOnce(key)) continue;
      const payout = b.winners.includes(b.me) ? shareOf(b.pot, b.winners.length) : 0;
      if (payout) { credit(payout); toast(`Battle won while you were away: +${fmt(payout)}`, 'win'); }
    }
  }
});

// "Edit" on a finished battle pre-fills the creator with the same cases, format and mode.
let draft = null;

const MODE_ICON = { normal: 'battles', crazy: 'bolt', terminal: 'skull', jackpot: 'crown', crazyjackpot: 'double', pointrush: 'target', group: 'users' };
const SOLO = ['1v1', '1v1v1', '1v1v1v1', '6way'], TEAMS = ['2v2', '3v3'];
const AVG_RETURN = 0.9;

export function renderCreate(el) {
  const picked = [];
  let format = draft?.format || '1v1', mode = draft?.mode || 'normal';
  el.innerHTML = `
    <div class="page-head bt2-head">
      <div class="bt2-back-row"><a class="bt2-back" href="#/battles" aria-label="Back to battles" title="Back to battles">←</a>
        <div><h1>${icon('battles')} Create battle</h1><p class="muted">Pick a mode, the players and the cases. ${isLive() ? 'Friends can join from the Battles page or from the link you share. You can also call bots into empty seats.' : 'Empty seats are filled by bots.'} Bots play for the house: if a bot wins, the pot is gone.</p></div></div>
    </div>

    <section class="bt2-build">
      <div class="bt2-block">
        <div class="bt2-title"><h2>Game mode</h2><span class="muted small" id="modeDesc"></span></div>
        <div class="bt2-modes" id="modes"></div>
      </div>
      <div class="bt2-block">
        <div class="bt2-title"><h2>Players</h2><span class="muted small">Solo is every player for themselves. Team battles add up each team.</span></div>
        <div class="bt2-formats">
          <div class="bt2-fgroup"><h3>${icon('user')} Solo battle</h3><div class="bt2-fbtns" id="fSolo"></div></div>
          <div class="bt2-fgroup"><h3>${icon('users')} Team battle</h3><div class="bt2-fbtns" id="fTeam"></div></div>
        </div>
      </div>
      <div class="bt2-block">
        <div class="bt2-title"><h2>Cases <b class="bt2-count" id="caseCount">0 selected</b></h2>
          <div class="bt2-tools">
            <button class="bt2-tool" id="tAsc" title="Cheapest first">${icon('sortup')}</button>
            <button class="bt2-tool" id="tShuf" title="Shuffle order">${icon('shuffle')}</button>
            <button class="bt2-tool" id="tDesc" title="Most expensive first">${icon('sortdown')}</button>
            <button class="bt2-tool wide" id="tRand">${icon('dice')} Randomize</button>
            <button class="bt2-tool wide" id="tClear">${icon('trash')} Clear</button>
          </div>
        </div>
        <div class="bt2-slots" id="slots"></div>
      </div>
      <div class="bt2-bar">
        <div class="bt2-sum" id="sum"></div>
        <div class="bt2-go"><div class="bt2-speed"><span class="muted small">Speed</span>${speedSeg(state.speed)}</div><button class="btn btn-primary btn-lg" id="createBtn" data-needs-auth="battle"></button></div>
      </div>
    </section>`;

  // ---- mode cards ----
  const allowedModes = () => (FORMATS[format].teams ? TEAM_MODES : Object.keys(MODES));
  const drawModes = () => {
    const allowed = allowedModes();
    if (!allowed.includes(mode)) mode = 'normal';
    $('#modes', el).innerHTML = Object.entries(MODES).map(([k, m]) => {
      const ok = allowed.includes(k);
      return `<button class="bt2-mode m-${k} ${k === mode ? 'on' : ''}" data-m="${k}" ${ok ? '' : 'disabled'} title="${ok ? '' : 'Not available in team battles'}"><span class="bt2-mi">${icon(MODE_ICON[k])}</span><b>${m.label}</b><small>${m.desc}</small></button>`;
    }).join('');
    $('#modeDesc', el).textContent = FORMATS[format].teams ? 'Team battles: teams add up their members, the winning team splits the pot.' : '';
    $$('#modes button', el).forEach(b => b.onclick = () => { mode = b.dataset.m; sfx.click(); drawModes(); drawBar(); });
  };

  // ---- player formats ----
  const seatsIcons = k => {
    const f = FORMATS[k], one = n => Array.from({ length: n }, () => icon('user')).join('');
    return f.teams ? f.teams.map(t => one(t.length)).join('<i class="vs">vs</i>') : one(f.size);
  };
  const drawFormats = () => {
    const btn = k => `<button data-f="${k}" class="${k === format ? 'on' : ''}"><span class="bt2-seats">${seatsIcons(k)}</span><b>${FORMATS[k].label}</b></button>`;
    $('#fSolo', el).innerHTML = SOLO.map(btn).join('');
    $('#fTeam', el).innerHTML = TEAMS.map(btn).join('');
    $$('.bt2-fbtns button', el).forEach(b => b.onclick = () => { format = b.dataset.f; sfx.click(); drawFormats(); drawModes(); drawBar(); });
  };

  // Selected cases are kept as { id: qty } in the order they were first added; rounds run in that order.
  const qty = new Map();
  const MAX = 20;
  const total = () => [...qty.values()].reduce((a, b) => a + b, 0);
  const sync = () => { picked.length = 0; qty.forEach((n, id) => { for (let i = 0; i < n; i++) picked.push(id); }); };
  const change = (id, d) => {
    const cur = qty.get(id) || 0, next = Math.max(0, cur + d);
    if (d > 0 && total() >= MAX) return toast(`Up to ${MAX} cases per battle`, 'error');
    if (next === 0) qty.delete(id); else qty.set(id, next);
    sync(); sfx.click();
  };
  if (draft) { draft.ids.forEach(id => qty.set(id, (qty.get(id) || 0) + 1)); sync(); draft = null; }
  const stepper = (id, n) => `<div class="stepper"><button data-d="-1" data-id="${id}" aria-label="Fewer">−</button><b>${n}</b><button data-d="1" data-id="${id}" aria-label="More">+</button></div>`;
  const reorder = fn => { const e = fn([...qty.entries()]); qty.clear(); e.forEach(([k, v]) => qty.set(k, v)); sync(); drawPicked(); sfx.click(); };

  // ---- case slots ----
  const drawSlots = () => {
    const entries = [...qty.entries()];
    const slots = entries.map(([id, n], i) => {
      const c = CASE[id];
      return `<div class="bt2-slot" style="--hue:${c.hue}"><button class="bt2-x" data-rm="${id}" aria-label="Remove ${esc(c.name)}">✕</button><span class="bt2-pos">${i + 1}</span><div class="bt2-art">${caseArt(c)}</div><b>${esc(c.name)}</b>${money(c.price)}${stepper(id, n)}</div>`;
    }).join('');
    const add = `<button class="bt2-slot add" id="openPicker"><span class="bt2-plus">+</span><b>Add cases</b><small>Search, sort & pick</small></button>`;
    const empties = Array.from({ length: Math.max(0, 6 - entries.length - 1) }, () => '<button class="bt2-slot empty" data-open aria-label="Add a case"></button>').join('');
    $('#slots', el).innerHTML = slots + add + empties;
    $('#caseCount', el).textContent = `${total()} selected`;
    $$('#slots .stepper button', el).forEach(b => b.onclick = () => { change(b.dataset.id, +b.dataset.d); drawPicked(); });
    $$('[data-rm]', el).forEach(b => b.onclick = () => { qty.delete(b.dataset.rm); sync(); sfx.click(); drawPicked(); });
    $('#openPicker', el).onclick = openPicker;
    $$('[data-open]', el).forEach(b => b.onclick = openPicker);
  };

  // ---- summary + create ----
  const drawBar = () => {
    const size = FORMATS[format].size, cost = costOf(picked);
    $('#sum', el).innerHTML = `
      <div><span>Rounds</span><b>${picked.length}</b></div>
      <div><span>Players</span><b>${size}</b></div>
      <div><span>Your cost</span>${money(cost)}</div>
      <div><span>Average pot</span>${money(round2(cost * size * AVG_RETURN))}</div>`;
    const btn = $('#createBtn', el);
    btn.disabled = !picked.length;
    btn.innerHTML = picked.length ? `${icon('battles')} Create battle ${money(cost)}` : 'Add at least one case';
  };
  const drawPicked = () => { drawSlots(); drawBar(); };

  $('#tAsc', el).onclick = () => reorder(e => e.sort((a, b) => CASE[a[0]].price - CASE[b[0]].price));
  $('#tDesc', el).onclick = () => reorder(e => e.sort((a, b) => CASE[b[0]].price - CASE[a[0]].price));
  $('#tShuf', el).onclick = () => reorder(e => { for (let i = e.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [e[i], e[j]] = [e[j], e[i]]; } return e; });
  $('#tClear', el).onclick = () => { qty.clear(); sync(); sfx.click(); drawPicked(); };
  $('#tRand', el).onclick = () => {
    const n = 3 + Math.floor(Math.random() * 3);
    let pool = CASES.filter(c => c.price * n <= Math.max(state.balance, 3));
    if (pool.length < n) pool = [...CASES].sort((a, b) => a.price - b.price).slice(0, 8);
    qty.clear();
    [...pool].sort(() => Math.random() - 0.5).slice(0, n).forEach(c => qty.set(c.id, 1));
    sync(); sfx.click(); drawPicked();
  };
  $$('.speed-seg button', el).forEach(b => b.onclick = () => { state.speed = b.dataset.speed; save(); $$('.speed-seg button', el).forEach(x => x.classList.toggle('active', x === b)); });

  /** "Add cases" picker: search, sort, max-price filter and +/- quantities, like the reference sites. */
  function openPicker() {
    let q = '', sort = 'asc';
    const maxPrice = Math.ceil(Math.max(...CASES.map(c => c.price)));
    let cap = maxPrice;
    const m = modal(`<h2>Add cases</h2>
      <div class="picker-tools"><input id="pq" class="search" placeholder="Search cases…" autocomplete="off">
        <select id="ps" style="width:auto"><option value="asc">Lowest price</option><option value="desc">Highest price</option><option value="name">Name</option></select>
        <label class="small muted range-l">Max price <b id="pcapV"></b><input id="pcap" type="range" min="1" max="${maxPrice}" value="${maxPrice}"></label></div>
      <div class="picker-grid" id="pg"></div>
      <div class="picker-foot"><span id="pTot"></span><button class="btn btn-primary" id="pDone">Done</button></div>`, { wide: true, onClose: drawPicked });
    const draw = () => {
      $('#pcapV', m.el).innerHTML = money(cap);
      const list = CASES.filter(c => c.price <= cap && c.name.toLowerCase().includes(q))
        .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'asc' ? a.price - b.price : b.price - a.price));
      $('#pg', m.el).innerHTML = list.map(c => {
        const n = qty.get(c.id) || 0;
        return `<div class="pick-case ${n ? 'on' : ''}" style="--hue:${c.hue}">${caseArt(c)}<b>${esc(c.name)}</b>${money(c.price)}
          ${n ? stepper(c.id, n) : `<button class="btn btn-ghost btn-sm block" data-add="${c.id}">Add case</button>`}</div>`;
      }).join('') || '<div class="muted">No cases match.</div>';
      $('#pTot', m.el).innerHTML = `${total()} case${total() === 1 ? '' : 's'} · ${money(costOf([...picked]))}`;
      $$('[data-add]', m.el).forEach(b => b.onclick = () => { change(b.dataset.add, 1); draw(); });
      $$('#pg .stepper button', m.el).forEach(b => b.onclick = () => { change(b.dataset.id, +b.dataset.d); draw(); });
    };
    $('#pq', m.el).oninput = e => { q = e.target.value.trim().toLowerCase(); draw(); };
    $('#ps', m.el).onchange = e => { sort = e.target.value; draw(); };
    $('#pcap', m.el).oninput = e => { cap = +e.target.value; draw(); };
    $('#pDone', m.el).onclick = m.close;
    draw();
    $('#pq', m.el).focus();
  }
  $('#createBtn', el).onclick = async () => {
    const b = await createBattle([...picked], format, mode);
    if (b) location.hash = `#/battle/${b.id}`;
  };
  drawFormats(); drawModes(); drawPicked();

}

/** Landing page of Case battles: only the open battles, with a button that opens the creator. */
export function renderList(el) {
  let filter = 'all', sort = 'new';
  const LIVE = isLive();
  const liveLobbies: any[] = [];
  const lobs = (): any[] => (LIVE ? liveLobbies : lobbies);
  let stopWatch: (() => void) | null = null, alive = true;
  el.innerHTML = `
    <div class="page-head bt2-head bt2-listhead">
      <div><h1>${icon('battles')} Case battles</h1>
        <p class="muted"><b class="bt2-live" id="stOpen">0</b> active battles · <span id="stPot"></span> in the pot. Join one below or start your own.${LIVE ? ' <b class="cf-livetag">Live: real players</b>' : ''}</p></div>
      <div class="bt2-headr">
        <label class="bt2-sort"><span class="muted small">Sort</span><select id="lobSort"><option value="new">Newest</option><option value="cost">Highest cost</option><option value="cheap">Lowest cost</option></select></label>
        <a class="btn btn-primary btn-lg" href="#/battles/create" id="goCreate" data-needs-auth="battle">${icon('battles')} Create battle</a>
      </div>
    </div>
    <section class="bt2-open">
      <div class="panel-head"><h2><span class="live-dot"></span> Open battles</h2>
        <div class="tabs" id="lobTabs"><button class="tab active" data-f="all">All</button><button class="tab" data-f="solo">Solo</button><button class="tab" data-f="team">Teams</button><button class="tab" data-f="cheap">Under 5</button></div></div>
      <div class="bt2-lobbies" id="lobbies"></div>
    </section>`;

  const lobRow = l => {
    const f = FORMATS[l.format], open = f.size - l.bots.length, cost = costOf(l.ids);
    const more = l.ids.length > 5 ? `<em class="bt2-more">+${l.ids.length - 5}</em>` : '';
    return `<div class="bt2-lobby m-${l.mode}">
      <div class="bt2-lc">${l.ids.slice(0, 5).map(id => `<span class="bt2-mini" title="${esc(CASE[id].name)}">${caseArt(CASE[id])}</span>`).join('')}${more}</div>
      <div class="bt2-lt"><span class="tag ${l.mode}">${MODES[l.mode].label}</span><b>${f.label}</b><small>${l.ids.length} round${l.ids.length === 1 ? '' : 's'}</small></div>
      <div class="bt2-ls">${l.bots.map(b => avatar(b, 30)).join('')}${Array.from({ length: open }, () => '<span class="seat-empty">+</span>').join('')}</div>
      <div class="bt2-lcost"><b>${money(cost)}</b><small>Battle cost</small></div>
      <button class="btn btn-primary" data-id="${l.uid}" data-needs-auth="battle">${l.mine ? 'Open battle' : 'Join battle'}</button></div>`;
  };
  const drawLobbies = () => {
    let shown = lobs().filter(l => filter === 'all' || (filter === 'solo' ? !FORMATS[l.format].teams : filter === 'team' ? FORMATS[l.format].teams : costOf(l.ids) < 5));
    if (sort === 'cost') shown = [...shown].sort((a, b) => costOf(b.ids) - costOf(a.ids));
    if (sort === 'cheap') shown = [...shown].sort((a, b) => costOf(a.ids) - costOf(b.ids));
    $('#lobbies', el).innerHTML = shown.map(lobRow).join('') || `<div class="ac-empty muted">No battles match this filter right now. <a href="#/battles/create" data-needs-auth="battle">Create one</a>${LIVE ? ' and send the link to a friend.' : ''}</div>`;
    $('#stOpen', el).textContent = lobs().length;
    $('#stPot', el).innerHTML = money(round2(lobs().reduce((sum, l) => sum + costOf(l.ids) * FORMATS[l.format].size, 0)));
    $$('#lobbies [data-id]', el).forEach(btn => btn.onclick = async () => {
      const l = lobs().find(x => String(x.uid) === btn.dataset.id);
      if (!l) return toast('That battle just filled up', 'error');
      if (LIVE) {
        if (l.mine) { location.hash = `#/battle/${l.uid}`; return; }
        const cost = costOf(l.ids);
        if (!debit(cost)) return toast(debitError(cost), 'error');
        try {
          const r = await joinLiveBattle(l.uid);
          if (r.status === 'running') freezeBalance(cost);          // I filled the last seat: the database may have paid me already; the page shows it when the battle ends
          tellBalance(r); location.hash = `#/battle/${l.uid}`;
        }
        catch (e) { credit(cost); toast(e instanceof Error ? e.message : 'Could not join', 'error'); void loadLive(); }
        return;
      }
      const b = await createBattle(l.ids, l.format, l.mode, l.bots);
      if (b) { lobs().splice(lobs().indexOf(l), 1); location.hash = `#/battle/${b.id}`; }
    });
  };
  $$('#lobTabs .tab', el).forEach(t => t.onclick = () => { $$('#lobTabs .tab', el).forEach(x => x.classList.toggle('active', x === t)); filter = t.dataset.f; drawLobbies(); });
  $('#lobSort', el).onchange = e => { sort = e.target.value; drawLobbies(); };
  drawLobbies();
  // Real lobbies come from the server and change as players join; simulated ones come and go on a timer.
  const asLobby = (r: LiveBattle) => ({ uid: r.id, ids: r.case_ids, format: r.format, mode: r.mode, bots: r.seats.filter(Boolean).map(x => (x as { name: string }).name), mine: r.player_ids.includes(liveMe()) });
  async function loadLive() {
    try { const rows = await openLiveBattles(); liveLobbies.length = 0; rows.filter(validBattle).forEach(r => liveLobbies.push(asLobby(r))); drawLobbies(); }
    catch { toast('Could not load the live battles', 'error'); }
  }
  if (LIVE) {
    void loadLive();
    void watchBattles((_ev, r) => {
      if (!alive || !validBattle(r)) return;
      const i = liveLobbies.findIndex(x => x.uid === r.id);
      if (i >= 0) liveLobbies.splice(i, 1);
      if (r.status === 'waiting') liveLobbies.unshift(asLobby(r));
      drawLobbies();
    }).then(stop => { if (alive) stopWatch = stop; else stop(); }).catch(() => {});
  }
  const timer = LIVE ? 0 : setInterval(() => { lobbies.pop(); lobbies.unshift(makeLobby()); drawLobbies(); }, 7000);
  return () => { alive = false; clearInterval(timer); stopWatch?.(); };
}

const PCOLORS = ['#c6ff3d', '#33d6ff', '#ff4fc8', '#ffc53d', '#8f6bff', '#ff6a3d'];
const jackpotWeights = (mode, totals) => {
  const w = totals.map(t => (mode === 'jackpot' ? Math.max(t, 0.01) : 1 / (t + 0.05)));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / s);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (el, msg) => { el.innerHTML = `<div class="panel empty"><h2>Battle not found</h2><p class="muted">${msg}</p><a class="btn btn-primary" href="#/battles">Back to battles</a></div>`; };

export function renderBattle(el, id) {
  if (UUID.test(id)) return renderLiveBattle(el, id);
  const b = battles.get(id);
  if (!b) { notFound(el, 'Battles only live in this browser tab.'); return; }
  return drawBattle(el, b);
}

/** A battle held by the server: load it, show it, and keep it in step with what the other players do. */
function renderLiveBattle(el, id) {
  if (!isLive()) { notFound(el, 'Log in to open a live battle. If you are logged in, give it a second to connect.'); return; }
  let alive = true, stopWatch: (() => void) | null = null, inner: (() => void) | undefined;
  el.innerHTML = '<div class="panel empty"><h2>Loading battle…</h2></div>';
  void (async () => {
    const row = await getLiveBattle(id).catch(() => null);
    if (!alive) return;
    if (!row || !validBattle(row)) return notFound(el, 'It may have been removed, or it uses cases this site does not know.');
    if (row.status === 'cancelled') return notFound(el, 'That battle was cancelled.');
    const b = toBattle(row);
    if (b.running) {
      const seed = await seedWithRetry(id);
      if (!alive) return;
      if (!seed) return notFound(el, 'The result is not available yet. Try again in a moment.');
      await resolveLive(b, seed);
    }
    inner = drawBattle(el, b);
    const stop = await watchBattles((_ev, r) => { if (r.id === id) void b.onRow?.(r); }).catch(() => null);
    if (!alive) { stop?.(); return; }
    stopWatch = stop;
    const fresh = await getLiveBattle(id).catch(() => null);               // anything that happened before the subscription was ready
    if (fresh && alive) void b.onRow?.(fresh);
  })();
  return () => { alive = false; stopWatch?.(); inner?.(); };
}

function drawBattle(el, b) {
  let alive = true, run = 0;
  const mi = (): number => (b.live ? b.me : 0);             // my seat (always the first in a simulated battle; -1 when only watching)
  const P = b.players.length;
  const teams = FORMATS[b.format].teams;
  const teamOf = p => (teams ? teams.findIndex(t => t.includes(p)) : -1);
  const isJackpot = b.mode === 'jackpot' || b.mode === 'crazyjackpot';
  // The × separator sits between players (between teams in team formats).
  const hasSep = i => i > 0 && (!teams || teamOf(i) !== teamOf(i - 1));
  const seatHtml = i => (b.joined[i]
    ? `<div class="seat-wait ready">${icon('fair')}<b>Ready</b><span>to battle</span></div>`
    : `<div class="seat-wait"><span class="spinner"></span><b>Waiting</b>${seatButton(i)}</div>`);
  const seatButton = i => (!b.live || b.isCreator
    ? `<button class="btn btn-sm btn-primary call-bot" data-needs-auth="battle" data-seat="${i}">Call bot</button>`
    : b.me < 0 ? `<button class="btn btn-sm btn-primary join-seat" data-needs-auth="battle" data-seat="${i}">Join ${fmt(b.cost)}</button>` : '');

  const R = b.ids.length;
  const pad2 = n => String(n).padStart(2, '0');
  const slotEmpty = r => `<span>Round</span><b>${pad2(r + 1)}</b>`;
  const pbarInner = i => {
    const p = b.players[i], j = b.joined[i];
    return `<div class="pb-top">${j ? avatar(p.name, 30) : '<span class="avatar empty-av" style="width:30px;height:30px">?</span>'}
      <span class="pname">${j ? esc(p.name) : 'Empty seat'}</span></div>
      <div class="pb-bot">${p.bot && j ? '<span class="tag bot">BOT</span>' : ''}${teams ? `<span class="tag team">T${teamOf(i) + 1}</span>` : ''}<span class="muted small" id="twLbl${i}">Total</span><b id="tot${i}">${money(0)}</b><span class="chance-chip" id="chip${i}" hidden></span></div>`;
  };

  el.innerHTML = `
    <div class="bt-top">
      <a class="back" href="#/battles">← Back to battles</a>
      <div class="bt-title"><h1>${FORMATS[b.format].label} ${MODES[b.mode].label}</h1><span class="tag ${b.mode}">${MODES[b.mode].label}</span></div>
      <div class="bt-tools"><span class="viewers" title="Watching this battle">${icon('user')} ${b.viewers}</span><a class="btn btn-ghost btn-sm" href="#/fair" title="${b.live ? 'Server hash ' + b.hash : 'Fairness'}">${icon('fair')} Fairness</a><button class="btn btn-ghost btn-sm" id="shareB">Share</button></div>
    </div>
    <div class="bt-sub">
      <div class="bt-total"><span class="muted small">Total</span><span id="pot">${money(0)}</span><span class="muted small">· cost ${fmt(b.cost)}</span></div>
      <div class="bt-cases"><div class="cur-case" id="curCase"><b>${esc(CASE[b.ids[0]].name)}</b>${money(CASE[b.ids[0]].price)}</div>
        <div class="round-cases" id="roundCases">${b.ids.map((cid, i) => `<button class="mini-case" data-r="${i}" data-c="${cid}" title="${esc(CASE[cid].name)}: see contents">${caseArt(CASE[cid])}</button>`).join('')}</div>
        <span class="rcount" id="roundLbl">0/${R}</span></div>
      <div class="bt-ctl">${speedSeg(state.speed)}</div>
    </div>
    <div class="bt-status"><div><h2 id="bStatus">Waiting for players…</h2><span class="muted small">${MODES[b.mode].desc}</span></div>
      <div class="row lobby-ctl" id="lobbyCtl"><button class="btn btn-primary" id="callAll" data-needs-auth="battle">Call all bots</button><button class="btn btn-ghost" id="cancelB">Cancel battle</button></div></div>
    <div id="jpRoll"></div>
    <div class="battle-stage bt-stage ${teams ? 'teams' : ''}" style="--P:${P}">
      <span class="stage-arrow l"></span><span class="stage-arrow r"></span><div class="stage-line"></div>
      <div class="bt-grid">${b.players.map((p, i) => `<div class="bt-reel ${hasSep(i) ? 'has-vs' : ''}" data-p="${i}" style="--pc:${PCOLORS[i]}"><div class="reel-host vreel" id="reel${i}">${seatHtml(i)}</div></div>`).join('')}</div>
    </div>
    <div class="bt-grid bt-players" style="--P:${P}">${b.players.map((p, i) => `<div class="pbar ${hasSep(i) ? 'has-vs' : ''}" id="pbar${i}" data-p="${i}" style="--pc:${PCOLORS[i]}">${pbarInner(i)}</div>`).join('')}</div>
    <div class="bt-grid bt-slots" style="--P:${P}">${b.players.map((p, i) => `<div class="slots ${hasSep(i) ? 'has-vs' : ''}" id="items${i}" data-p="${i}">${b.ids.map((c, r) => `<div class="slot" id="slot${i}_${r}">${slotEmpty(r)}</div>`).join('')}</div>`).join('')}</div>`;

  const colsOf = p => $$(`[data-p="${p}"]`, el);
  $('#shareB', el).onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Battle link copied'); } catch { toast('Copy the address bar to share'); } };

  $$('.speed-seg button', el).forEach(btn => btn.onclick = () => { state.speed = btn.dataset.speed; save(); $$('.speed-seg button', el).forEach(x => x.classList.toggle('active', x === btn)); });

  // Click any case in the round strip to see what's inside it.
  $$('#roundCases .mini-case', el).forEach(m => m.onclick = () => {
    const c = CASE[m.dataset.c];
    modal(`<h2>${esc(c.name)} <span class="muted small">${money(c.price)}</span></h2>
      <div class="contents">${c.entries.map(e => itemCard(e.item, { extra: `<div class="chance">${(e.chance * 100).toFixed(e.chance < 0.01 ? 3 : 2)}%</div>` })).join('')}</div>`, { wide: true });
  });

  // ---- lobby: empty seats wait for players (live) or until you call a bot (simulated) ----
  let onFull = null;
  const redrawSeat = (i, joinedNow) => {
    $(`#reel${i}`, el).innerHTML = seatHtml(i);
    $(`#pbar${i}`, el).innerHTML = pbarInner(i);
    if (joinedNow) $(`#pbar${i}`, el).classList.add('just-joined');
  };
  const callBot = i => {
    if (b.joined[i] || b.started) return;
    if (b.live) return callLiveSeat(i);
    b.joined[i] = true;
    redrawSeat(i, true);
    sfx.click();
    if (b.joined.every(Boolean)) onFull?.();
  };
  const botName = () => randomBot(b.players.map(p => p.name));
  async function callLiveSeat(i) {
    try { const r = await callLiveBot(b.id, i, botName()); await b.onRow(r); sfx.click(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not call a bot', 'error'); }
  }
  async function joinLiveSeat(i) {
    if (b.me >= 0 || b.started) return;
    if (!debit(b.cost)) return toast(debitError(b.cost), 'error');
    try {
      const r = await joinLiveBattle(b.id, i);
      if (r.status === 'running') freezeBalance(b.cost);
      await b.onRow(r); tellBalance(r); sfx.click();
    }
    catch (e) { credit(b.cost); toast(e instanceof Error ? e.message : 'Could not join', 'error'); }
  }
  el.addEventListener('click', e => {
    const bot = e.target.closest('.call-bot'); if (bot) callBot(+bot.dataset.seat);
    const join = e.target.closest('.join-seat'); if (join) void joinLiveSeat(+join.dataset.seat);
  });
  $('#callAll', el).onclick = async () => {
    for (let i = 1; i < P; i++) { if (!b.joined[i]) { callBot(i); await sleep(b.live ? 350 : 180); } }
  };
  const cancelBattle = silent => {
    if (b.started || b.cancelled) return;
    if (b.live) {
      if (b.me < 0) { if (!silent) location.hash = '#/battles'; return; }
      const creator = b.isCreator;
      leaveLiveBattle(b.id).then(() => {
        refundOnce(creator ? `b:${b.id}` : `bl:${b.id}:${Date.now()}`, b.cost);
        if (!silent) { toast(creator ? `Battle cancelled: ${fmt(b.cost)} refunded` : `You left the battle: ${fmt(b.cost)} refunded`); location.hash = '#/battles'; }
      }).catch(e => { if (!silent) toast(e instanceof Error ? e.message : 'Could not leave', 'error'); });
      return;
    }
    b.cancelled = true; b.credited = true;
    credit(b.cost);
    if (!silent) { toast(`Battle cancelled: ${fmt(b.cost)} refunded`); location.hash = '#/battles'; }
  };
  $('#cancelB', el).onclick = () => cancelBattle(false);

  // Live: the buttons depend on who I am in this battle.
  const refreshCtl = () => {
    if (!b.live) return;
    const ctl = $('#lobbyCtl', el); if (!ctl) return;
    $('#callAll', el).hidden = !b.isCreator;
    $('#cancelB', el).hidden = b.me < 0;
    $('#cancelB', el).textContent = b.isCreator ? 'Cancel battle' : 'Leave battle';
    ctl.hidden = b.me < 0;
  };
  refreshCtl();
  /** One row from the server (my own call's answer or a realtime event). Idempotent. */
  b.onRow = async (r: LiveBattle) => {
    if (!alive || b.started) return;
    if (r.status === 'cancelled') {
      if (b.cancelled) return;
      b.cancelled = true;
      if (b.me >= 0 && refundOnce(`b:${b.id}`, b.cost)) toast(`The creator cancelled this battle: ${fmt(b.cost)} refunded`);
      location.hash = '#/battles';
      return;
    }
    const before = b.joined.slice();
    r.seats.forEach((x, i) => { b.joined[i] = !!x; b.players[i] = x ? { name: x.name, bot: x.bot, uid: x.uid } : { name: '', bot: false, uid: null }; });
    b.me = r.seats.findIndex(x => !!x && x.uid === liveMe());
    b.viewers = r.seats.filter(Boolean).length;
    $('.viewers', el).innerHTML = `${icon('user')} ${b.viewers}`;
    b.players.forEach((_, i) => redrawSeat(i, !before[i] && b.joined[i]));
    refreshCtl();
    if (r.status === 'running' && !b.running) {
      b.running = true;
      if (serverWallet() && b.me >= 0) freezeBalance(0);       // the database pays the winners now; keep my balance as it was until the reels stop
      const seed = await seedWithRetry(b.id);
      if (!seed) { toast('Could not load the battle result. Reload the page.', 'error'); return; }
      await resolveLive(b, seed);
      if (alive) onFull?.();
    }
  };

  const setChip = (p, text) => { const c = $(`#chip${p}`, el); c.hidden = !text; c.textContent = text || ''; };
  const updateChips = (running, points) => {
    if (isJackpot) jackpotWeights(b.mode, running).forEach((w, p) => setChip(p, `${(w * 100).toFixed(1)}%`));
    else if (b.mode === 'pointrush') points.forEach((pt, p) => setChip(p, `${pt} pt${pt === 1 ? '' : 's'}`));
    else if (b.mode !== 'group' && !teams && running.some(v => v > 0)) {
      const target = b.mode === 'crazy' ? Math.min(...running) : Math.max(...(b.mode === 'terminal' ? running : running));
      running.forEach((v, p) => setChip(p, v === target ? 'LEADING' : ''));
    }
  };

  /** Jackpot: player-coloured segments (sized by chance) slide under the marker and stop at the fair roll. */
  const jackpotRoll = async live => {
    const box = $('#jpRoll', el);
    box.innerHTML = `<div class="jp-roll"><div class="jp-title muted small">Picking winner</div><div class="jp-window"><div class="jp-track" id="jpTrack"></div><div class="jp-marker"></div></div>
      <div class="jp-foot"><span class="jp-pill">Jackpot ${money(b.pot)}</span><span class="jp-land" id="jpLand"></span></div>
      <div class="jp-legend">${b.chances.map((c, p) => `<span class="chance-chip" style="--pc:${PCOLORS[p]}">${esc(b.players[p].name)} ${(c * 100).toFixed(1)}%</span>`).join('')}</div></div>`;
    const win = $('.jp-window', box), track = $('#jpTrack', box);
    const W = win.clientWidth, REPS = 8, LAND = 6;
    // Each segment shows its owner's avatar and win % (when there's room), like the reference site.
    const rep = b.chances.map((c, p) => `<div class="jp-seg" style="width:${c * W}px;--pc:${PCOLORS[p]}">${c * W > 34 ? avatar(b.players[p].name, 24) : ''}${c * W > 70 ? `<span class="seg-pct">${(c * 100).toFixed(2)}%</span>` : ''}</div>`).join('');
    track.innerHTML = rep.repeat(REPS);
    const at = f => W / 2 - (LAND * W + f * W);
    track.style.transform = `translate3d(${W / 2 - W * 0.5}px,0,0)`;
    void track.offsetWidth;
    const ms = state.speed === 'turbo' ? 1800 : state.speed === 'fast' ? 3000 : 4800;
    track.style.transition = `transform ${ms}ms cubic-bezier(.1,.65,.1,1)`;
    track.style.transform = `translate3d(${at(b.jackpotF)}px,0,0)`;
    sfx.click();
    // tick each time a segment boundary passes the marker
    let last = -1;
    const t0 = performance.now();
    while (live() && performance.now() - t0 < ms + 50) {
      const m = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      const pos = (W / 2 - m) / W;
      const frac = pos - Math.floor(pos);
      let acc = 0, seg = 0;
      for (; seg < b.chances.length; seg++) { acc += b.chances[seg]; if (frac < acc) break; }
      const key = Math.floor(pos) * 10 + seg;
      if (key !== last) { if (last !== -1) sfx.tick(); last = key; }
      const lbl = $('#jpLand', box);
      if (lbl && b.players[seg]) lbl.innerHTML = `<i style="background:${PCOLORS[seg]}"></i>${esc(b.players[seg].name)} · ${(b.chances[seg] * 100).toFixed(2)}%`;
      await sleep(30);
    }
  };

  const play = async (replay) => {
    const my = ++run;
    const live = () => alive && my === run;
    const running = Array(P).fill(0), points = Array(P).fill(0);
    $('#jpRoll', el).innerHTML = '';
    for (let i = 0; i < P; i++) {
      b.ids.forEach((_, r) => { const s = $(`#slot${i}_${r}`, el); s.className = 'slot'; s.innerHTML = slotEmpty(r); });
      $(`#tot${i}`, el).innerHTML = money(0); $(`#twLbl${i}`, el).textContent = 'Total'; setChip(i, '');
    }
    $$('[data-p]', el).forEach(n => n.classList.remove('winner', 'loser'));
    if (isJackpot) updateChips(running, points);
    $('.bt-status .after')?.remove();
    if (!replay) {
      if (!b.joined.every(Boolean)) {
        $('#bStatus', el).textContent = 'Waiting for players…';
        await new Promise(res => { onFull = res; });
        await sleep(500);
      }
      if (!live() || b.cancelled) return;
      b.started = true;
      $('#lobbyCtl', el)?.remove();
      // Countdown while "waiting for the block" that seeds the rolls (shown as a big overlay).
      const stage = $('.battle-stage', el);
      const ov = document.createElement('div');
      ov.className = 'countdown-ov';
      const block = 4e8 + Math.floor(b.jackpotF * 1e8);
      stage.append(ov);
      for (let n = 3; n >= 1; n--) {
        if (!live()) { ov.remove(); return; }
        ov.innerHTML = `<b class="cd-num">${String(n).padStart(2, '0')}</b><span>Waiting for block</span><code>#${block.toLocaleString('en-US')}</code>`;
        sfx.tick();
        await sleep(state.speed === 'turbo' ? 350 : 750);
      }
      ov.classList.add('out');
      setTimeout(() => ov.remove(), 300);
      await sleep(200);
    }
    for (let r = 0; r < b.ids.length; r++) {
      if (!live()) return;
      const c = CASE[b.ids[r]];
      $$('#roundCases .mini-case', el).forEach(m => m.classList.toggle('current', +m.dataset.r === r));
      $('#curCase', el).innerHTML = `<b>${esc(c.name)}</b>${money(c.price)}`;
      $('#roundLbl', el).textContent = `${r + 1}/${b.ids.length}`;
      b.players.forEach((_, p) => $(`#slot${p}_${r}`, el).classList.add('active'));
      $('#bStatus', el).textContent = `${replay ? 'Replay · ' : ''}Round ${r + 1} of ${b.ids.length}`;
      const dur = Math.round(reelMs() * 0.6);
      await preloadImages(c.entries.map(e => e.item));                  // the reels start with every picture in place
      await Promise.all(b.players.map((_, p) => spinReel($(`#reel${p}`, el), c.entries, b.results[p][r], { axis: 'y', duration: dur, total: 40, winIndex: 34, sound: p === mi() })));
      if (!live()) return;
      const top = Math.max(...b.players.map((_, p) => b.results[p][r].value));
      b.players.forEach((_, p) => {
        const it = b.results[p][r];
        running[p] = round2(running[p] + it.value);
        if (b.mode === 'pointrush' && it.value === top) points[p]++;
        $(`#tot${p}`, el).innerHTML = money(running[p]);
        // Fill this round's slot with the item (fixed grid: nothing shifts or overlaps).
        const s = $(`#slot${p}_${r}`, el);
        s.className = 'slot filled';
        s.style.setProperty('--rc', RARITY[it.rarity].color);
        s.innerHTML = `<span class="slot-n">#${r + 1}</span>${itemArt(it)}<b class="slot-name">${esc(it.skin)}</b>${money(it.value)}`;
      });
      updateChips(running, points);
      // The value under each landed item turns green for the round's best pull (lowest in Crazy modes), red otherwise.
      const vals = b.players.map((_, p) => b.results[p][r].value);
      const lowWins = b.mode === 'crazy' || b.mode === 'crazyjackpot';
      const best = lowWins ? Math.min(...vals) : Math.max(...vals);
      b.players.forEach((_, p) => $(`#reel${p} .reel-won`, el)?.classList.add(vals[p] === best ? 'best' : 'worse'));
      $('#pot', el).innerHTML = money(running.reduce((s, v) => s + v, 0));
      sfx.tick();
      await sleep(state.speed === 'turbo' ? 150 : 400);
    }
    if (!live()) return;

    if (isJackpot) {
      $('#bStatus', el).textContent = 'Rolling the jackpot…';
      await jackpotRoll(live);
      if (!live()) return;
      await sleep(300);
    }

    if (!replay) {
      settle(b);
      if (mi() >= 0) b.results[mi()].forEach(it => pushDrop({ user: state.name, item: it, source: 'Battle' }));
    }
    const share = round2(b.pot / b.winners.length);
    b.players.forEach((_, p) => {
      const w = b.winners.includes(p);
      colsOf(p).forEach(n => n.classList.add(w ? 'winner' : 'loser'));
      $(`#twLbl${p}`, el).textContent = 'Winnings';
      $(`#tot${p}`, el).innerHTML = money(w ? share : 0);
    });
    const won = mi() >= 0 && b.winners.includes(mi());
    $('#bStatus', el).innerHTML = b.mode === 'group' ? `Pot split: ${money(share)} each`
      : won ? `You won ${money(share)}!`
      : teams ? `Team ${teamOf(b.winners[0]) + 1} won the pot`
      : `${esc(b.players[b.winners[0]].name)} won the pot`;
    // Confetti over the winning column(s), like the reference sites.
    b.winners.forEach(p => burstOver($(`.bt-reel[data-p="${p}"]`, el), PCOLORS[p]));
    if (!replay) { if (won && b.mode !== 'group') sfx.big(); else if (won) sfx.win(); else sfx.lose(); }
    const canUpgrade = won && share > 0;
    $('.bt-status', el).insertAdjacentHTML('beforeend', `<div class="row after">
      <button class="btn btn-ghost" id="replay">Replay</button>
      <button class="btn btn-ghost" id="editB">Edit</button>
      ${canUpgrade ? `<button class="btn btn-cash" id="upWin">${icon('upgrade')} Upgrade win</button>` : ''}
      <button class="btn btn-primary" id="rematch" data-needs-auth="battle">Recreate ${money(b.cost)}</button></div>`);
    $('#replay', el).onclick = () => play(true);
    $('#editB', el).onclick = () => { draft = { ids: [...b.ids], format: b.format, mode: b.mode }; location.hash = '#/battles/create'; };
    if (canUpgrade) $('#upWin', el).onclick = () => { handoff.upgradeCoins = share; location.hash = '#/upgrade'; };
    $('#rematch', el).onclick = async () => {
      const nb = await createBattle(b.ids, b.format, b.mode, b.live ? [] : b.players.filter(p => p.bot).map(p => p.name));
      if (nb) location.hash = `#/battle/${nb.id}`;
    };
  };
  play(false);

  // Leaving a lobby that hasn't started cancels it and refunds you; a started battle is settled.
  return () => {
    alive = false;
    if (b.live ? b.running : b.started) settle(b);        // a battle that is already decided is paid out even if I leave early
    else cancelBattle(true);
  };
}

/** Confetti that bursts from a specific element (the winner's column). */
function burstOver(node, color) {
  if (!node) return;
  const r = node.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 46; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${r.left + Math.random() * r.width}px;top:${Math.max(0, r.top - 10)}px;background:${i % 3 ? color : '#ffc53d'};animation-delay:${Math.random() * 0.25}s;animation-duration:${1.2 + Math.random() * 0.8}s;transform:rotate(${Math.random() * 360}deg)`;
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 2600);
}
