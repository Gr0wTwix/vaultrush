// Double: shared rounds on a 15-tile reel. Purple/Gray 2×, Green 14×, Bait 7× (tiles beside green).
import { randomBot } from '../data.js';
import { state, save, debit, credit, round2, debitError } from '../state.js';
import { bet, annotate, doubleRoll, doubleColor, doubleWins, DOUBLE_PAY, DOUBLE_TILES, getFair } from '../fair.js';
import type { DoubleLane } from '../types.js';
import { pushBet } from '../feed.js';
import { $, $$, fmt, money, icon, toast, avatar, esc, confetti, coin } from '../ui.js';
import { sfx } from '../sfx.js';
import { roundsOn, liveMe } from '../live.js';
import { advanceRound, serverNow, doubleBet, roundBets, recentResults, roundSeed, watchRounds, watchRoundBets, payBet, recordFinished, settleLater, normBet, type Round, type RoundBet } from '../rounds.js';

const BET_MS = 12000, ROLL_MS = 5200, SHOW_MS = 2600;
const LANES = [['purple', 'Purple', '1'], ['bait', 'Bait', '2'], ['green', 'Green', '3'], ['gray', 'Gray', '4']];
const TILE_W = 100, GAP = 10, STEP = TILE_W + GAP;
const TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
const history = [];           // last rolls (shared across visits)
const seenRounds = new Set<number>();   // shared rounds already added to the history
let pool = 180.5;             // Triple Green pool
export const getPool = () => pool;
// Other players keep betting while you are elsewhere, so the pool creeps up in the background.
setInterval(() => { pool = Math.round((pool + Math.random() * 0.6) * 100) / 100; }, 3000);
let greenStreak = [];         // [{ mine, total }] for consecutive green rounds

// Layered glyphs: a base shape in currentColor plus light/shade facets for depth.
const HI = 'fill="#fff" fill-opacity=".38"', SH = 'fill="#000" fill-opacity=".2"';
const GLYPH = {
  // Purple: split-lit lightning bolt
  purple: `<path d="M14 1.5 3.8 13.6h6.9L9.2 22.5 20.2 9.8h-7z"/><path d="M14 1.5 3.8 13.6h6.9z" ${HI}/><path d="M20.2 9.8h-7l-4 12.7z" ${SH}/>`,
  // Gray: faceted gem
  gray: `<path d="M6.8 3h10.4l4.8 6.3L12 21.5 2 9.3z"/><path d="M6.8 3h10.4l4.8 6.3H2z" ${HI}/><path d="M8.6 9.3 12 21.5l3.4-12.2z" ${SH}/><path d="M6.8 3 8.6 9.3 12 3l3.4 6.3L17.2 3" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width=".9" stroke-linejoin="round"/>`,
  // Green: jewelled crown
  green: `<path d="M2.5 7.5 7.4 12 12 3.5l4.6 8.5 4.9-4.5-2 12H4.5z"/><path d="M4 16.4h16l-.5 3.1h-15z" ${SH}/><circle cx="12" cy="13" r="1.7" ${HI}/><circle cx="2.5" cy="7.5" r="1.5"/><circle cx="21.5" cy="7.5" r="1.5"/><circle cx="12" cy="3.3" r="1.6"/>`,
  // Bait: fishing hook
  bait: `<circle cx="13" cy="4" r="2.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M13 6.2v9.6a4.6 4.6 0 0 1-9.2 0v-2.6l3.4 3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
};
const isBait = n => n === 1 || n === 14;
const tile = n => isBait(n)
  ? `<div class="dtile sq-tile ${doubleColor(n)} baity"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH.bait}</svg><em>Bait 7×</em></div>`
  : `<div class="dtile sq-tile ${doubleColor(n)}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[doubleColor(n)]}</svg></div>`;

/** A bet on one lane. Bots and the player share the lane lists; `mine` marks the player's own. */
interface DoubleBet { user: string; amount: number; mine: boolean; result?: 'won' | 'lost' }

