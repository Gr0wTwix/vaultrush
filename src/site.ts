// What the admin site has switched for the whole game site: maintenance, a notice, paused games, closed sign-ups, blocked countries.
// The database enforces what it can (supabase/migrations/0007_site_controls.sql: the live games, free crates and sign-up refuse by themselves).
// This file makes the page behave to match: a banner, a full-screen message, a "paused" panel. Without a backend nothing is ever switched.
// Staff (anyone with an admin role) are never held back, so the Owner can always get in to switch things back.
import { backendEnabled, call } from './backend.js';
import { emit, on } from './state.js';
import { $, esc, h } from './ui.js';

export interface SiteStatus {
  maintenance: boolean; maintenance_message: string; notice: { text: string; kind: 'info' | 'warn' } | null;
  signups_open: boolean; games_off: string[]; country: string | null; country_blocked: boolean; staff: boolean;
}
const OPEN: SiteStatus = { maintenance: false, maintenance_message: '', notice: null, signups_open: true, games_off: [], country: null, country_blocked: false, staff: false };
export const POLL_MS = 30_000, GRACE_MS = 60_000;

/** Which switchable game each page belongs to (the nav ids used by the router). */
export const GAME_OF_NAV: Record<string, string> = { cases: 'cases', battles: 'battles', upgrade: 'upgrade', crash: 'crash', double: 'double', plinko: 'plinko', mines: 'mines', coin: 'coinflip' };
const GAME_NAMES: Record<string, string> = { cases: 'Cases', battles: 'Battles', upgrade: 'Upgrade', crash: 'Crash', double: 'Double', plinko: 'Plinko', mines: 'Mines', coinflip: 'Coinflip' };

let cur: SiteStatus = OPEN, graceUntil = 0, overlayTimer = 0, pollTimer = 0, started = false;
export const siteStatus = (): SiteStatus => cur;
export const gameOff = (game: string): boolean => !cur.staff && cur.games_off.includes(game);
export const signupsOpen = (): boolean => cur.staff || cur.signups_open;
/** Why the whole site is closed to this visitor right now, or null. A maintenance that has just started waits out its grace minute. */
export const blockedBy = (): 'maintenance' | 'country' | null => {
  if (cur.staff) return null;
  if (cur.country_blocked) return 'country';
  return cur.maintenance && Date.now() >= graceUntil ? 'maintenance' : null;
};

export function pausedPanel(game: string): string {
  const name = GAME_NAMES[game] ?? 'This game';
  return `<div class="panel empty site-paused"><h2>${esc(name)} is paused</h2><p class="muted">It has been switched off for now. Anything you already put in is safe. Try another game or check back soon.</p><a class="btn btn-primary" href="#/">Go home</a></div>`;
}

function renderNotice(): void {
  $('#siteNotice')?.remove();
  const grace = cur.maintenance && !cur.staff && Date.now() < graceUntil;
  const n = grace ? { text: 'Maintenance is about to start. Finish what you are doing: the site will close in a minute.', kind: 'warn' as const } : cur.notice;
  if (!n) return;
  const bar = h(`<div class="site-notice ${n.kind}" id="siteNotice" role="status"><span>${esc(n.text)}</span></div>`);
  ($('#topbar') ?? document.body).after(bar);
}
function renderBlock(): void {
  const why = blockedBy(), app = $('.app');
  $('#siteBlock')?.remove();
  document.body.classList.toggle('site-blocked', !!why);
  if (app) { if (why) app.setAttribute('inert', ''); else app.removeAttribute('inert'); }
  if (!why) return;
  const title = why === 'country' ? 'Not available in your country' : 'Down for maintenance';
  const text = why === 'country'
    ? `Vaultrush is not available where you are${cur.country ? ` (${esc(cur.country)})` : ''}. We are sorry about that.`
    : esc(cur.maintenance_message || 'We are making improvements. Please check back in a little while.');
  document.body.append(h(`<div class="site-block" id="siteBlock" role="alertdialog" aria-modal="true" aria-labelledby="siteBlockT"><div class="site-block-card"><div class="logo-text">VAULT<b>RUSH</b></div><h1 id="siteBlockT">${title}</h1><p>${text}</p>${why === 'maintenance' ? '<p class="muted small">Your coins and items are safe. This page checks again by itself.</p>' : ''}</div></div>`));
}
/** Draw the banner and the full-screen message for the current status. */
export function applySiteUi(): void {
  clearTimeout(overlayTimer);
  renderNotice(); renderBlock();
  if (cur.maintenance && !cur.staff && Date.now() < graceUntil) overlayTimer = window.setTimeout(applySiteUi, graceUntil - Date.now() + 50);
}

/** Fetch the status now. A failed fetch keeps what we knew (a hiccup must never close the site). Returns true when something changed. */
export async function refreshSite(): Promise<boolean> {
  if (!backendEnabled()) return false;
  let next: SiteStatus;
  try { next = { ...OPEN, ...(await call<SiteStatus>('site_status')) }; } catch { return false; }
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  const wasOpen = !cur.maintenance || cur.staff;
  cur = next;
  if (started && next.maintenance && !next.staff && wasOpen) graceUntil = Date.now() + GRACE_MS;     // switched on while the page is open: a minute to finish
  else if (!next.maintenance) graceUntil = 0;
  applySiteUi(); emit('site', cur);
  return true;
}

/** Start-up: read the status, then keep it fresh (every 30 seconds, when the tab comes back, and after signing in or out). */
export async function initSite(): Promise<void> {
  if (!backendEnabled()) return;
  await refreshSite();
  started = true;
  clearInterval(pollTimer); pollTimer = window.setInterval(() => void refreshSite(), POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshSite(); });
  on('auth', () => void refreshSite());
}
/** For tests: forget everything. */
export function resetSite(): void { clearTimeout(overlayTimer); clearInterval(pollTimer); cur = OPEN; graceUntil = 0; started = false; $('#siteNotice')?.remove(); $('#siteBlock')?.remove(); document.body.classList.remove('site-blocked'); $('.app')?.removeAttribute('inert'); }
