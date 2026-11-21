// Account window > Responsible Play: limits, reality check, session, breaks, self-assessment and help.
import { state, save, isExcluded, isServerWallet } from './state.js';
import {
  COOL_OFF_OPTIONS, DAY_MS, HELP_RESOURCES, LIMIT_LABELS, PGSI_OPTIONS, PGSI_QUESTIONS, activityStatement, cancelPending, netLoss,
  playedTodayMs, scorePgsi, sessionSummary, setLimit, stakedToday,
} from './rg.js';
import { cancelServerLimit, isServerLimit, limitsFetchedAt, refreshLimits, serverUsage, setServerLimit, takeBreak } from './rg-server.js';
import type { RgLimitKey } from './types.js';
import { $, $$, esc, fmt, icon, toast, toastKeep } from './ui.js';
import { sfx } from './sfx.js';

export interface PaneCtx { rerender: () => void; close: () => void }

const MONEY_LIMITS: RgLimitKey[] = ['lossDaily', 'lossWeekly', 'lossMonthly', 'wagerDaily', 'maxBet'];
const when = (t: number): string => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const left = (ms: number): string => { const h = Math.max(0, Math.ceil(ms / 3_600_000)); return h >= 48 ? `${Math.ceil(h / 24)} days` : `${h} h`; };

function usage(key: RgLimitKey): { used: number; limit: number } | null {
  const lim = state.rg.limits[key];
  if (lim === null || lim === 0) return null;
  const rg = state.rg, now = Date.now(), su = serverUsage();                          // with the server wallet the database's own count is shown, not this browser's
  const used = key === 'lossDaily' ? (su ? su.loss1 : netLoss(rg, 1, now)) : key === 'lossWeekly' ? (su ? su.loss7 : netLoss(rg, 7, now)) : key === 'lossMonthly' ? (su ? su.loss30 : netLoss(rg, 30, now))
    : key === 'wagerDaily' ? (su ? su.stakedToday : stakedToday(rg, now)) : key === 'timeDailyMin' ? (su ? su.activeMinutes : Math.floor(playedTodayMs(rg, now) / 60_000)) : 0;
  return key === 'maxBet' ? null : { used, limit: lim };
}

