// Account > Account: the overview, laid out like the reference profile pages: identity and level, level cases, reward tiles,
// status tiles (verification, 2FA, self-lock...), quick settings and the stats panels (free rewards, games, big wins, inventory).
import { BOTS, CASE, CASES, ITEM, RARITY } from './data.js';
import { FREE_COINS_EVERY_MS, DAY, level, save, state, xpForLevel } from './state.js';
import { bigWins, freeRewardStats, gameRows, totalPlayed } from './profile-stats.js';
import { LEVEL_CASES } from './views/rewards.js';
import { backendEnabled, list2fa, currentUser } from './backend.js';
import { validateUsername } from './signup.js';
import { isExcluded } from './state.js';
import type { PaneCtx } from './account-rg.js';
import { $, $$, avatar, esc, fmt, icon, money, toast } from './ui.js';
import { sfx } from './sfx.js';
import { applyUi } from './account.js';

const when = (t: number): string => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const left = (ms: number): string => { const m = Math.max(0, Math.ceil(ms / 60_000)); return m >= 120 ? `${Math.floor(m / 60)} h` : `${m} min`; };
const tile = (tab: string, ic: string, status: string, label: string, cls = ''): string =>
  `<button class="ov-tile ${cls}" data-go="${tab}"><span class="ov-ic">${icon(ic)}</span><span><b>${esc(label)}</b><small>${esc(status)}</small></span></button>`;
