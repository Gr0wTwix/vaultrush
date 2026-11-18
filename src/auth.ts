// Log in / Register, laid out like the reference sites: pill tabs, email (or username) and password with a Show button, an
// optional 2FA code, Google and Steam as the extra options, and an 18+ line at the bottom.
// With a Supabase project connected these are cloud accounts. Without one, they are local accounts kept in this browser
// (see accounts.ts): a hashed password, a username, and a separate set of progress for each account.
import {
  backendEnabled, completeSignup, currentUser, finishSteamLogin, hasProfile, onAuthChange, resetPassword, signInOAuth, signInPassword, signOut, signUp, startSteamLogin,
  steamEnabled, verifyLogin2fa,
} from './backend.js';
import { activeAccount, loginLocal, registerLocal, setActive, stateKeyFor } from './accounts.js';
import { confirmAge } from './rg.js';
import { isAuthed, newGameState, onLoginRequired, requireLogin, save, setAuthed, state } from './state.js';
import { TERMS_VERSION, validateEmail, validatePassword, validateRegistration, type Errors } from './signup.js';
import { $, $$, esc, h, icon, modal, toast } from './ui.js';
import { sfx } from './sfx.js';

type Tab = 'login' | 'register';
const field = (id: string, label: string, input: string, hint = ''): string => `<div class="au-field"><label for="${id}">${label}${hint ? ` <span class="au-hint">${hint}</span>` : ''}</label>${input}<small class="au-err" data-for="${id}" role="alert"></small></div>`;
const pass = (id: string, label: string, auto: string, ph: string): string =>
  field(id, label, `<div class="au-pass"><input id="${id}" type="password" autocomplete="${auto}" maxlength="72" placeholder="${ph}"><button type="button" class="au-show" data-show="${id}">Show</button></div>`);
const FIELD_ID: Record<string, string> = { username: 'auUser', email: 'auEmail', password: 'auPass', confirm: 'auPass2', age: 'auAdult', terms: 'auTerms' };
const showErrors = (root: HTMLElement, e: Errors): void => {
  $$('.au-err', root).forEach((el: HTMLElement) => { el.textContent = ''; });
  for (const [k, msg] of Object.entries(e)) { const el = root.querySelector(`.au-err[data-for="${FIELD_ID[k] as string}"]`); if (el) el.textContent = msg ?? ''; }
};
const checks = (): string => `
  <label class="au-check"><input type="checkbox" id="auAdult"> <span>I confirm that <b>I am at least 18 years old</b></span></label><small class="au-err" data-for="auAdult" role="alert"></small>
  <label class="au-check"><input type="checkbox" id="auTerms"> <span>I agree and understand the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="#/privacy" target="_blank" rel="noopener">Privacy Policy</a></span></label><small class="au-err" data-for="auTerms" role="alert"></small>`;

const GOOGLE = '<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7z" fill="#4285f4"/><path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9.5 9.5 0 0 0 12 21z" fill="#34a853"/><path d="M6.7 13.3a5.7 5.7 0 0 1 0-3.6V7.2H3.5a9.5 9.5 0 0 0 0 8.6z" fill="#fbbc05"/><path d="M12 6.4c1.4 0 2.7.5 3.7 1.4l2.8-2.8A9.5 9.5 0 0 0 3.5 7.2l3.2 2.5C7.4 8.1 9.5 6.4 12 6.4z" fill="#ea4335"/>';
const STEAM = '<path d="M12 2a10 10 0 0 0-9.900 8.600l5.300 2.200a2.800 2.800 0 0 1 1.600-.5l2.400-3.400v-.1a3.800 3.800 0 1 1 3.800 3.800h-.1l-3.400 2.500a2.800 2.800 0 0 1-5.500.6L2.200 14A10 10 0 1 0 12 2zM7.800 17.400l-1.200-.5a2.100 2.100 0 1 0 1.100-2.900l1.300.5a1.500 1.500 0 1 1-1.200 2.900zm8-5a2.500 2.500 0 1 1 0-5 2.500 2.500 0 0 1 0 5zm0-.9a1.600 1.600 0 1 0 0-3.200 1.600 1.600 0 0 0 0 3.200z" fill="currentColor"/>';
const providers = (): string => `<div class="au-or"><span>or</span></div><div class="au-provs">
  <button type="button" class="au-prov" data-prov="google"><svg viewBox="0 0 24 24" aria-hidden="true">${GOOGLE}</svg>Google</button>
  <button type="button" class="au-prov" data-prov="steam"><svg viewBox="0 0 24 24" aria-hidden="true">${STEAM}</svg>Steam</button></div><div class="au-note" id="auNote" role="status"></div>`;