export function render(el) {
  let alive = true, timer = 0, raf = 0, phase = 'betting', phaseStart = performance.now();
  let bets: Record<string, DoubleBet[]> = {}, myBets: Record<string, number> = {}, lastBet = null, landIndex = 2 * DOUBLE_TILES, pendingN = null;
  const LIVE = roundsOn();               // one shared round run by the server, with everyone's bets, instead of a solo round with simulated players
  let round: Round | null = null, rbets: RoundBet[] = [], stops: (() => void)[] = [], rtimer = 0, rolledId = 0, settledId = 0;

  const glyph = c => `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[c]}</svg>`;
  const LANE_GLYPH = { purple: glyph('purple'), gray: glyph('gray'), green: glyph('green'), bait: glyph('bait') };

  el.innerHTML = `
    <section class="panel dbl-head">
      <div class="dbl-title"><span class="dbl-badge">${icon('double')}</span><div><h1>Double</h1><span>Classic roulette</span></div></div>
      <div class="dbl-pot"><span class="muted small">Triple Green pot</span><b id="pool"></b><div class="greens" id="streak" title="Green streak"></div></div>
      <div class="dbl-tools"><button class="icon-btn" id="dSound" aria-label="Toggle sound">${icon(state.muted ? 'mute' : 'sound')}</button><a class="icon-btn" href="#/fair" aria-label="Fairness">${icon('fair')}</a></div>
    </section>
    <section class="panel dbl-main">
      <div class="dbl-rows">
        <div class="dbl-col"><span class="muted small">Previous rounds</span><div class="hist" id="hist"></div></div>
        <div class="dbl-progress" aria-hidden="true"><i id="tbar"></i></div>
        <div class="dbl-col right"><span class="muted small">Last 100</span><div class="counts" id="counts"></div></div>
      </div>
      <div class="dreel" id="reel"><div class="dstrip" id="strip">${Array.from({ length: DOUBLE_TILES * 12 }, (_, i) => tile(i % DOUBLE_TILES)).join('')}</div>
        <span class="dmark top"></span><span class="dmark bot"></span>
        <div class="dover" id="dover"><span id="tlabel">Rolling in</span><b id="doverT">12.00</b></div></div>
      <div class="dbl-bet">
        <label class="dbl-amt"><span class="amount-coin">${coin()}</span><input id="amt" type="number" min="0.1" step="0.1" value="1" aria-label="Bet amount"></label>
        <button class="dbtn" data-op="clear" aria-label="Clear">${TRASH}</button>
        ${[0.1, 1, 10, 25, 50, 100, 1000].map(v => `<button class="dbtn" data-add="${v}">+${v}</button>`).join('')}
        <button class="dbtn" data-op="half">1/2</button><button class="dbtn" data-op="double">X2</button><button class="dbtn" data-op="max">Max</button>
      </div>
    </section>
    <div class="lanes">${LANES.map(([k, label, key]) => `
      <div class="lane lane-${k}" data-lane="${k}">
        <button class="lane-btn" data-bet="${k}" data-needs-auth="bet"><span class="lb-ic">${LANE_GLYPH[k]}</span><span class="lb-txt">Place bet <small>${label}</small></span><b>Win ${DOUBLE_PAY[k]}×</b><kbd>${key}</kbd></button>
        <div class="lane-sum"><span id="cnt-${k}">${icon('user')} 0 users</span><span id="tot-${k}">${money(0)}</span></div>
        <div class="lane-list" id="list-${k}"></div>
      </div>`).join('')}
    </div>
    <div class="game-hash"><code id="ghash">${getFair().serverHash}</code><span>Game hash</span></div>`;

  const amt = $('#amt', el), strip = $('#strip', el), reel = $('#reel', el);
  $$('[data-add]', el).forEach(b => b.onclick = () => { amt.value = round2((+amt.value || 0) + +b.dataset.add); });
  $$('[data-op]', el).forEach(b => b.onclick = () => {
    const v = +amt.value || 0, op = b.dataset.op;
    amt.value = op === 'clear' ? '' : op === 'half' ? round2(Math.max(0.1, v / 2)) : op === 'double' ? round2(v * 2) : Math.floor(state.balance * 100) / 100;
  });
  $('#dSound', el).onclick = () => { state.muted = !state.muted; save(); $('#dSound', el).innerHTML = icon(state.muted ? 'mute' : 'sound'); };

  const setStrip = (index, animate, dur = ROLL_MS - 400) => {
    const view = reel.clientWidth;
    const x = view / 2 - (index * STEP + TILE_W / 2);
    strip.style.transition = animate ? `transform ${dur}ms cubic-bezier(.12,.68,.1,1)` : 'none';
    strip.style.transform = `translate3d(${animate ? x + (Math.random() - 0.5) * TILE_W * 0.7 : x}px,0,0)`;
    return x;
  };

  const drawTop = () => {
    $('#pool', el).innerHTML = money(pool);
    $('#streak', el).innerHTML = [0, 1, 2].map(i => `<i class="${i < greenStreak.length ? 'on' : ''}"></i>`).join('');
    $('#hist', el).innerHTML = history.slice(0, 10).map(n => `<span class="hdot ${doubleColor(n)}" title="${n}">${glyph(doubleColor(n))}</span>`).join('') || '<span class="muted small">No rounds yet</span>';
    const last = history.slice(0, 100);
    const c: Record<string, number> = { purple: 0, gray: 0, green: 0, bait: 0 };
    last.forEach(n => { c[doubleColor(n)]++; if (n === 1 || n === 14) c.bait++; });
    $('#counts', el).innerHTML = ['purple', 'gray', 'green'].map(k => `<span class="hdot ${k}">${glyph(k)}</span><b>${c[k]}</b>`).join('') + `<span class="hdot bait">${LANE_GLYPH.bait}</span><b>${c.bait}</b>`;
  };

  const drawLanes = () => {
    LANES.forEach(([k]) => {
      const list = bets[k] || [];
      const total = round2(list.reduce((s, b) => s + b.amount, 0));
      $(`#cnt-${k}`, el).innerHTML = `${icon('user')} ${list.length} user${list.length === 1 ? '' : 's'}`;
      $(`#tot-${k}`, el).innerHTML = money(total);
      $(`#list-${k}`, el).innerHTML = list.length
        ? [...list].sort((a, b) => b.amount - a.amount).slice(0, 12)
          .map(b => `<div class="lrow ${b.mine ? 'mine' : ''} ${b.result || ''}">${avatar(b.user, 22)}<span>${esc(b.user)}</span>${money(b.result === 'won' ? round2(b.amount * DOUBLE_PAY[k]) : b.amount)}</div>`).join('')
        : `<div class="lane-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 18 18 6" stroke="currentColor" stroke-width="1.8"/></svg>No bets yet</div>`;
    });
    $$('.lane-btn', el).forEach(b => b.disabled = phase !== 'betting');
  };

  const place = (lane, amount, user = state.name, mine = true) => {
    if (LIVE) { if (mine) void placeLive(lane, amount); return; }          // other players' bets arrive from the server
    if (phase !== 'betting') return mine && toast('Betting is closed for this round', 'error');
    if (mine) {
      if ((lane === 'purple' && myBets.gray) || (lane === 'gray' && myBets.purple)) return toast("You can't back both Purple and Gray", 'error');
      if (!(amount >= 0.1)) return toast('Minimum bet is 0.10', 'error');
      if (!debit(amount)) return toast(debitError(amount), 'error');
      myBets[lane] = round2((myBets[lane] || 0) + amount);
      lastBet = { lane, amount };
      sfx.click();
    }
    pool = round2(pool + amount * 0.01);
    (bets[lane] ||= []);
    const existing = bets[lane].find(b => b.user === user);
    if (existing) existing.amount = round2(existing.amount + amount); else bets[lane].push({ user, amount, mine });
    drawLanes(); drawTop();
  };
  $$('[data-bet]', el).forEach(b => b.onclick = () => place(b.dataset.bet, round2(+amt.value)));

  const onKey = e => {
    if (e.target.matches('input, textarea')) return;
    const lane = LANES.find(l => l[2] === e.key);
    if (lane) { e.preventDefault(); place(lane[0], round2(+amt.value)); }
    else if (e.code === 'Space' && lastBet) { e.preventDefault(); place(lastBet.lane, lastBet.amount); }
  };
  document.addEventListener('keydown', onKey);

  const botBets = () => {
    const n = 3 + Math.floor(Math.random() * 7);
    for (let i = 0; i < n; i++) {
      const delay = Math.random() * (BET_MS - 1500);
      setTimeout(() => {
        if (!alive || phase !== 'betting') return;
        const r = Math.random();
        const lane = r < 0.42 ? 'purple' : r < 0.84 ? 'gray' : r < 0.94 ? 'green' : 'bait';
        place(lane, round2(Math.exp(Math.random() * 5 - 1)), randomBot(), false);
      }, delay);
    }
  };

  const startBetting = () => {
    phase = 'betting'; phaseStart = performance.now();
    bets = {}; myBets = {};
    $$('.lane', el).forEach(l => l.classList.remove('won', 'lost'));
    reel.classList.remove('settled');
    strip.querySelector('.landed')?.classList.remove('landed');
    drawLanes(); botBets();
    timer = window.setTimeout(roll, BET_MS);
  };

  const roll = async () => {
    if (!alive) return;
    phase = 'rolling'; phaseStart = performance.now(); drawLanes();
    const { floats, entry } = await bet('double', 1);
    const n = doubleRoll(floats[0]);
    annotate(entry, `tile ${n} (${doubleColor(n)})`, n);
    $('#ghash', el).textContent = `${entry.serverHash} · nonce ${entry.nonce}`;
    // Start from where the last roll stopped, then slide ~8 loops to the new tile.
    pendingN = n;
    setStrip(2 * DOUBLE_TILES + (history[0] ?? 0), false);
    void strip.offsetWidth;
    landIndex = 10 * DOUBLE_TILES + n;
    setStrip(landIndex, true);
    sfx.click();
    timer = window.setTimeout(() => settle(n), ROLL_MS);
  };

  /** Pay this round's bets for tile n. Returns { won, staked }. */
  const payMine = n => {
    let won = 0, staked = 0;
    for (const [lane, amount] of Object.entries(myBets)) {
      staked += amount;
      const w = doubleWins(lane as DoubleLane, n);
      const payout = w ? round2(amount * DOUBLE_PAY[lane as DoubleLane]) : 0;
      won += payout;
      pushBet({ user: state.name, game: 'Double', amount, multi: w ? DOUBLE_PAY[lane as DoubleLane] : 0, payout, mine: true });
    }
    if (won) credit(round2(won));
    myBets = {}; pendingN = null;
    return { won, staked };
  };

  const settle = n => {
    if (!alive) return;
    setStrip(landIndex, false);
    strip.children[landIndex]?.classList.add('landed');
    reel.classList.add('settled');
    phase = 'result'; phaseStart = performance.now();
    history.unshift(n); history.length = Math.min(history.length, 100);
    const myGreen = myBets.green || 0;
    const { won, staked } = payMine(n);
    LANES.forEach(([k]) => {
      const w = doubleWins(k as DoubleLane, n);
      $(`.lane-${k}`, el).classList.add(w ? 'won' : 'lost');
      (bets[k] || []).forEach(b => { b.result = w ? 'won' : 'lost'; });
    });
    // Triple Green pool
    if (n === 0) {
      const greens = bets.green || [];
      greenStreak.push({ mine: myGreen, total: greens.reduce((s, b) => s + b.amount, 0) });
      if (greenStreak.length >= 3) {
        const mine = greenStreak.reduce((s, g) => s + g.mine, 0), total = greenStreak.reduce((s, g) => s + g.total, 0);
        const share = total ? round2((pool * mine) / total) : 0;
        if (share > 0) { credit(share); toast(`Triple Green! Pool share +${fmt(share)}`, 'win'); confetti('#3dffa0'); }
        else toast(`Triple Green! ${fmt(pool)} paid to green players`);
        pool = 150; greenStreak = [];
      }
    } else greenStreak = [];
    if (won > staked && staked) { sfx.win(); toast(`+${fmt(won)}`, 'win'); } else if (staked) sfx.lose();
    drawLanes(); drawTop();
    timer = window.setTimeout(() => alive && startBetting(), SHOW_MS);
  };

  const tick = () => {
    if (!alive) return;
    const t = performance.now() - phaseStart;
    const bar = $('#tbar', el), label = $('#tlabel', el);
    $('#dover', el).classList.toggle('show', phase === 'betting');
    if (phase === 'betting') { const left = Math.max(0, BET_MS - t); bar.style.width = `${(left / BET_MS) * 100}%`; label.textContent = 'Rolling in'; $('#doverT', el).textContent = (left / 1000).toFixed(2); }
    else bar.style.width = '0%';
    raf = requestAnimationFrame(tick);
  };

  // ---- shared rounds: the server runs the round, everyone bets into it ---------------------------------------------------
  const upsertBet = (b: RoundBet): void => { const i = rbets.findIndex(x => x.id === b.id); if (i >= 0) rbets[i] = b; else rbets.push(b); };
  /** Rebuild the lanes from the server's bet rows. */
  const applyBets = (): void => {
    bets = {}; myBets = {};
    const n = round?.result?.n;
    for (const b of rbets) {
      (bets[b.lane] ||= []).push({ user: b.display_name, amount: b.amount, mine: b.user_id === liveMe(), result: b.done && n != null ? (b.locked > 0 ? 'won' : 'lost') : undefined });
      if (b.user_id === liveMe()) myBets[b.lane] = b.amount;
    }
    drawLanes();
  };
  const schedule = (ms: number): void => { clearTimeout(rtimer); if (alive) rtimer = window.setTimeout(() => void refresh(), Math.max(30, ms)); };
  const refresh = async (): Promise<void> => {
    if (!alive) return;
    try { applyRound(await advanceRound('double')); } catch { schedule(2000); }
  };
  async function placeLive(lane: string, amount: number): Promise<void> {
    if (!round || round.status !== 'betting' || phase !== 'betting') return void toast('Betting is closed for this round', 'error');
    if ((lane === 'purple' && myBets.gray) || (lane === 'gray' && myBets.purple)) return void toast("You can't back both Purple and Gray", 'error');
    if (!(amount >= 0.1)) return void toast('Minimum bet is 0.10', 'error');
    if (!debit(amount)) return void toast(debitError(amount), 'error');
    try { upsertBet(normBet(await doubleBet(round.id, lane, amount))); lastBet = { lane, amount }; sfx.click(); applyBets(); }
    catch (e) { credit(amount); toast(e instanceof Error ? e.message : 'Could not place the bet', 'error'); }
  }
  /** The reel rolls to the server's tile. A player who arrives mid-roll sees the rest of the roll; later than that, just the result. */
  const startRoll = (n: number, since: number): void => {
    rolledId = round!.id; pendingN = n; phase = 'rolling'; phaseStart = performance.now() - since;
    setStrip(2 * DOUBLE_TILES + (history[0] ?? 0), false);
    void strip.offsetWidth;
    landIndex = 10 * DOUBLE_TILES + n;
    setStrip(landIndex, true, Math.max(900, ROLL_MS - 400 - since));
    sfx.click(); drawLanes();
  };
  /** Show the result and pay this browser what the server settled for its bets. */
  const showResult = (n: number): void => {
    const rid = round!.id;
    settledId = rid; pendingN = null;
    landIndex = 10 * DOUBLE_TILES + n;
    setStrip(landIndex, false);
    strip.children[landIndex]?.classList.add('landed');
    reel.classList.add('settled');
    phase = 'result'; phaseStart = performance.now();
    if (!seenRounds.has(rid)) { seenRounds.add(rid); history.unshift(n); history.length = Math.min(history.length, 100); }
    LANES.forEach(([k]) => { $(`.lane-${k}`, el).classList.add(doubleWins(k as DoubleLane, n) ? 'won' : 'lost'); });
    drawLanes(); drawTop();
    void roundBets(rid).then(rows => {
      if (round?.id !== rid) return;
      rows.forEach(upsertBet); applyBets();
      let won = 0, staked = 0;
      for (const b of rbets) if (b.user_id === liveMe()) { staked += b.amount; won += b.locked; payBet(b); recordFinished(b, 'Double'); }
      const greens = bets.green || [], myGreen = myBets.green || 0;
      if (n === 0) {                                                       // Triple Green (the pool itself is still a local simulation)
        greenStreak.push({ mine: myGreen, total: greens.reduce((a, b) => a + b.amount, 0) });
        if (greenStreak.length >= 3) {
          const mine = greenStreak.reduce((a, g) => a + g.mine, 0), total = greenStreak.reduce((a, g) => a + g.total, 0);
          const share = total ? round2((pool * mine) / total) : 0;
          if (share > 0) { credit(share); toast(`Triple Green! Pool share +${fmt(share)}`, 'win'); confetti('#3dffa0'); } else toast(`Triple Green! ${fmt(pool)} paid to green players`);
          pool = 150; greenStreak = [];
        }
      } else greenStreak = [];
      if (won > staked && staked) { sfx.win(); toast(`+${fmt(won)}`, 'win'); } else if (staked) sfx.lose();
      drawTop();
    }).catch(() => {});
    void roundSeed(rid).then(seed => { if (seed && round?.id === rid) $('#ghash', el).textContent = `${round.server_hash} · seed ${seed}`; }).catch(() => {});
  };
  const applyRound = (r: Round): void => {
    if (!alive || (round && r.id < round.id)) return;
    const isNew = !round || round.id !== r.id;
    round = r;
    const now = serverNow(), endsAt = Date.parse(r.betting_ends_at);
    if (isNew) {
      rbets = []; bets = {}; myBets = {}; pendingN = null;
      $$('.lane', el).forEach(l => l.classList.remove('won', 'lost'));
      reel.classList.remove('settled'); strip.querySelector('.landed')?.classList.remove('landed');
      $('#ghash', el).textContent = `${r.server_hash} · round #${r.id}`;
      void roundBets(r.id).then(rows => { if (round?.id === r.id) { rows.forEach(upsertBet); applyBets(); } }).catch(() => {});
    }
    if (r.status === 'betting') {
      phase = 'betting'; phaseStart = performance.now() - (BET_MS - Math.max(0, endsAt - now));
      applyBets(); schedule(endsAt - now + 40);
      return;
    }
    const n = r.result?.n as number, since = now - endsAt;
    if (settledId === r.id) { schedule(Date.parse(r.finished_at ?? r.betting_ends_at) + SHOW_MS - now + 40); return; }
    if (r.status === 'running' && since < ROLL_MS) {
      if (rolledId !== r.id) startRoll(n, Math.max(0, since));
      schedule(ROLL_MS - since + 60);                                       // when the roll ends, ask the server to settle
    } else if (r.status === 'finished') {
      if (rolledId !== r.id) { rolledId = r.id; }
      showResult(n);
      schedule(Date.parse(r.finished_at ?? r.betting_ends_at) + SHOW_MS - now + 40);
    } else schedule(120);                                                   // the roll time has passed; the server is about to finish the round
  };
  const startLive = (): void => {
    void recentResults('double', 100).then(rs => { if (alive && !history.length) { history.push(...rs); drawTop(); } }).catch(() => {});
    void watchRounds((_ev, r) => { if (r.game === 'double') applyRound(r); }).then(stop => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void watchRoundBets((ev, b) => {
      if (!round || (b.round_id !== round.id && ev !== 'DELETE')) return;
      if (ev === 'DELETE') rbets = rbets.filter(x => x.id !== b.id); else upsertBet(b);
      applyBets();
    }).then(stop => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void refresh();
  };

  requestAnimationFrame(() => { setStrip(2 * DOUBLE_TILES + (history[0] ?? 0), false); });
  drawTop(); if (LIVE) startLive(); else startBetting(); tick();

  return () => {
    alive = false; clearTimeout(timer); clearTimeout(rtimer); cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey);
    if (LIVE) {
      stops.forEach(stop => stop());
      // Leaving: bets stay in the round (like on any shared table). The round is followed in the background and paid when it ends.
      if (round && settledId !== round.id && rbets.some(b => b.user_id === liveMe())) settleLater('double', round.id);
      return;
    }
    // Leaving before the roll refunds this round's bets; a rolling round is settled with its known result.
    if (phase === 'betting' || (phase === 'rolling' && pendingN === null)) { const back = Object.values(myBets).reduce((s, v) => s + v, 0); if (back) credit(round2(back)); }
    else if (phase === 'rolling' && pendingN !== null) { history.unshift(pendingN); payMine(pendingN); }
  };
}
