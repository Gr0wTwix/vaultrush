import { ITEMS, ITEM, RARITY, RARITY_ORDER, itemOf, itemName, CATALOGUE_TOTAL } from '../data.js';
import { ensureItems, queryItems, cheapestAtLeast } from '../catalogue.js';
import { state, debit, addItems, removeItems, round2, debitError, handoff, on } from '../state.js';
import { bet, upgradeChance, annotate, HOUSE, UPGRADE_MAX } from '../fair.js';
import { pushBet, pushDrop } from '../feed.js';
import { sleep, wireAmount, $, $$, fmt, money, itemCard, toast, icon, coin, confetti, avatar, esc, itemArt } from '../ui.js';
import { sfx } from '../sfx.js';
import { randomBot } from '../data.js';
import { serverWallet, upgradeItem, releaseItems } from '../wallet.js';

const liveUps = [];
function simUp() {
  const sorted = [...ITEMS].sort((a, b) => a.value - b.value);
  const fromI = Math.floor(Math.random() * (sorted.length - 4));
  const from = sorted[fromI], to = sorted[fromI + 1 + Math.floor(Math.random() * Math.min(8, sorted.length - fromI - 1))];
  const ch = upgradeChance(from.value, to.value);
  return { user: randomBot(), from, to, multi: round2(to.value / from.value), chance: ch, win: Math.random() < ch };
}
for (let i = 0; i < 6; i++) liveUps.push(simUp());
const upRow = u => `<div class="lu-row ${u.win ? 'win' : 'lose'} ${u.mine ? 'mine' : ''}">${avatar(u.user, 24)}<span class="lu-user">${esc(u.user)}</span>
  <span class="lu-item" style="--rc:${RARITY[u.from.rarity].color}">${itemArt(u.from)}</span><span class="lu-arrow">→</span><span class="lu-item" style="--rc:${RARITY[u.to.rarity].color}">${itemArt(u.to)}</span>
  <span class="lu-name">${esc(u.to.weapon)} | ${esc(u.to.skin)}</span><b class="lu-mult">${fmt(u.multi)}×</b><span class="lu-res">${u.win ? 'WIN' : 'LOSS'}</span></div>`;