const side = (): string => `<aside class="au-side"><div class="au-brand"><span class="logo-mark">${icon('bolt')}</span><b>VAULT<i>RUSH</i></b></div>
  <h2>Play the vault.</h2><p>A play-money skin-game demo. Coins have no cash value and cannot be bought or withdrawn.</p>
  <ul><li>${icon('fair')} Every result can be re-checked</li><li>${icon('heart')} Limits, breaks and self-exclusion</li><li>${icon('id')} Age and identity checks (sandbox)</li></ul>
  <small>By accessing the site, I attest that I am at least 18 years old and have read the <a href="#/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a>.</small></aside>`;

let open: { el: HTMLElement; close: () => void } | null = null;
let signedIn = false;
export const isSignedIn = (): boolean => signedIn;

/** Sign-in state of this browser: a cloud session if a backend is connected, otherwise the active local account. */
export const localSignedIn = (): boolean => !backendEnabled() && activeAccount() !== null;

export async function logout(): Promise<void> {
  if (backendEnabled()) { try { await signOut(); } catch { /* the page reloads anyway */ } }
  setActive('');
  location.hash = '#/'; location.reload();
}

/** Starts a fresh account's progress from the guest session and makes it the active one. The page reloads to load that account's state. */
function enterLocalAccount(id: string, username: string, fresh: boolean): void {
  if (fresh) {
    const base = newGameState();
    base.name = username; base.legal = { termsAt: Date.now(), termsVersion: TERMS_VERSION };
    base.rg = { ...newGameState().rg, ...base.rg }; if (!base.rg.ageConfirmedAt) base.rg.ageConfirmedAt = Date.now();
    localStorage.setItem(stateKeyFor(id), JSON.stringify(base));
  }
  setActive(id); location.hash = '#/'; location.reload();
}

