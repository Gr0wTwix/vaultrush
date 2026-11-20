// Rewards hub: level, rakeback, free cases (welcome, daily, level), promo codes and a login calendar.
import { CASE, ITEM, RARITY, entryForTicket, ticketOf } from '../data.js';
import { state, save, grant, credit, logTx, addItems, removeItems, round2, level, xpForLevel, todayKey, DAY, isAuthed } from '../state.js';
import { bet, annotate } from '../fair.js';
import { pushDrop } from '../feed.js';
import { takeFreeClaim } from '../live.js';
import { $, $$, esc, fmt, money, icon, toast, caseArt, itemCard, spinReel, modal, confetti, avatar, SPEEDS, reelMs, guestCard } from '../ui.js';
import { sfx } from '../sfx.js';

export const LEVEL_CASES: [number, string][] = [[10, 'starter'], [20, 'neon'], [30, 'charmed'], [40, 'sniper'], [50, 'blade'], [60, 'high']];
const CALENDAR = [1, 2, 3, 5, 8, 12, 25];
const PROMOS = { VAULT10: 10, RUSH5: 5, WELCOME3: 3, LUCKY7: 7 };
const WEEK = 7 * DAY;

const left = ms => { const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`; };

/** Open a free case in a modal with the reel. Resolves when the item is granted. */
export async function openFreeCase(c, label) {
  const m = modal(`<h2>${esc(label)}: ${esc(c.name)}</h2><div class="reel-host" id="freeReel"></div><div id="freeRes" class="free-res"></div>`, { wide: true });
  const { floats, entry } = await bet('cases', 1, { case: c.id });
  const ticket = ticketOf(floats[0]);
  const item = entryForTicket(c, ticket).item;
  annotate(entry, `${label} ${c.name}: ticket #${ticket} → ${item.weapon} | ${item.skin}`, `${ticket}:${item.id}`);
  const [added] = addItems([item]);       // granted before the animation
  logTx(label, item.value, `${item.weapon} | ${item.skin}`);
  await spinReel($('#freeReel', m.el), c.entries, item, { duration: reelMs() });
  pushDrop({ user: state.name, item, source: c.name });
  if (['legendary', 'mythic', 'epic'].includes(item.rarity)) { sfx.big(); confetti(RARITY[item.rarity].color); } else sfx.win();
  const res = $('#freeRes', m.el);
  res.innerHTML = `${itemCard(item)}<div class="row"><button class="btn btn-ghost" id="keep">Keep in inventory</button><button class="btn btn-primary" id="sell">Sell for ${money(item.value)}</button></div>`;
  $('#keep', res).onclick = m.close;
  $('#sell', res).onclick = () => { removeItems([added.uid]); credit(item.value); sfx.click(); m.close(); };
}

