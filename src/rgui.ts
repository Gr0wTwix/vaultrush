// Responsible-gambling runtime: the 18+ gate, the session clock, play-time tracking and the reality check.
import { state, save } from './state.js';
import { acknowledgeReality, addPlayTime, confirmAge, realityDue, sessionSummary, startCoolOff, startSession } from './rg.js';
import { $, fmt, h, icon } from './ui.js';
import { openAccount } from './account.js';
import { sfx } from './sfx.js';
import { rngHealth } from './rng.js';
import { toast } from './ui.js';

const TICK_MS = 5000;

function overlay(html: string, cls = ''): HTMLElement {
  const el = h(`<div class="rg-overlay ${cls}" role="dialog" aria-modal="true"><div class="rg-box">${html}</div></div>`) as HTMLElement;
  document.body.append(el);
  return el;
}

/** Everyone confirms they are an adult before the first bet. There is no way to dismiss it without answering. */
function showAgeGate(): void {
  if (document.querySelector('.rg-gate')) return;
  const el = overlay(`
    <div class="rg-logo">${icon('fair')}</div>
    <h2>Are you 18 or older?</h2>
    <p>Vaultrush is a <b>play-money</b> demo about skin games. Coins have no cash value, but gambling content is for adults only. You can set limits, take breaks and use self-exclusion at any time from <b>Account &gt; Responsible Play</b>.</p>
    <div class="rg-actions"><button class="btn btn-primary btn-lg" id="rgYes">I am 18 or older</button><button class="btn btn-ghost btn-lg" id="rgNo">No</button></div>
    <p class="rg-fine">18+ · Play responsibly · <a href="#/responsible">Responsible play policy</a></p>`, 'rg-gate');
  $('#rgYes', el).onclick = () => { confirmAge(state.rg); save(); sfx.click(); el.remove(); };
  $('#rgNo', el).onclick = () => { $('.rg-box', el).innerHTML = '<div class="rg-logo">!</div><h2>Sorry, you cannot play</h2><p>You must be 18 or older to use Vaultrush. If gambling is a problem for you or someone you know, free help is available from <a href="https://www.begambleaware.org" target="_blank" rel="noopener noreferrer">BeGambleAware</a>.</p>'; };
}

function showReality(): void {
  if (document.querySelector('.rg-reality')) return;
  const s = sessionSummary(state);
  const el = overlay(`
    <div class="rg-logo">${icon('clock')}</div>
    <h2>Reality check</h2>
    <p>You have been playing for <b>${s.minutes} minutes</b>.</p>
    <div class="rg-sum"><div><span>Bets</span><b>${s.bets}</b></div><div><span>Staked</span><b>${fmt(s.staked)}</b></div><div><span>Returned</span><b>${fmt(s.paid)}</b></div><div><span>Net</span><b class="${s.net >= 0 ? 'pos' : 'neg'}">${s.net >= 0 ? '+' : ''}${fmt(s.net)}</b></div></div>
    <div class="rg-actions"><button class="btn btn-primary" id="rgGo">Keep playing</button><button class="btn btn-ghost" id="rgLimits">My limits</button><button class="btn btn-ghost" id="rgBreak">Take a 24 h break</button></div>`, 'rg-reality');
  const done = (): void => { acknowledgeReality(state.rg); save(); el.remove(); };
  $('#rgGo', el).onclick = done;
  $('#rgLimits', el).onclick = () => { done(); openAccount('responsible'); };
  $('#rgBreak', el).onclick = () => { startCoolOff(state.rg, 24 * 3_600_000); done(); toast('Cool-off started. See you tomorrow.'); };
}

function clockLabel(): string {
  const mins = Math.floor((Date.now() - state.rg.sessionStart) / 60_000);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

/** Call once at start-up (after the top bar exists). */
export function initRg(): void {
  startSession(state.rg); save();
  if (!state.rg.ageConfirmedAt) showAgeGate();

  const slot = $('#freeBtn');
  if (slot) {
    const clock = h(`<button class="rg-clock" id="sessionClock" title="Session time. Click for responsible-play tools" aria-label="Session time">${icon('clock')}<span id="sessionClockT">0:00</span></button>`) as HTMLElement;
    slot.before(clock);
    clock.onclick = () => openAccount('responsible');
  }
  let last = performance.now(), sinceSave = 0;
  setInterval(() => {
    const now = performance.now(), dt = now - last; last = now;
    if (!document.hidden) { addPlayTime(state.rg, Math.min(dt, TICK_MS * 3)); sinceSave += dt; }
    const t = $('#sessionClockT'); if (t) t.textContent = clockLabel();
    if (sinceSave >= 30_000) { save(); sinceSave = 0; }
    if (state.rg.ageConfirmedAt && realityDue(state.rg)) showReality();
  }, TICK_MS);

  // A failed RNG health test is surfaced at once (a production system would also halt the affected games).
  rngHealth.onAlarm = reason => toast(`RNG health alarm: ${reason}`, 'error');
}