export function openAuth(opts: { tab?: Tab; reason?: string } = {}): void {
  open?.close();
  const cloud = backendEnabled();
  let tab: Tab = opts.tab ?? 'login', lockUntil = 0, fails = 0;
  const m = modal('', { wide: true, onClose: () => { open = null; } });
  open = m; m.el.classList.add('auth-modal');
  const v = (id: string): string => (($('#' + id, m.el) as HTMLInputElement | null)?.value ?? '');
  const c = (id: string): boolean => !!($('#' + id, m.el) as HTMLInputElement | null)?.checked;
  const note = (t: string): void => { const n = $('#auNote', m.el); if (n) n.textContent = t; };
  const busy = (on: boolean, label: string): void => { const b = $('#auGo', m.el) as HTMLButtonElement | null; if (b) { b.disabled = on; b.textContent = on ? 'Please wait…' : label; } };

  const loginForm = (): string => `<form id="auForm" novalidate>
      ${field('auEmail', cloud ? 'Email' : 'Email or Username', `<input id="auEmail" ${cloud ? 'type="email"' : ''} autocomplete="username" placeholder="${cloud ? 'example@email.com' : 'example@email.com or username'}">`)}
      ${pass('auPass', 'Password', 'current-password', 'Enter Password')}<button type="button" class="link au-forgot" id="auForgot">Forgot Password?</button>
      ${cloud ? field('au2fa', '2FA Code', '<input id="au2fa" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Code">', '(Required if you have 2FA enabled.)') : ''}
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Log in</button></form>${providers()}`;
  const registerForm = (): string => `<form id="auForm" novalidate>
      ${field('auEmail', 'Email', '<input id="auEmail" type="email" autocomplete="email" placeholder="Email Address">')}
      ${field('auUser', 'Username', '<input id="auUser" autocomplete="nickname" maxlength="20" placeholder="Username">')}
      ${pass('auPass', 'Password', 'new-password', 'Enter Password').replace('</small></div>', '</small><div class="au-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>')}
      ${pass('auPass2', 'Confirm Password', 'new-password', 'Retype Password')}${checks()}
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Register</button></form>${providers()}
      ${cloud ? '' : '<p class="au-local">No server is connected, so accounts are stored in this browser only.</p>'}`;

  const draw = (): void => {
    m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button>${side()}<section class="au-main">${opts.reason ? `<div class="au-reason" role="status">${esc(opts.reason)}</div>` : ''}<div class="au-tabs" role="tablist"><button role="tab" data-t="login" class="${tab === 'login' ? 'on' : ''}">Log In</button><button role="tab" data-t="register" class="${tab === 'register' ? 'on' : ''}">Register</button></div>${tab === 'login' ? loginForm() : registerForm()}</section>`;
    $('.modal-x', m.el).onclick = m.close;
    $$('.au-tabs button', m.el).forEach((b: HTMLElement) => b.onclick = () => { tab = b.dataset.t as Tab; draw(); });
    $$('[data-show]', m.el).forEach((b: HTMLElement) => b.onclick = () => { const i = $('#' + b.dataset.show, m.el) as HTMLInputElement; i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'Show' : 'Hide'; });
    $$('[data-prov]', m.el).forEach((b: HTMLElement) => b.onclick = () => provider(b.dataset.prov as 'google' | 'steam'));
    if (tab === 'login') wireLogin(); else wireRegister();
    ($('#auEmail', m.el) as HTMLInputElement | null)?.focus();
  };

  const provider = async (p: 'google' | 'steam'): Promise<void> => {
    if (!cloud) return note(`${p === 'google' ? 'Google' : 'Steam'} sign-in needs a cloud backend. Connect a Supabase project (see supabase/README.md) to turn it on.`);
    try {
      if (p === 'google') await signInOAuth('google');
      else if (steamEnabled()) startSteamLogin();
      else note('Steam sign-in is not set up on this site yet. The steam-login function has to be deployed first (see supabase/README.md).');
    } catch (e) { note(e instanceof Error ? e.message : String(e)); }
  };

  const wireLogin = (): void => {
    $('#auForgot', m.el).onclick = async () => {
      if (!cloud) return note('Local accounts have no email recovery. Register a new account, or restore a backup under Account > Security.');
      if (validateEmail(v('auEmail'))) return showErrors(m.el, { email: 'Enter your email first.' });
      try { await resetPassword(v('auEmail').trim()); note('If that email has an account, a reset link is on its way.'); } catch (e) { note(e instanceof Error ? e.message : String(e)); }
    };
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      if (!v('auEmail').trim() || !v('auPass')) return note('Enter your email or username and your password.');
      if (Date.now() < lockUntil) return note(`Too many attempts. Try again in ${Math.ceil((lockUntil - Date.now()) / 1000)} seconds.`);
      busy(true, 'Log in');
      try {
        if (cloud) {
          const r = await signInPassword(v('auEmail').trim(), v('auPass'));
          if (r.needs2fa) { if (!v('au2fa').trim()) { busy(false, 'Log in'); return note('Enter the code from your authenticator app.'); } await verifyLogin2fa(v('au2fa')); }
          fails = 0; m.close(); sfx.win(); toast('Signed in', 'win');
        } else {
          const r = await loginLocal(v('auEmail'), v('auPass'));
          if (r.ok === false) { busy(false, 'Log in'); return note(r.error); }
          const acc = (r as { account: { id: string; username: string } }).account;
          toast(`Welcome back, ${acc.username}`, 'win'); enterLocalAccount(acc.id, acc.username, false);
        }
      } catch (err) {
        if (++fails >= 5) { lockUntil = Date.now() + 30_000; fails = 0; }
        busy(false, 'Log in'); note(err instanceof Error ? err.message : String(err));
      }
    };
  };

  const wireRegister = (): void => {
    const meter = $$('.au-meter i', m.el);
    $('#auPass', m.el).oninput = () => {
      const bad = validatePassword(v('auPass'), { username: v('auUser'), email: v('auEmail') });
      const s = bad ? Math.min(1, v('auPass').length) : v('auPass').length >= 18 ? 4 : v('auPass').length >= 14 ? 3 : 2;
      meter.forEach((el: HTMLElement, i: number) => { el.className = i < s ? `s${s}` : ''; });
    };
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      const r = validateRegistration({ username: v('auUser'), email: v('auEmail'), password: v('auPass'), confirm: v('auPass2'), terms: c('auTerms'), adult: c('auAdult') }, true);
      showErrors(m.el, r.errors); if (!r.ok) return;
      busy(true, 'Register');
      try {
        if (cloud) {
          const res = await signUp(v('auEmail').trim(), v('auPass'), { display_name: v('auUser').trim(), terms_version: TERMS_VERSION, adult: true });
          m.close(); toast(res.needsConfirmation ? 'Check your inbox to confirm your email, then log in.' : 'Account created', 'win');
        } else {
          const res = await registerLocal({ email: v('auEmail'), username: v('auUser'), password: v('auPass') });
          if (res.ok === false) { busy(false, 'Register'); const msg = res.error; showErrors(m.el, /email/i.test(msg) ? { email: msg } : { username: msg }); return; }
          const acc = (res as { account: { id: string; username: string } }).account;
          toast(`Welcome, ${acc.username}!`, 'win'); enterLocalAccount(acc.id, acc.username, true);
        }
      } catch (err) { busy(false, 'Register'); note(err instanceof Error ? err.message : String(err)); }
    };
  };
  draw();
}

/** Shown when someone signed in with Google or Steam (or an email link) but has no profile yet: only what the database requires. */
export function openFinishProfile(prefill: { name?: string } = {}): void {
  open?.close();
  const m = modal('', { onClose: () => { open = null; } });
  open = m; m.el.classList.add('auth-modal', 'au-finish');
  m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button><section class="au-main"><h3 class="au-h">Choose a username</h3><p class="au-sub">One last step before you can play.</p>
    <form id="auForm" novalidate>${field('auUser', 'Username', `<input id="auUser" maxlength="20" value="${esc(prefill.name ?? '')}" placeholder="Username">`)}${checks()}<button class="btn btn-primary btn-lg block" id="auGo" type="submit">Start playing</button></form></section>`;
  $('.modal-x', m.el).onclick = m.close;
  const v = (id: string): string => ($('#' + id, m.el) as HTMLInputElement).value, c = (id: string): boolean => ($('#' + id, m.el) as HTMLInputElement).checked;
  ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
    e.preventDefault();
    const r = validateRegistration({ username: v('auUser'), terms: c('auTerms'), adult: c('auAdult') }, false);
    showErrors(m.el, r.errors); if (!r.ok) return;
    try { await completeSignup(v('auUser').trim(), TERMS_VERSION, true); state.name = v('auUser').trim(); confirmAge(state.rg); save(); sfx.win(); toast('Welcome aboard!', 'win'); m.close(); }
    catch (err) { const t = err instanceof Error ? err.message : String(err); showErrors(m.el, /username|name/i.test(t) ? { username: t } : {}); toast(t, 'error'); }
  };
}

