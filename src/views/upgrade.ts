import { ITEMS, ITEM, RARITY } from '../data.js';
import { state, debit, addItems, removeItems, round2, debitError, handoff } from '../state.js';
import { bet, upgradeChance, annotate } from '../fair.js';
import { pushBet, pushDrop } from '../feed.js';
import { $, $$, fmt, money, itemCard, toast, icon, coin, confetti, avatar, esc, itemArt } from '../ui.js';
import { sfx } from '../sfx.js';
import { randomBot } from '../data.js';

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
  let coins = 0, target = null, busy = false, alive = true, rotation = 0, over = false;

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
      <div class="seg" id="dir"><button data-d="under" class="active">Roll under</button><button data-d="over">Roll over</button></div>
      <label class="check"><input type="checkbox" id="fastUp" ${state.speed !== 'normal' ? 'checked' : ''}> Fast spin</label>
      <button class="btn btn-primary btn-lg" id="upBtn">Select a stake and a target</button>
    </div>
    <div class="upgrade-pickers">
      <div class="panel">
        <div class="panel-head"><h2>Stake</h2><div class="amount small-amount"><span class="amount-coin">${coin()}</span><input id="coinStake" type="number" min="0" step="0.1" placeholder="Coins" value=""></div></div>
        <div class="muted small" style="margin-bottom:8px">Pick up to 4 items from your inventory, add coins, or both.</div>
        <div class="contents small-grid" id="invPick"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Target item</h2><div class="tabs" id="tSort"><button class="tab active" data-s="asc">Low → high</button><button class="tab" data-s="desc">High → low</button></div></div>
        <input id="tSearch" class="search" placeholder="Search items…" autocomplete="off" style="margin-bottom:10px">
        <div class="contents small-grid" id="targetPick"></div>
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
  let tq = '';
  $('#tSearch', el).oninput = e => { tq = e.target.value.trim().toLowerCase(); drawTargets(); };

  const stakeValue = () => round2([...sel].reduce((s, u) => s + ITEM[state.inv.find(i => i.uid === u).id].value, 0) + coins);

  const drawInv = () => {
    for (const u of [...sel]) if (!state.inv.some(i => i.uid === u)) sel.delete(u);
    $('#invPick', el).innerHTML = state.inv.length
      ? state.inv.map(e => `<button class="pick ${sel.has(e.uid) ? 'on' : ''}" data-u="${e.uid}">${itemCard(ITEM[e.id], { compact: true })}</button>`).join('')
      : `<div class="muted small">No items yet. <a href="#/cases">Open a case</a> or stake coins instead.</div>`;
    $$('#invPick .pick', el).forEach(b => b.onclick = () => {
      if (busy) return;
      const u = b.dataset.u;
      if (sel.has(u)) sel.delete(u); else if (sel.size < 4) sel.add(u); else return toast('Up to 4 items', 'error');
      sfx.click(); drawInv(); drawStage();
    });
  };

  let sortDir = 'asc';
  const drawTargets = () => {
    const sv = stakeValue();
    const list = ITEMS.filter(i => i.value > sv * 1.05 && (!tq || `${i.weapon} ${i.skin}`.toLowerCase().includes(tq))).sort((a, b) => (sortDir === 'asc' ? a.value - b.value : b.value - a.value));
    if (target && !list.includes(target)) target = null;
    $('#targetPick', el).innerHTML = list.map(i => `<button class="pick ${target === i ? 'on' : ''}" data-id="${i.id}">${itemCard(i, { compact: true, extra: sv > 0 ? `<div class="chance">${(upgradeChance(sv, i.value) * 100).toFixed(2)}%</div>` : '' })}</button>`).join('');
    $$('#targetPick .pick', el).forEach(b => b.onclick = () => { if (busy) return; target = ITEM[b.dataset.id]; sfx.click(); drawTargets(); drawStage(); });
  };

  const drawStage = () => {
    const sv = stakeValue();
    const items = [...sel].map(u => ITEM[state.inv.find(i => i.uid === u).id]);
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
    const btn = $('#upBtn', el);
    btn.disabled = !(sv > 0 && target) || busy;
    btn.innerHTML = sv > 0 && target ? `Upgrade (${(ch * 100).toFixed(2)}%)` : 'Select a stake and a target';
    drawTargetsIfNeeded();
  };
  let lastSv = -1;
  const drawTargetsIfNeeded = () => { const sv = stakeValue(); if (sv !== lastSv) { lastSv = sv; drawTargets(); } };

  $('#coinStake', el).oninput = e => {
    const v = Math.max(0, round2(+e.target.value || 0));
    coins = Math.min(v, state.balance);
    drawStage();
  };
  $$('#tSort .tab', el).forEach(t => t.onclick = () => { $$('#tSort .tab', el).forEach(x => x.classList.toggle('active', x === t)); sortDir = t.dataset.s; drawTargets(); });
  // Multiplier presets pick the cheapest item worth at least stake × multiplier.
  $$('#preset button', el).forEach(b => b.onclick = () => {
    if (busy) return;
    const sv = stakeValue();
    if (!(sv > 0)) return toast('Pick a stake first', 'error');
    const want = sv * +b.dataset.m;
    const pick = ITEMS.filter(i => i.value >= want).sort((a, c) => a.value - c.value)[0];
    if (!pick) return toast('No item is that valuable', 'error');
    target = pick; sfx.click(); drawTargets(); drawStage();
  });
  $$('#dir button', el).forEach(b => b.onclick = () => { if (busy) return; over = b.dataset.d === 'over'; $$('#dir button', el).forEach(x => x.classList.toggle('active', x === b)); drawStage(); });

  $('#upBtn', el).onclick = async () => {
    const sv = stakeValue();
    if (busy || !(sv > 0) || !target) return;
    if (coins > 0 && !debit(coins)) return toast(debitError(coins), 'error');
    busy = true; drawStage();
    const uids = [...sel];
    // Shown in the live feed as "from → to": your most valuable staked item (or the closest item to a coin stake).
    const fromItem = uids.map(u => ITEM[state.inv.find(i => i.uid === u).id]).sort((a, b) => b.value - a.value)[0]
      || [...ITEMS].sort((a, b) => Math.abs(a.value - sv) - Math.abs(b.value - sv))[0];
    removeItems(uids);
    const ch = upgradeChance(sv, target.value);
    const dirOver = over;
    const { floats, entry } = await bet('upgrade', 1, { chance: ch, over: dirOver });
    // The pointer's position IS the roll: under wins below the chance, over wins above 1 - chance.
    const f = floats[0];
    const win = dirOver ? f > 1 - ch : f < ch;
    annotate(entry, `${(ch * 100).toFixed(2)}% ${dirOver ? 'over' : 'under'} for ${target.weapon} | ${target.skin}: roll ${(f * 100).toFixed(2)} → ${win ? 'win' : 'lose'}`, `${f.toFixed(6)}:${win ? 1 : 0}`);
    const land = f * 360;
    const fromRot = rotation;
    rotation += 360 * 5 + ((land - (rotation % 360)) + 360) % 360;
    const fast = $('#fastUp', el).checked;
    const spinMs = fast ? 1500 : 4200;
    const p = $('#pointer', el);
    p.style.transition = `transform ${spinMs}ms cubic-bezier(.15,.7,.12,1)`;
    p.style.transform = `rotate(${rotation}deg)`;
    const tgt = target;
    if (win) addItems([tgt]);   // granted immediately; the animation only reveals it
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
    if (alive) { rollEl.textContent = final.toFixed(2); $('#chanceLbl', el).textContent = win ? 'winning roll' : 'roll'; rollEl.className = win ? 'pos' : 'neg'; }
    pushLiveUp({ user: state.name, mine: true, from: fromItem, to: tgt, multi: round2(tgt.value / sv), chance: ch, win });
    if (!alive) return;
    $('.upgrade-stage', el).classList.add(win ? 'up-win' : 'up-lose');
    setTimeout(() => $('.upgrade-stage', el)?.classList.remove('up-win', 'up-lose'), 1600);
    if (win) { sfx.big(); confetti(RARITY[tgt.rarity].color); toast(`Upgrade hit! ${tgt.weapon} | ${tgt.skin}`, 'win'); pushDrop({ user: state.name, item: tgt, source: 'Upgrade' }); }
    else { sfx.lose(); toast('Upgrade missed', 'error'); }
    sel.clear(); coins = 0; $('#coinStake', el).value = ''; target = null; lastSv = -1;
    // Keep the landed roll visible for a moment before resetting the gauge.
    setTimeout(() => { if (!alive) return; busy = false; $('#chance', el).className = ''; drawInv(); drawStage(); }, 1400);
  };

  // "Upgrade win" from a battle arrives here as a ready coin stake.
  if (handoff.upgradeCoins) {
    coins = Math.min(handoff.upgradeCoins, state.balance);
    $('#coinStake', el).value = coins;
    delete handoff.upgradeCoins;
    toast(`Battle winnings ready to upgrade: ${fmt(coins)}`, 'win');
  }
  drawInv(); drawStage();
  return () => { alive = false; clearInterval(liveTimer); };
}
