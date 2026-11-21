// Responsible-gambling runtime: the 18+ gate, play-time tracking and the reality check.
import { state, save } from './state.js';
import { acknowledgeReality, addPlayTime, confirmAge, realityDue, sessionSummary, startSession } from './rg.js';
import { takeBreak } from './rg-server.js';
import { $, fmt, h, icon } from './ui.js';
import { openAccount } from './account.js';
import { sfx } from './sfx.js';
import { activeAccount } from './accounts.js';
import { rngHealth } from './rng.js';
import { toast, toastKeep } from './ui.js';

const TICK_MS = 5000;

let overlaySeq = 0;
function overlay(html: string, cls = ''): HTMLElement {
  const opener = document.activeElement as HTMLElement | null;
  const el = h(`<div class="rg-overlay ${cls}" role="dialog" aria-modal="true"><div class="rg-box">${html}</div></div>`) as HTMLElement;
  const heading = el.querySelector('h2, h3');
  if (heading) { heading.id = `rgd${++overlaySeq}`; el.setAttribute('aria-labelledby', heading.id); }
  document.body.append(el);
  document.querySelector('.app')?.setAttribute('inert', '');     // the page behind cannot be reached until the overlay is answered
  (el.querySelector('button, a[href]') as HTMLElement | null)?.focus();
  const remove = el.remove.bind(el);
  el.remove = () => {
    remove();
    if (!document.querySelector('.modal-back, .rg-overlay')) document.querySelector('.app')?.removeAttribute('inert');
    if (opener?.isConnected) opener.focus();
  };
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
  $('#rgBreak', el).onclick = async () => {
    try {
      const until = await takeBreak('cool-off', 24 * 3_600_000);                       // kept by the database when the server wallet is on
      done(); toastKeep(`Cool-off started. Betting is paused until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
}

/** Call once at start-up (after the top bar exists). */
export function initRg(): void {
  startSession(state.rg); save();
  if (!state.rg.ageConfirmedAt && activeAccount()) showAgeGate(); // signed-out visitors can browse; the register form's 18+ tickbox covers this

  let last = performance.now(), sinceSave = 0;
  setInterval(() => {
    const now = performance.now(), dt = now - last; last = now;
    if (!document.hidden) { addPlayTime(state.rg, Math.min(dt, TICK_MS * 3)); sinceSave += dt; }
    if (sinceSave >= 30_000) { save(); sinceSave = 0; }
    if (state.rg.ageConfirmedAt && realityDue(state.rg)) showReality();
  }, TICK_MS);

  // A failed RNG health test is surfaced at once (a production system would also halt the affected games).
  rngHealth.onAlarm = reason => toast(`RNG health alarm: ${reason}`, 'error');
}