/** Start-up wiring: the red Login button at the top right, the Steam return, and (with a backend) session changes. */
export async function initAuth(): Promise<void> {
  const slot = $('#meBtn')?.closest('.me-wrap') as HTMLElement | null;
  const btn = h(`<button class="btn btn-primary" id="authBtn">${icon('user')}<span>Log in</span></button>`) as HTMLElement;
  slot?.after(btn); btn.onclick = () => { sfx.click(); openAuth(); };
  // Signed out visitors can browse, but the balance and account widgets are hidden and any wager or claim opens this popup (see requireLogin in state.ts).
  onLoginRequired(reason => { if (!open) openAuth({ reason }); });
  guardActions();
  const setSignedIn = (on: boolean): void => { signedIn = on; btn.hidden = on; setAuthed(on); document.body.classList.toggle('logged-out', !on); if (on) open?.close(); };
  if (!backendEnabled()) { setSignedIn(activeAccount() !== null); return; }
  setSignedIn(false); // cloud: signed out until the session check below says otherwise

  try { const e = await finishSteamLogin(); if (e) toast(e, 'error'); } catch { /* the toast above covers the usual failures */ }
  setSignedIn(!!(await currentUser().catch(() => null)));
  const ensure = async (): Promise<void> => {
    try {
      if (await hasProfile()) return;
      const u = await currentUser(); const meta = (u as { user_metadata?: Record<string, unknown> } | null)?.user_metadata ?? {};
      if (typeof meta['display_name'] === 'string' && meta['adult'] === true && typeof meta['terms_version'] === 'string') {
        try { await completeSignup(meta['display_name'], meta['terms_version'], true); state.name = meta['display_name']; confirmAge(state.rg); save(); toast('Account ready', 'win'); return; } catch { /* name taken etc: ask */ }
      }
      openFinishProfile({ name: typeof meta['display_name'] === 'string' ? meta['display_name'] : '' });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  await onAuthChange((event, on) => { setSignedIn(on); if (on && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) void ensure(); });
}

// Buttons that spend, claim, sell, create or join. While signed out, a click on one opens the login popup and the page's own handler never runs.
// (Browsing, filters, tabs and links are not in this list. debit() and grant() in state.ts still refuse as a second line of defence.)
const ACTIONS = ['.btn-primary', '.btn-lg', '[data-rb]', '[data-lvl]', '[data-join]', '.cal-day.next', '.cf-make', '.sell', '#sellAll', '#upBtn', '#welcome', '#dailyCase', '#reset', '#createBtn', '.call-bot', '#callAll', '#rematch', '#drop', '#openBtn', '#lobbies [data-id]'].join(',');
const REASONS: [RegExp, string][] = [[/battles/, 'Log in or register to create or join a battle.'], [/rewards/, 'Log in or register to claim rewards.'], [/upgrade/, 'Log in or register to upgrade items.'], [/inventory/, 'Log in or register to manage your inventory.']];
function guardActions(): void {
  const reason = (): string => REASONS.find(([re]) => re.test(location.hash))?.[1] ?? 'Log in or register to place bets.';
  const stop = (e: Event): void => { e.preventDefault(); e.stopImmediatePropagation(); requireLogin(reason()); };
  document.addEventListener('click', e => {
    if (isAuthed()) return;
    const t = e.target as Element | null, b = t?.closest?.('button, a[href^="#/battles/create"]');
    if (b && b.closest('#view') && (b.matches(ACTIONS) || b.tagName === 'A')) stop(e);
  }, true);
  document.addEventListener('submit', e => {
    const f = e.target as Element;
    if (isAuthed() || !f.closest?.('#view, #chat')) return;
    e.preventDefault(); e.stopImmediatePropagation(); requireLogin(f.closest('#chat') ? 'Log in or register to chat.' : reason());
  }, true);
}