export function render(el) {
  let alive = true, busy = false;                 // busy stops a double click from opening a crate twice while the server is asked
  const draw = () => {
    const lvl = level(), xp = state.xp, cur = xpForLevel(lvl), next = xpForLevel(lvl + 1);
    const rb = state.rakeback, now = Date.now();
    const dailyReady = now - rb.lastDaily >= DAY, weeklyReady = now - rb.lastWeekly >= WEEK;
    const dailyCaseReady = now - state.lastDailyCase >= DAY;
    const today = todayKey(), yesterday = todayKey(now - DAY);
    const cal = state.calendar;
    const claimedToday = cal.last === today;
    const streak = claimedToday || cal.last === yesterday ? cal.streak : 0;
    const shown = claimedToday ? streak : streak % 7;      // a finished 7-day cycle starts over
    const nextDay = claimedToday ? -1 : shown;

    el.innerHTML = `
      <div class="page-head"><h1>${icon('gift')} Rewards</h1><p class="muted">Every coin you wager earns XP and rakeback. Level up to unlock free cases.</p></div>
      ${!isAuthed() ? guestCard('Sign in to start earning XP', 'Every coin you wager earns XP and rakeback, and free cases unlock as you level up. The rewards below are a preview.') : ''}
      <section class="panel level-card" ${isAuthed() ? '' : 'hidden'}>
        ${avatar(state.name, 56)}
        <div class="lvl-info"><div class="row"><b class="lvl-num">Level ${lvl}</b><span class="muted small">${(xp - cur).toLocaleString('en-US')} / ${(next - cur).toLocaleString('en-US')} XP</span></div>
          <div class="xp-bar"><i style="width:${Math.min(100, ((xp - cur) / (next - cur)) * 100)}%"></i></div>
          <span class="muted small">1 coin wagered = 10 XP · next free case at level ${(Math.floor(lvl / 10) + 1) * 10}</span></div>
      </section>

      <h2 class="section-title">Rakeback</h2>
      <section class="reward-grid three">
        <div class="panel rcard"><span class="muted small">Instant · 0.4%</span><b>${money(rb.instant)}</b><button class="btn btn-primary block" data-rb="instant" data-needs-auth="claim" ${rb.instant >= 0.01 ? '' : 'disabled'}>Claim</button></div>
        <div class="panel rcard"><span class="muted small">Daily · 0.3%</span><b>${money(rb.daily)}</b><button class="btn btn-primary block" data-rb="daily" data-needs-auth="claim" ${dailyReady && rb.daily >= 0.01 ? '' : 'disabled'}>${dailyReady ? 'Claim' : `In ${left(DAY - (now - rb.lastDaily))}`}</button></div>
        <div class="panel rcard"><span class="muted small">Weekly · 0.3%</span><b>${money(rb.weekly)}</b><button class="btn btn-primary block" data-rb="weekly" data-needs-auth="claim" ${weeklyReady && rb.weekly >= 0.01 ? '' : 'disabled'}>${weeklyReady ? 'Claim' : `In ${left(WEEK - (now - rb.lastWeekly))}`}</button></div>
      </section>

      <h2 class="section-title">Free cases</h2>
      <section class="reward-grid">
        <div class="panel rcase" style="--hue:${CASE.welcome.hue}">${caseArt(CASE.welcome)}<b>Welcome Crate</b><span class="muted small">${state.welcomeLeft > 0 ? 'One free open per account' : 'Already opened'}</span><button class="btn btn-primary block" id="welcome" data-needs-auth="claim" ${state.welcomeLeft > 0 ? '' : 'disabled'}>Open free</button></div>
        <div class="panel rcase" style="--hue:${CASE.daily.hue}">${caseArt(CASE.daily)}<b>Daily Crate</b><span class="muted small">Once every 24 hours</span><button class="btn btn-primary block" id="dailyCase" data-needs-auth="claim" ${dailyCaseReady ? '' : 'disabled'}>${dailyCaseReady ? 'Open free' : `In ${left(DAY - (now - state.lastDailyCase))}`}</button></div>
        ${LEVEL_CASES.map(([req, id]) => {
          const used = state.keysUsed.includes(req), unlocked = lvl >= req;
          return `<div class="panel rcase ${unlocked && !used ? '' : 'locked'}" style="--hue:${CASE[id].hue}">${caseArt(CASE[id])}<b>Level ${req} case</b><span class="muted small">${esc(CASE[id].name)} · worth ${money(CASE[id].price)}</span><button class="btn ${unlocked && !used ? 'btn-primary' : 'btn-ghost'} block" data-lvl="${req}" data-needs-auth="claim" ${unlocked && !used ? '' : 'disabled'}>${used ? 'Opened' : unlocked ? 'Use key' : `Reach level ${req}`}</button></div>`;
        }).join('')}
      </section>

      <div class="reward-split">
        <section class="panel">
          <div class="panel-head"><h2>Daily login streak</h2><span class="muted small">Miss a day and it starts over</span></div>
          <div class="calendar">${CALENDAR.map((v, i) => {
            const done = i < shown;
            const isNext = i === nextDay;
            return `<button class="cal-day ${done ? 'done' : ''} ${isNext ? 'next' : ''}" data-needs-auth="claim" data-day="${i}" ${isNext ? '' : 'disabled'}><span>Day ${i + 1}</span><b>${money(v)}</b>${done ? '<i>✓</i>' : ''}</button>`;
          }).join('')}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Promo code</h2></div>
          <form class="amount" id="promoForm"><input id="promo" placeholder="Enter code" maxlength="20" autocomplete="off"><button type="submit">Redeem</button></form>
          <p class="muted small">Demo codes: VAULT10, RUSH5, WELCOME3, LUCKY7. Each works once.</p>
        </section>
      </div>`;

    $$('[data-rb]', el).forEach(b => b.onclick = () => {
      const k = b.dataset.rb, amount = round2(state.rakeback[k]);
      if (amount < 0.01) return;
      state.rakeback[k] = 0;
      if (k === 'daily') state.rakeback.lastDaily = Date.now();
      if (k === 'weekly') state.rakeback.lastWeekly = Date.now();
      grant(amount, `Rakeback (${k})`); sfx.win(); toast(`Rakeback +${fmt(amount)}`, 'win'); draw();
    });
    /** The server (cloud accounts) or this browser (browser-only accounts) decides whether the crate may be opened. */
    const allowed = async (kind: 'welcome' | 'daily_case'): Promise<boolean> => {
      const r = await takeFreeClaim(kind);
      if (r === 'error') { toast('Could not check your claim. Try again in a moment.', 'error'); return false; }
      if (r === 'taken') { toast(kind === 'welcome' ? 'You already opened your welcome crate.' : 'You already opened today\'s crate on this account.', 'error'); if (alive) draw(); return false; }
      return true;
    };
    $('#welcome', el).onclick = async () => {
      if (busy || state.welcomeLeft <= 0) return;
      busy = true;
      try {
        if (!(await allowed('welcome'))) return;
        state.welcomeLeft = 0; save();
        await openFreeCase(CASE.welcome, 'Welcome gift');
      } finally { busy = false; }
      if (alive) draw();
    };
    $('#dailyCase', el).onclick = async () => {
      if (busy || Date.now() - state.lastDailyCase < DAY) return;
      busy = true;
      try {
        if (!(await allowed('daily_case'))) return;
        state.lastDailyCase = Date.now(); save();
        await openFreeCase(CASE.daily, 'Daily case');
      } finally { busy = false; }
      if (alive) draw();
    };
    $$('[data-lvl]', el).forEach(b => b.onclick = async () => {
      const req = +b.dataset.lvl;
      if (level() < req || state.keysUsed.includes(req)) return;
      state.keysUsed.push(req); save();
      await openFreeCase(CASE[LEVEL_CASES.find(l => l[0] === req)[1]], `Level ${req} key`); if (alive) draw();
    });
    $$('.cal-day.next', el).forEach(b => b.onclick = () => {
      const i = +b.dataset.day;
      state.calendar = { streak: i + 1, last: todayKey() };
      grant(CALENDAR[i], `Login calendar, day ${i + 1}`); sfx.win(); toast(`Day ${i + 1} reward +${fmt(CALENDAR[i])}`, 'win'); draw();
    });
    $('#promoForm', el).onsubmit = e => {
      e.preventDefault();
      const code = $('#promo', el).value.trim().toUpperCase();
      if (!PROMOS[code]) return toast('That code is not valid', 'error');
      if (state.promos.includes(code)) return toast('You already used that code', 'error');
      state.promos.push(code); grant(PROMOS[code], `Promo code ${code}`); sfx.win();
      toast(`Code ${code}: +${fmt(PROMOS[code])}`, 'win'); draw();
    };
  };
  draw();
  const t = setInterval(() => { if (!document.querySelector('.modal-back')) draw(); }, 30000);
  return () => { alive = false; clearInterval(t); };
}