const sw = (id: string, ic: string, label: string, on: boolean): string =>
  `<label class="ov-set ${on ? 'on' : ''}"><span class="ov-ic">${icon(ic)}</span><span><b>${label}</b><small>${on ? 'On' : 'Off'}</small></span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;

export function renderOverview(pane: HTMLElement, ctx: PaneCtx, go: (tab: string) => void): void {
  const now = Date.now(), lvl = level(), base = xpForLevel(lvl), next = xpForLevel(lvl + 1);
  const pct = Math.max(0, Math.min(100, ((state.xp - base) / (next - base)) * 100));
  const free = freeRewardStats(state), rows = gameRows(state), wins = bigWins(state), played = totalPlayed(state);
  const coinWait = state.lastClaim + FREE_COINS_EVERY_MS - now, dailyWait = state.lastDailyCase + DAY - now;
  const invValue = Math.round(state.inv.reduce((a, e) => a + (ITEM[e.id]?.value ?? 0), 0) * 100) / 100;
  const best = state.bestDrop, bestItem = best ? ITEM[best.id] : undefined;
  const bestCase = best ? [...CASES].find(c => c.name === best.source) : undefined;
  const kycLabel = state.kyc.docStatus === 'hold' ? 'On hold' : state.kyc.tier === 0 ? 'Not verified' : `Level ${state.kyc.tier}`;
  const excl = isExcluded() ? `Until ${when(state.excludedUntil)}` : state.rg.coolOffUntil > now ? `Cool-off until ${when(state.rg.coolOffUntil)}` : 'Not active';

  pane.innerHTML = `
    <h2 class="ac-h">Account</h2>
    <div class="ov-top">
      <div class="ac-card ov-who">${avatar(state.name, 72)}<div class="ov-name"><b>${esc(state.name)}</b><span class="muted">Coins</span>${money(state.balance)}</div></div>
      <div class="ac-card ov-level"><div class="ov-lvl-n">${lvl}</div><div class="ov-lvl-info"><b>${state.xp.toLocaleString('en-US')} XP</b><span class="muted small">${Math.max(0, next - state.xp).toLocaleString('en-US')} XP remaining to level ${lvl + 1}</span><div class="ac-bar"><i style="width:${pct.toFixed(1)}%"></i></div></div><div class="ov-lvl-n dim">${lvl + 1}</div></div>
    </div>

    <h3 class="ov-h">Display name</h3>
    <div class="ac-card"><p class="ac-note">2 to 20 characters: letters, numbers, spaces, _ and -.</p>
      <div class="ac-inline"><input id="acName" maxlength="20" value="${esc(state.name)}" autocomplete="off" aria-label="Display name"><button class="btn btn-primary" id="acNameSave">Save</button></div></div>

    <h3 class="ov-h">Level cases</h3>
    <div class="ov-cases">${LEVEL_CASES.map(([req, id]) => { const used = state.keysUsed.includes(req), ok = lvl >= req;
      return `<a class="ov-case ${used ? 'used' : ok ? 'ready' : 'locked'}" href="#/rewards" title="${esc(CASE[id]?.name ?? '')}"><b>Lv ${req}</b><small>${used ? 'Claimed' : ok ? 'Ready' : 'Locked'}</small></a>`; }).join('')}</div>

    <h3 class="ov-h">Rewards</h3>
    <div class="ov-rewards">
      <a class="ov-reward" href="#/rewards"><span class="ov-ic big">${icon('gift')}</span><small>Free coins</small><b>${coinWait <= 0 ? 'Ready to claim' : `In ${left(coinWait)}`}</b></a>
      <a class="ov-reward" href="#/rewards"><span class="ov-ic big">${icon('cases')}</span><small>Daily crate</small><b>${dailyWait <= 0 ? 'Open now' : `In ${left(dailyWait)}`}</b></a>
      <a class="ov-reward" href="#/rewards"><span class="ov-ic big">${icon('star')}</span><small>Rakeback ready</small><b>${money(Math.round((state.rakeback.instant + state.rakeback.daily + state.rakeback.weekly) * 100) / 100)}</b></a>
    </div>

    <h3 class="ov-h">Actions</h3>
    <div class="ov-tiles">
      ${tile('affiliates', 'users', 'Not active', 'Affiliate wallet')}
      ${tile('kyc', 'id', kycLabel, 'Verification', state.kyc.tier > 0 ? 'good' : '')}
      <button class="ov-tile" id="ovFa" data-go="security"><span class="ov-ic">${icon('lock')}</span><span><b>Two-factor authentication</b><small>${backendEnabled() ? 'Checking…' : 'Cloud accounts only'}</small></span></button>
      ${tile('responsible', 'ban', excl, 'Self-exclusion', isExcluded() || state.rg.coolOffUntil > now ? 'warn' : '')}
      ${tile('kyc', 'chat', state.kyc.emailVerifiedAt ? 'Verified' : 'Not verified', 'Email')}
      ${tile('responsible', 'heart', state.rg.limits.maxBet !== null || state.rg.limits.lossDaily !== null ? 'Limits set' : 'No limits', 'Responsible play')}
    </div>

    <h3 class="ov-h">Settings</h3>
    <div class="ov-sets">${sw('ovAnon', 'user', 'Anonymous mode', state.ui.anonymous)}${sw('ovSnd', 'sound', 'Sound effects', !state.muted)}${sw('ovFx', 'bolt', 'Visual effects', state.ui.fx)}${sw('ovNot', 'chat', 'Notifications', state.ui.notify)}${sw('ovStream', 'lock', 'Streamer mode', state.ui.streamer)}${sw('ovChat', 'chat', 'Show chat', state.ui.chat)}${sw('ovLvl', 'star', 'Level-up pop-ups', state.ui.levelPopup)}</div>

    <h3 class="ov-h">Free rewards stats</h3>
    <div class="ov-stats">
      <div class="ov-stat wide"><span class="ov-ic">${icon('gift')}</span><b>${money(free.total)}</b><small>Total free coins received</small></div>
      <div class="ov-stat wide"><span class="ov-ic">${icon('trophy')}</span><b>${money(free.race)}</b><small>Coins from races</small></div>
      <div class="ov-stat"><b>${money(free.rakeback)}</b><small>Rakeback</small></div><div class="ov-stat"><b>${money(free.freeCoins)}</b><small>Free coin claims</small></div>
      <div class="ov-stat"><b>${money(free.promos)}</b><small>Promo codes</small></div><div class="ov-stat"><b>${money(free.calendar)}</b><small>Login calendar</small></div>
      <div class="ov-stat"><b>${money(free.rain)}</b><small>Coin rain</small></div><div class="ov-stat"><b>${free.freeCases}</b><small>Free cases opened</small></div>
      ${bestItem ? `<div class="ov-best" style="--rc:${RARITY[bestItem.rarity].color}"><b>${esc(bestItem.weapon)} | ${esc(bestItem.skin)}</b><small>Best unboxing${best ? ` from ${esc(best.source)}` : ''}${bestCase ? ` · ${Math.round(bestItem.value / bestCase.price)}× the case price` : ''}</small><span>${money(bestItem.value)}</span></div>` : ''}
    </div>

    <h3 class="ov-h">Game stats</h3>
    <div class="ac-card">${rows.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Game</th><th>Bets</th><th>Wagered</th><th>Returned</th><th class="r">Best win</th></tr></thead><tbody>
      <tr class="ov-total"><td><b>Total played</b></td><td>${rows.reduce((a, r) => a + r.bets, 0)}</td><td>${money(played)}</td><td>${money(Math.round(rows.reduce((a, r) => a + r.paid, 0) * 100) / 100)}</td><td class="r"></td></tr>
      ${rows.map(r => `<tr><td>${esc(r.game)}</td><td>${r.bets}</td><td>${money(r.wagered)}</td><td>${money(r.paid)}</td><td class="r">${r.bestPayout > 0 ? `${money(r.bestPayout)} <span class="muted small">${fmt(r.bestMulti)}×</span>` : '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">Play a game and your stats appear here.</div>'}</div>

    <h3 class="ov-h">Big wins</h3>
    <div class="ov-wins">${wins.biggest ? `<div class="ov-win"><span class="ov-ic">${icon('trophy')}</span><span><b>Biggest win: ${esc(wins.biggest.game)}</b><small>${fmt(wins.biggest.multi)}× multiplier</small></span>${money(wins.biggest.payout)}</div>
      ${wins.bestMulti ? `<div class="ov-win"><span class="ov-ic">${icon('bolt')}</span><span><b>Best multiplier: ${esc(wins.bestMulti.game)}</b><small>${fmt(wins.bestMulti.multi)}×</small></span>${money(wins.bestMulti.payout)}</div>` : ''}` : '<div class="ac-empty">No wins recorded yet.</div>'}</div>

    <h3 class="ov-h">Inventory</h3>
    <div class="ac-card ac-split"><div><b>${state.inv.length} item${state.inv.length === 1 ? '' : 's'} worth ${money(invValue)}</b><p class="ac-note">Sell or keep what you unboxed. It is play money, so nothing can be withdrawn.</p></div><a class="btn btn-ghost" href="#/inventory">${icon('bag')} Open inventory</a></div>
`;

  $$('[data-go]', pane).forEach((b: HTMLElement) => b.onclick = () => go(b.dataset.go as string));
  $$('.ac-split a, .ov-reward, .ov-case', pane).forEach((a: HTMLElement) => a.addEventListener('click', () => ctx.close()));
  const flip = (id: string, fn: (on: boolean) => void): void => { ($('#' + id, pane) as HTMLInputElement).onchange = e => { fn((e.target as HTMLInputElement).checked); save(); applyUi(); sfx.click(); ctx.rerender(); }; };
  flip('ovAnon', on => { state.ui.anonymous = on; });
  flip('ovSnd', on => { state.muted = !on; const b = $('#muteBtn'); if (b) b.innerHTML = icon(state.muted ? 'mute' : 'sound'); });
  flip('ovFx', on => { state.ui.fx = on; });
  flip('ovNot', on => { state.ui.notify = on; });
  flip('ovStream', on => { state.ui.streamer = on; });
  flip('ovLvl', on => { state.ui.levelPopup = on; });
  flip('ovChat', on => { state.ui.chat = on; });
  $('#acNameSave', pane).onclick = () => {
    const v = ($('#acName', pane) as HTMLInputElement).value.trim();
    const bad = validateUsername(v, v.toLowerCase() === state.name.toLowerCase() ? [] : BOTS);
    if (bad) return toast(bad, 'error');
    state.name = v; save(); sfx.click(); toast('Display name saved', 'win');
    const me = $('.me .avatar'); if (me) me.outerHTML = avatar(v, 32);
    ctx.rerender();
  };
  ($('#acName', pane) as HTMLInputElement).onkeydown = e => { if (e.key === 'Enter') ($('#acNameSave', pane) as HTMLElement).click(); };

  if (backendEnabled()) void currentUser().then(async u => {
    const el = $('#ovFa', pane); if (!el) return;
    if (!u) { el.querySelector('b')!.textContent = 'Sign in first'; return; }
    const on = (await list2fa().catch(() => [])).some(f => f.status === 'verified');
    el.querySelector('b')!.textContent = on ? 'Enabled' : 'Disabled'; el.classList.toggle('good', on);
  }).catch(() => { /* leave the placeholder */ });
}