export function render(el) {
  const sel = new Set<string>();          // selected inventory uids
  let coins = 0, target = null, busy = false, alive = true, rotation = 0, over = false, held: string[] = [];       // a won item whose reveal is still playing

  el.innerHTML = `
    <div class="up-king" id="upKing"></div>
    <div class="page-head"><h1>${icon('upgrade')} Upgrade</h1><p class="muted">Stake items and/or coins for a chance at a better item. Chance = 95% × stake ÷ target (max 80%). Under and Over have the same odds.</p></div>
    <div class="upgrade-stage panel">
      <div class="up-side"><div class="muted small">Your stake</div><div id="stakeView" class="up-slot"></div></div>
      <div class="gauge-wrap">
        <svg class="gauge" viewBox="0 0 200 200"><circle cx="100" cy="100" r="84" class="g-track"/><circle cx="100" cy="100" r="84" class="g-arc" id="arc" pathLength="100" stroke-dasharray="0 100"/></svg>
        <div class="pointer" id="pointer"><i></i></div>
        <div class="gauge-center"><b id="chance">0.00%</b><span class="muted small" id="chanceLbl">chance</span><span id="range" class="range-txt"></span><span id="multi" class="small"></span></div>
      </div>
      <div class="up-side"><div class="muted small">Target</div><div id="targetView" class="up-slot"></div></div>
    </div>
    <div class="up-action">
      <div class="seg" id="preset" aria-label="Pick a target by multiplier">${[1.5, 2, 5, 10].map(m => `<button data-m="${m}">${m}×</button>`).join('')}</div>
      <label class="up-want">Chance <input id="wantChance" type="number" min="1" max="${UPGRADE_MAX * 100}" step="0.5" placeholder="25" inputmode="decimal" aria-label="Chance you want, in percent"> %</label>
      <div class="seg" id="dir"><button data-d="under" class="active">Roll under</button><button data-d="over">Roll over</button></div>
      <label class="check"><input type="checkbox" id="fastUp" ${state.speed !== 'normal' ? 'checked' : ''}> Fast spin</label>
      <div class="up-auto"><label for="autoN">Auto</label><select id="autoN"><option value="0">Off</option><option value="5">5 upgrades</option><option value="10">10 upgrades</option><option value="25">25 upgrades</option></select>
        <label class="check"><input type="checkbox" id="autoStopWin" checked> Stop on a win</label></div>
      <button class="btn btn-primary btn-lg" id="upBtn" data-needs-auth="upgrade">Select a stake and a target</button>
    </div>
    <div class="upgrade-pickers">
      <div class="panel">
        <div class="panel-head"><h2>Stake</h2><div class="amount small-amount"><span class="amount-coin">${coin()}</span><input id="coinStake" type="number" min="0" step="0.1" placeholder="Coins" value="" aria-label="Coin stake"><button type="button" data-amt="half" aria-label="Halve the stake">½</button><button type="button" data-amt="double" aria-label="Double the stake">2×</button><button type="button" data-amt="max" aria-label="Stake your whole balance">Max</button></div></div>
        <div class="muted small" style="margin-bottom:8px">Pick up to 4 items from your inventory, add coins, or both.</div>
        <div class="contents small-grid" id="invPick"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Target item</h2><div class="tabs" id="tSort"><button class="tab active" data-s="asc">Low → high</button><button class="tab" data-s="desc">High → low</button></div></div>
        <input id="tSearch" class="search" placeholder="Search all ${CATALOGUE_TOTAL.toLocaleString('en-US')} skins…" autocomplete="off" aria-label="Search items" style="margin-bottom:10px">
        <div class="row target-filters"><select id="tType" aria-label="Weapon type"><option value="">All weapons</option><option value="knife">Knives</option><option value="gloves">Gloves</option><option value="rifle">Rifles</option><option value="sniper">Snipers</option><option value="smg">SMGs</option><option value="pistol">Pistols</option><option value="heavy">Heavy</option><option value="equipment">Equipment</option></select><select id="tRar" aria-label="Grade"><option value="">All grades</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select>
          <label class="tprice">Up to <b id="tMaxLbl">any price</b><input id="tMax" type="range" min="0" max="100" step="1" value="100" aria-label="Highest target price"></label></div>
        <div class="contents small-grid" id="targetPick" aria-live="polite"></div>
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h2><span class="live-dot"></span> Live upgrades</h2><span class="muted small">What other players are going for</span></div><div class="lu-list" id="liveUp"></div></div>`;

  // Live upgrades feed (simulated players + your own results).
  const drawLiveUp = () => {
    const box = $('#liveUp', el); if (box) box.innerHTML = liveUps.slice(0, 8).map(upRow).join('');
    // "Upgrade king": the biggest winning multiplier seen so far.
    const king = liveUps.filter(u => u.win).sort((a, b) => b.multi - a.multi)[0];
    const kb = $('#upKing', el);
    if (kb && king) kb.innerHTML = `${icon('trophy')}<span>Upgrade king</span><b>${esc(king.user)}</b><span class="k-mult">${fmt(king.multi)}×</span><span class="lu-item" style="--rc:${RARITY[king.to.rarity].color}">${itemArt(king.to)}</span>`;
  };
  const pushLiveUp = u => { liveUps.unshift(u); liveUps.length = Math.min(liveUps.length, 20); drawLiveUp(); };
  drawLiveUp();
  const liveTimer = setInterval(() => pushLiveUp(simUp()), 3800);
  let tq = '', tType = '', tRar = '', tMax = Infinity;
  // The price slider runs from 1 to 100,000 coins on a log scale; the far right means no limit. (Idea from SkinRave's upgrader.)
  const priceOf = (v: number): number => (v >= 100 ? Infinity : Math.round(10 ** (v / 20) * 100) / 100);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $('#tSearch', el).oninput = e => { tq = e.target.value.trim().toLowerCase(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void drawTargets(), 160); };
  $('#tType', el).onchange = e => { tType = e.target.value; void drawTargets(); };
  $('#tRar', el).onchange = e => { tRar = e.target.value; void drawTargets(); };
  $('#tMax', el).oninput = e => {
    tMax = priceOf(+e.target.value);
    $('#tMaxLbl', el).textContent = tMax === Infinity ? 'any price' : fmt(tMax);
    clearTimeout(searchTimer); searchTimer = setTimeout(() => void drawTargets(), 160);
  };

  const invItem = (u: string) => itemOf(state.inv.find(i => i.uid === u)?.id ?? '');
  const stakeValue = () => round2([...sel].reduce((s, u) => s + invItem(u).value, 0) + coins);

  const drawInv = () => {
    for (const u of [...sel]) if (!state.inv.some(i => i.uid === u)) sel.delete(u);
    $('#invPick', el).innerHTML = state.inv.length
      ? state.inv.map(e => `<button class="pick ${sel.has(e.uid) ? 'on' : ''}" data-u="${e.uid}">${itemCard(itemOf(e.id), { compact: true })}</button>`).join('')
      : `<div class="muted small">No items yet. <a href="#/cases">Open a case</a> or stake coins instead.</div>`;
    $$('#invPick .pick', el).forEach(b => b.onclick = () => {
      if (busy) return;
      const u = b.dataset.u;
      if (sel.has(u)) sel.delete(u); else if (sel.size < 4) sel.add(u); else return toast('Up to 4 items', 'error');
      sfx.click(); drawInv(); drawStage();
    });
  };

  // The target list searches the whole catalogue (src/catalogue.ts): items worth more than the stake, and not so much more that the chance rounds to nothing.
  let sortDir = 'asc', shown = 0, token = 0;
  const PAGE = 18, MAX_MULTI = 9500;
  const drawTargets = async (more = false): Promise<void> => {
    const sv = stakeValue(), mine = ++token, box = $('#targetPick', el);
    if (target && target.value <= sv * 1.05) target = null;
    if (!more) { shown = 0; if (!box.children.length) box.innerHTML = '<div class="muted small">Loading items…</div>'; }
    let res;
    try { res = await queryItems({ min: sv * 1.05, max: sv > 0 ? Math.min(sv * MAX_MULTI, tMax) : (tMax === Infinity ? undefined : tMax), q: tq, dir: sortDir as 'asc' | 'desc', type: tType || undefined, rarity: (tRar || undefined) as any }, shown, PAGE); }
    catch { if (alive && mine === token) box.innerHTML = '<div class="muted small">Could not load the item list. Check your connection, then change the search to try again.</div>'; return; }
    if (!alive || mine !== token) return;                                // a newer search has started: this answer is stale
    const card = i => `<button class="pick ${target === i ? 'on' : ''}" data-id="${i.id}">${itemCard(i, { compact: true, extra: sv > 0 ? `<div class="chance">${(upgradeChance(sv, i.value) * 100).toFixed(2)}%</div>` : '' })}</button>`;
    if (!more) box.innerHTML = '';
    box.querySelector('.more-row')?.remove();
    box.insertAdjacentHTML('beforeend', res.items.map(card).join(''));
    shown += res.items.length;
    if (!box.children.length) box.innerHTML = sv > 0 ? '<div class="muted small">No item matches. Try another search, a bigger stake or a higher price limit.</div>' : '<div class="muted small">Pick a stake first: the list shows items worth more than it.</div>';
    else if (shown < res.total) box.insertAdjacentHTML('beforeend', `<div class="more-row"><button class="btn btn-ghost btn-sm" id="moreTargets">Show more (${(res.total - shown).toLocaleString('en-US')} left)</button></div>`);
    $$('#targetPick .pick', el).forEach(b => b.onclick = () => { if (busy) return; target = ITEM[b.dataset.id]; sfx.click(); $$('#targetPick .pick', el).forEach(x => x.classList.toggle('on', x === b)); drawStage(); });
    const mo = $('#moreTargets', el); if (mo) mo.onclick = () => void drawTargets(true);
  };

  const drawStage = () => {
    const sv = stakeValue();
    const items = [...sel].map(invItem);
    $('#stakeView', el).innerHTML = sv > 0
      ? `<div class="stake-stack">${items.map(i => itemCard(i, { compact: true })).join('')}${coins > 0 ? `<div class="coin-stake">${coin('lg')}${fmt(coins)}</div>` : ''}</div><div class="slot-total">${money(sv)}</div>`
      : '<div class="slot-empty">Pick items or enter coins</div>';
    $('#targetView', el).innerHTML = target ? itemCard(target) : '<div class="slot-empty">Pick a target</div>';
    const ch = sv > 0 && target ? upgradeChance(sv, target.value) : 0;
    if (!busy) {
      $('#chance', el).textContent = `${(ch * 100).toFixed(2)}%`;
      $('#chanceLbl', el).textContent = 'chance';
      // The winning roll range (rolls are 0.00–99.99), shown under the % like the reference site.
      const pct = ch * 100;
      $('#range', el).textContent = ch > 0 ? (over ? `${(100 - pct).toFixed(2)} – 99.99` : `0.00 – ${pct.toFixed(2)}`) : '';
    }
    $('#multi', el).textContent = sv > 0 && target ? `${fmt(target.value / sv)}×` : '';
    $('#arc', el).setAttribute('stroke-dasharray', `${ch * 100} 100`);
    $('#arc', el).setAttribute('stroke-dashoffset', over ? `${-(100 - ch * 100)}` : '0');
    const btn = $('#upBtn', el), autoN = +$('#autoN', el).value;
    if (autoRunning) { btn.disabled = false; btn.innerHTML = `Stop auto (${autoLeft} left)`; }
    else {
      btn.disabled = !(sv > 0 && target) || busy;
      btn.innerHTML = sv > 0 && target ? (autoN > 0 ? `Start auto: ${autoN} × ${(ch * 100).toFixed(2)}%` : `Upgrade (${(ch * 100).toFixed(2)}%)`) : 'Select a stake and a target';
    }
    drawTargetsIfNeeded();
  };
  let lastSv = -1, autoRunning = false, autoLeft = 0;
  const drawTargetsIfNeeded = () => { const sv = stakeValue(); if (sv !== lastSv) { lastSv = sv; void drawTargets(); } };

  const setStake = (): void => {
    const v = Math.max(0, round2(+$('#coinStake', el).value || 0));
    coins = Math.min(v, state.balance);
    drawStage();
  };
  wireAmount(el, $('#coinStake', el), () => state.balance, setStake);      // typing, or the ½ / 2× / Max buttons
  $$('#tSort .tab', el).forEach(t => t.onclick = () => { $$('#tSort .tab', el).forEach(x => x.classList.toggle('active', x === t)); sortDir = t.dataset.s; void drawTargets(); });
  // Multiplier presets pick the cheapest item worth at least stake × multiplier.
  $$('#preset button', el).forEach(b => b.onclick = async () => {
    if (busy) return;
    const sv = stakeValue();
    if (!(sv > 0)) return toast('Pick a stake first', 'error');
    const pick = await cheapestAtLeast(sv * +b.dataset.m).catch(() => null);
    if (!alive) return;
    if (!pick) return toast('No item is that valuable', 'error');
    target = pick; sfx.click(); void drawTargets(); drawStage();
  });
  // A typed chance picks the cheapest item worth at least stake × 95% ÷ chance, so the real chance is as close as possible without going over.
  $('#wantChance', el).onchange = async e => {
    if (busy) return;
    const p = +e.target.value;
    if (!(p >= 1 && p <= UPGRADE_MAX * 100)) return toast(`Enter a chance from 1% to ${UPGRADE_MAX * 100}%`, 'error');
    const sv = stakeValue();
    if (!(sv > 0)) return toast('Pick a stake first', 'error');
    const pick = await cheapestAtLeast(sv * HOUSE.upgrade / (p / 100)).catch(() => null);
    if (!alive) return;
    if (!pick) return toast('No item is that valuable', 'error');
    target = pick; sfx.click(); void drawTargets(); drawStage();
  };
  $('#autoN', el).onchange = () => drawStage();
  $$('#dir button', el).forEach(b => b.onclick = () => { if (busy) return; over = b.dataset.d === 'over'; $$('#dir button', el).forEach(x => x.classList.toggle('active', x === b)); drawStage(); });

  /** One upgrade. `keep` (Auto) keeps the coin stake and the target for the next round. Resolves true on a win, false on a miss, null when it could not run. */
  const runUpgrade = async (keep: boolean): Promise<boolean | null> => {
    const sv = stakeValue();
    if (busy || !(sv > 0) || !target) return null;
    if (coins > 0 && !debit(coins)) { toast(debitError(coins), 'error'); return null; }
    busy = true; drawStage();
    const uids = [...sel];
    // Shown in the live feed as "from → to": your most valuable staked item (or the closest item to a coin stake).
    const fromItem = uids.map(invItem).sort((a, b) => b.value - a.value)[0]
      || [...ITEMS].sort((a, b) => Math.abs(a.value - sv) - Math.abs(b.value - sv))[0];
    const dirOver = over;
    let ch: number, f: number, win: boolean;
    if (serverWallet()) {
      // The database checks the items are yours, takes them and the coins, draws the roll from your secret seed and gives the target on a win.
      try {
        const r = await upgradeItem(uids, coins, target.id, dirOver);
        ch = r.chance; f = r.roll; win = r.win;
        held = r.uid ? [r.uid] : [];
      } catch (e) { busy = false; drawStage(); toast(e instanceof Error ? e.message : 'Could not upgrade', 'error'); return null; }
    } else {
      removeItems(uids);
      ch = upgradeChance(sv, target.value);
      const { floats, entry } = await bet('upgrade', 1, { chance: ch, over: dirOver });
      // The pointer's position IS the roll: under wins below the chance, over wins above 1 - chance.
      f = floats[0];
      win = dirOver ? f > 1 - ch : f < ch;
      annotate(entry, `${(ch * 100).toFixed(2)}% ${dirOver ? 'over' : 'under'} for ${target.weapon} | ${target.skin}: roll ${(f * 100).toFixed(2)} → ${win ? 'win' : 'lose'}`, `${f.toFixed(6)}:${win ? 1 : 0}`);
    }
    const land = f * 360;
    const fromRot = rotation;
    rotation += 360 * 5 + ((land - (rotation % 360)) + 360) % 360;
    const fast = $('#fastUp', el).checked;
    const spinMs = fast ? 1500 : 4200;
    const p = $('#pointer', el);
    p.style.transition = `transform ${spinMs}ms cubic-bezier(.15,.7,.12,1)`;
    p.style.transform = `rotate(${rotation}deg)`;
    const tgt = target;
    if (win && !serverWallet()) addItems([tgt]);   // granted immediately; the animation only reveals it (with the server wallet it is already in the inventory)
    pushBet({ user: state.name, game: 'Upgrade', amount: sv, multi: win ? round2(tgt.value / sv) : 0, payout: win ? tgt.value : 0, mine: true });
    // Count the roll up live in the centre while the pointer spins, then land on the real roll.
    const rollEl = $('#chance', el), t0 = performance.now(), final = f * 100;
    $('#chanceLbl', el).textContent = 'rolling';
    await new Promise<void>(done => {
      const tick = t => {
        if (!alive) return done();
        const k = Math.min(1, (t - t0) / spinMs);
        // follow the pointer's eased angle so the number matches where it points
        const eased = 1 - Math.pow(1 - k, 3.2);
        const shown = (((fromRot + eased * (rotation - fromRot)) % 360) + 360) % 360 / 3.6;
        rollEl.textContent = (k < 1 ? shown : final).toFixed(2);
        if (k < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    await new Promise(r => setTimeout(r, 100));
    releaseItems(held); held = [];                                      // the pointer has landed: now the top bar counts the item
    if (alive) { rollEl.textContent = final.toFixed(2); $('#chanceLbl', el).textContent = win ? 'winning roll' : 'roll'; rollEl.className = win ? 'pos' : 'neg'; }
    pushLiveUp({ user: state.name, mine: true, from: fromItem, to: tgt, multi: round2(tgt.value / sv), chance: ch, win });
    if (!alive) return null;
    $('.upgrade-stage', el).classList.add(win ? 'up-win' : 'up-lose');
    setTimeout(() => $('.upgrade-stage', el)?.classList.remove('up-win', 'up-lose'), 1600);
    if (win) { sfx.big(); confetti(RARITY[tgt.rarity].color); toast(`Upgrade hit! ${itemName(tgt)}`, 'win'); pushDrop({ user: state.name, item: tgt, source: 'Upgrade' }); }
    else { sfx.lose(); toast('Upgrade missed', 'error'); }
    sel.clear();
    if (!keep) { coins = 0; $('#coinStake', el).value = ''; target = null; lastSv = -1; }
    // Keep the landed roll visible for a moment before resetting the gauge.
    await sleep(keep ? 900 : 1400);
    if (alive) { busy = false; $('#chance', el).className = ''; drawInv(); drawStage(); }
    return win;
  };

  // Auto (idea from SkinRave): the same coin stake and target, up to 25 times. Every round goes through the same checks as a manual one (balance,
  // limits, cool-off), and it stops on a win (unless switched off), on any refusal, when a reality check or another dialog opens, or when you press Stop.
  const stopAuto = (why = ''): void => { if (!autoRunning) return; autoRunning = false; autoLeft = 0; if (why) toast(why); drawStage(); };
  const startAuto = async (): Promise<void> => {
    if (sel.size) return toast('Auto works with a coin stake only: unselect the items', 'error');
    if (!(coins > 0) || !target) return toast('Pick a coin stake and a target first', 'error');
    autoRunning = true; autoLeft = +$('#autoN', el).value; drawStage();
    let won = false;
    while (autoRunning && alive && autoLeft > 0) {
      if (document.querySelector('.rg-overlay, .modal-back')) { stopAuto('Auto stopped: answer the open window first'); break; }
      autoLeft--; drawStage();
      const r = await runUpgrade(true);
      if (r === null) { stopAuto(); break; }
      if (r) { won = true; if ($('#autoStopWin', el).checked) { stopAuto('Auto stopped: you won'); break; } }
      if (coins > state.balance) { stopAuto('Auto stopped: not enough coins for another round'); break; }
    }
    if (autoRunning) stopAuto(won ? 'Auto finished' : 'Auto finished: no win this time');
  };
  $('#upBtn', el).onclick = () => {
    if (autoRunning) return stopAuto('Auto stopped');
    if (+$('#autoN', el).value > 0) return void startAuto();
    void runUpgrade(false);
  };

  // "Upgrade win" from a battle arrives here as a ready coin stake.
  if (handoff.upgradeCoins) {
    coins = Math.min(handoff.upgradeCoins, state.balance);
    $('#coinStake', el).value = coins;
    delete handoff.upgradeCoins;
    toast(`Battle winnings ready to upgrade: ${fmt(coins)}`, 'win');
  }
  drawInv(); drawStage();
  // Items that came from an upgrade are not bundled with the page: fetch the ones the inventory holds, then show them.
  void ensureItems(state.inv.map(e => e.id));
  const offItems = on('items:loaded', () => { if (alive) { drawInv(); drawStage(); } });
  return () => { alive = false; autoRunning = false; clearInterval(liveTimer); clearTimeout(searchTimer); offItems(); releaseItems(held); };
}