function limitRow(key: RgLimitKey): string {
  const cur = state.rg.limits[key], u = usage(key), p = state.rg.pending.find(x => x.key === key);
  const unit = key === 'timeDailyMin' ? 'min' : 'coins';
  const pct = u ? Math.min(100, (u.used / u.limit) * 100) : 0;
  return `<div class="rg-limit" data-k="${key}">
    <div class="rg-limit-h"><b>${LIMIT_LABELS[key]}</b><span class="muted small">${cur === null ? 'No limit' : `${fmt(cur)} ${unit}`}</span></div>
    ${u ? `<div class="rg-use ${pct >= 90 ? 'hot' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div><div class="muted small">${fmt(u.used)} of ${fmt(u.limit)} ${unit} used</div>` : ''}
    <div class="ac-inline"><input type="number" min="0" step="1" placeholder="${cur === null ? 'Set a limit' : 'New value'}" aria-label="${LIMIT_LABELS[key]}"><button class="btn btn-ghost btn-sm" data-set>Set</button>${cur === null ? '' : '<button class="btn btn-ghost btn-sm" data-off aria-label="Remove this limit after 24 hours">Remove (after 24 h)</button>'}</div>
    <div class="rg-hint muted small" data-hint aria-live="polite"></div>
    ${cur === 0 ? '<div class="ac-note">A limit of 0 blocks betting until you raise it. Raising takes 24 hours.</div>' : ''}
    ${key === 'timeDailyMin' && isServerWallet() ? '<div class="ac-note">The database cannot see your screen, so it estimates play time from your bets: the time between two bets (when it is 5 minutes or less) plus 20 seconds for each bet.</div>' : ''}
    ${p ? `<div class="rg-pending">Change to <b>${p.value === null ? 'no limit' : `${fmt(p.value)} ${unit}`}</b> takes effect on ${when(p.effectiveAt)} (in ${left(p.effectiveAt - Date.now())}). <button class="link" data-cancel>Cancel</button></div>` : ''}
  </div>`;
}

export function renderResponsible(pane: HTMLElement, ctx: PaneCtx): void {
  const rg = state.rg, now = Date.now(), ss = sessionSummary(state, now);
  const stmt = activityStatement(state, 7, now), last = rg.assessments[0];
  const blocked = isExcluded() ? `Self-exclusion until ${when(state.excludedUntil)}` : rg.coolOffUntil > now ? `Cool-off until ${when(rg.coolOffUntil)}` : '';
  pane.innerHTML = `
    <h2 class="ac-h">Responsible Play</h2>
    <p class="ac-sub">Tools to stay in control. Coins here are play money, but the habits are real: set limits, take breaks, and check in with yourself.</p>
    ${blocked ? `<div class="ac-card ac-warn"><h3>Betting is paused</h3><p class="ac-note">${esc(blocked)}. Rewards, browsing and the Fairness tools keep working.</p></div>` : ''}

    <div class="ac-card"><h3>Limits</h3>
      ${isServerWallet() ? '<p class="ac-note">These limits are kept by the database, so they hold on every device and cannot be changed by editing the page.</p>' : ''}
      <p class="ac-note">A limit you tighten applies at once. Raising or removing a limit takes 24 hours and can be cancelled. Type a new value and the note under the box tells you which of the two it is. Loss limits count settled bets, so winnings offset losses.</p>
      <div class="rg-limits">${[...MONEY_LIMITS, 'timeDailyMin' as RgLimitKey].map(limitRow).join('')}</div>
      <div class="ac-row"><span>Reality check<small>A reminder of your time and results</small></span>
        <select id="rgReality" aria-label="Reality check interval">${[[15, 'Every 15 min'], [30, 'Every 30 min'], [60, 'Every hour'], [0, 'Off']].map(([v, l]) => `<option value="${v}" ${rg.limits.realityMin === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${rg.pending.some(x => x.key === 'realityMin') ? '<div class="rg-pending">Reality-check change pending (24h). <button class="link" data-cancel-reality>Cancel</button></div>' : ''}
    </div>

    <div class="ac-card"><h3>This session</h3>
      <div class="ac-stats three"><div class="ac-stat"><b>${ss.minutes} min</b><span>Session time</span></div><div class="ac-stat"><b>${Math.floor(playedTodayMs(rg, now) / 60_000)} min</b><span>Played today</span></div><div class="ac-stat"><b class="${ss.net >= 0 ? 'pos' : 'neg'}">${ss.net >= 0 ? '+' : ''}${fmt(ss.net)}</b><span>Net this session (${ss.bets} bets)</span></div></div>
      <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Day</th><th>Staked</th><th>Returned</th><th>Net</th><th class="r">Minutes</th></tr></thead><tbody>
      ${stmt.map(r => `<tr><td>${r.day}</td><td>${fmt(r.staked)}</td><td>${fmt(r.paid)}</td><td class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : ''}${fmt(r.net)}</td><td class="r muted">${r.minutes}</td></tr>`).join('')}</tbody></table></div>
    </div>

    <div class="ac-card"><h3>Take a break</h3>
      <p class="ac-note">Both stop betting until they end, and neither can be shortened once started. Rewards, browsing and the Fairness tools keep working. <b>Cool-off</b> is a pause you choose to take. <b>Self-exclusion</b> is a firmer commitment and is shown on your account as such.</p>
      <div class="ac-pills" id="rgCool">${COOL_OFF_OPTIONS.map(([l, ms]) => `<button data-cool="${ms}">Cool-off ${l}</button>`).join('')}</div>
      <div class="ac-pills" id="rgExcl">${[['3 days', 3 * DAY_MS], ['14 days', 14 * DAY_MS], ['30 days', 30 * DAY_MS]].map(([l, ms]) => `<button class="warn" data-excl="${ms}">Self-exclude ${l}</button>`).join('')}</div>
    </div>

    <div class="ac-card"><h3>Self-assessment</h3>
      <p class="ac-note">Nine questions from the Problem Gambling Severity Index (PGSI). Your answers stay in this browser.${last ? ` Last result: <b>${esc(last.band)}</b> (${last.score}/27) on ${when(last.at)}.` : ''}</p>
      <button class="btn btn-ghost" id="rgQuiz">${last ? 'Take it again' : 'Start the check'}</button><div id="rgQuizBox"></div>
    </div>

    <div class="ac-card"><h3>Need to talk to someone?</h3>
      <p class="ac-note">Free, confidential support:</p>
      <ul class="rg-help">${HELP_RESOURCES.map(h => `<li><a href="${h.url}" target="_blank" rel="noopener noreferrer">${esc(h.name)}</a></li>`).join('')}</ul>
      <p class="ac-note">You must be 18 or older to play. <a href="#/responsible" id="rgPolicy">Read our responsible-play policy</a>.</p>
    </div>
    ${rg.log.length ? `<div class="ac-card"><h3>Recent changes</h3><ul class="rg-log">${rg.log.slice(0, 8).map(l => `<li><span class="muted">${when(l.at)}</span> ${esc(l.text)}</li>`).join('')}</ul></div>` : ''}`;

  $$('.rg-limit', pane).forEach((box: HTMLElement) => {
    const key = box.dataset.k as RgLimitKey, input = $('input', box) as HTMLInputElement;
    const apply = async (v: number | null) => {
      if (isServerWallet() && isServerLimit(key)) {                                      // the database keeps and checks this limit
        if (v !== null && (!Number.isFinite(v) || v < 0)) return toast('Enter a number of zero or more', 'error');
        try {
          const r = await setServerLimit(key, v);
          if (r === 'same') return toastKeep('That is already your limit');
          sfx.click(); toastKeep(r === 'pending' ? `Change requested: it takes effect on ${when(Date.now() + DAY_MS)}` : 'Limit saved', 'win');
        } catch (e) { return toast((e as Error).message, 'error'); }
        ctx.rerender(); return;
      }
      const r = setLimit(rg, key, v);
      if (r.status === 'invalid') return toast('Enter a number of zero or more', 'error');
      if (r.status === 'same') return toastKeep('That is already your limit');
      save(); sfx.click();
      toastKeep(r.status === 'pending' ? `Change requested: it takes effect on ${when(Date.now() + DAY_MS)}` : 'Limit saved', 'win'); ctx.rerender();
    };
    const hint = $('[data-hint]', box) as HTMLElement;
    input.addEventListener('input', () => {
      const now = state.rg.limits[key], typed = input.value === '' ? null : Number(input.value);
      if (typed === null) { hint.textContent = ''; return; }
      if (!Number.isFinite(typed) || typed < 0) { hint.textContent = 'Enter zero or more.'; return; }
      if (typed === now) { hint.textContent = 'That is already your limit.'; return; }
      const tighter = now === null || typed < now;
      hint.textContent = (tighter ? 'Tighter: applies now.' : `Looser: applies on ${when(Date.now() + DAY_MS)}.`) + (typed === 0 ? ' A limit of 0 stops betting.' : '');
    });
    $('[data-set]', box).onclick = () => { if (input.value === '') return toast('Enter a value first', 'error'); void apply(Number(input.value)); };
    $('[data-off]', box)?.addEventListener('click', () => { void apply(null); });
    $('[data-cancel]', box)?.addEventListener('click', async () => {
      if (isServerWallet() && isServerLimit(key)) { try { await cancelServerLimit(key); } catch (e) { toast((e as Error).message, 'error'); } ctx.rerender(); return; }
      cancelPending(rg, key); save(); ctx.rerender();
    });
  });
  ($('#rgReality', pane) as HTMLSelectElement).onchange = e => {
    const r = setLimit(rg, 'realityMin', Number((e.target as HTMLSelectElement).value));
    save(); toastKeep(r.status === 'pending' ? `Change requested: it takes effect on ${when(Date.now() + DAY_MS)}` : 'Reality check updated', 'win'); ctx.rerender();
  };
  $('[data-cancel-reality]', pane)?.addEventListener('click', () => { cancelPending(rg, 'realityMin'); save(); ctx.rerender(); });
  $$('[data-cool]', pane).forEach((b: HTMLElement) => b.onclick = async () => {
    const ms = Number(b.dataset.cool), until = Date.now() + ms;
    if (!confirm(`Start a cool-off for ${b.textContent?.replace('Cool-off ', '')}? You cannot bet until ${when(until)}.`)) return;
    try { const end = await takeBreak('cool-off', ms); toastKeep(`Cool-off started. Betting is paused until ${when(Math.max(until, end))}.`); } catch (e) { toast((e as Error).message, 'error'); }
    ctx.rerender();
  });
  $$('[data-excl]', pane).forEach((b: HTMLElement) => b.onclick = async () => {
    const ms = Number(b.dataset.excl), until = Date.now() + ms;
    if (!confirm(`${b.textContent}? You cannot bet until ${when(until)}, and it cannot be lifted early.`)) return;
    try { const end = await takeBreak('self-exclusion', ms); toastKeep(`Self-exclusion started. Betting is paused until ${when(Math.max(until, end))}.`); } catch (e) { toast((e as Error).message, 'error'); }
    ctx.rerender();
  });
  // With the server wallet, the database's numbers are fetched when the page opens (and the page is drawn again once they arrive; the 10 second guard stops a loop).
  if (isServerWallet() && Date.now() - limitsFetchedAt() > 10_000) void refreshLimits().then(() => ctx.rerender()).catch(() => {});
  $('#rgPolicy', pane).onclick = () => ctx.close();
  $('#rgQuiz', pane).onclick = () => quiz($('#rgQuizBox', pane), ctx);
}

function quiz(box: HTMLElement, ctx: PaneCtx): void {
  box.innerHTML = `<div class="rg-quiz">${PGSI_QUESTIONS.map((q, i) => `<fieldset><legend>${i + 1}. ${esc(q)}</legend>${PGSI_OPTIONS.map((o, v) => `<label><input type="radio" name="q${i}" value="${v}"> ${o}</label>`).join('')}</fieldset>`).join('')}
    <button class="btn btn-primary" id="rgQuizDone">See my result</button><div id="rgQuizRes"></div></div>`;
  $('#rgQuizDone', box).onclick = () => {
    const answers = PGSI_QUESTIONS.map((_, i) => { const c = box.querySelector(`input[name="q${i}"]:checked`) as HTMLInputElement | null; return c ? Number(c.value) : -1; });
    const r = scorePgsi(answers);
    if (!r) return toast('Please answer every question', 'error');
    state.rg.assessments.unshift({ at: Date.now(), score: r.score, band: r.band }); state.rg.assessments.length = Math.min(state.rg.assessments.length, 10);
    save();
    $('#rgQuizRes', box).innerHTML = `<div class="ac-card ${r.band === 'non-problem' || r.band === 'low risk' ? '' : 'ac-warn'}"><h3>${esc(r.band)}: ${r.score} / 27</h3><p class="ac-note">${esc(r.advice)}</p>${r.score >= 3 ? '<button class="btn btn-primary" id="rgSetNow">Set limits now</button>' : ''}</div>`;
    $('#rgSetNow', box)?.addEventListener('click', () => { const first = document.querySelector('.rg-limits input') as HTMLInputElement | null; first?.scrollIntoView({ block: 'center' }); first?.focus(); });
  };
}
