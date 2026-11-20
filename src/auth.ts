// Log in / Register popup, the finish-profile step, the sign-in state of the page, and the click guard for signed-out visitors.
// With a Supabase project connected these are cloud accounts. Without one, they are local accounts kept in this browser
// (see accounts.ts): a hashed password, a username, and a separate set of progress for each account.
import {
  backendEnabled, completeSignup, currentUser, finishSteamLogin, onAuthChange, profileName, resendSignup, resetPassword, signInOAuth, signInPassword, signOut, signUp,
  startSteamLogin, steamEnabled, verifyLogin2fa,
} from './backend.js';
import { useFairFor } from './fair.js';
import { initLive, stopLive } from './live.js';
import { activeAccount, activeId, loginLocal, registerLocal, setActive, stateKeyFor } from './accounts.js';
import { confirmAge } from './rg.js';
import { emit, isAuthed, newGameState, onLoginRequired, requireLogin, save, setAuthed, state } from './state.js';
import { TERMS_VERSION, passwordStrength, validateEmail, validatePassword, validateRegistration, validateUsername, type Errors } from './signup.js';
import { $, $$, avatar, esc, h, icon, modal, toast } from './ui.js';
import { sfx } from './sfx.js';

type Tab = 'login' | 'register';
/** Storage id of a cloud account. Local accounts use their own ids, so the two never collide. */
const cloudId = (userId: string): string => (userId ? `c-${userId}` : '');
const KNOWN_KEY = 'vaultrush.known';      // set once this browser has had an account, so first-time visitors land on Register
const FLASH_KEY = 'vaultrush.flash';      // a message to show after the page reloads (sessionStorage)

const knownBrowser = (): boolean => { try { return localStorage.getItem(KNOWN_KEY) === '1'; } catch { return false; } };
const markKnown = (): void => { try { localStorage.setItem(KNOWN_KEY, '1'); } catch { /* private mode */ } };

// ---- form building blocks ----
/** A labelled field. The error line is tied to the input with aria-describedby (set in draw), and is only announced through the form's summary. */
const field = (id: string, label: string, input: string, hint = ''): string =>
  `<div class="au-field"><label for="${id}">${label}${hint ? ` <span class="au-hint">${hint}</span>` : ''}</label>${input}<small class="au-err" id="${id}Err" data-for="${id}"></small></div>`;
const pass = (id: string, label: string, auto: string, hint = '', extra = ''): string =>
  field(id, label, `<div class="au-pass"><input id="${id}" type="password" autocomplete="${auto}" maxlength="72"><button type="button" class="au-show" data-show="${id}" aria-label="Show password" aria-controls="${id}" aria-pressed="false">Show</button></div>${extra}`, hint);
const FIELD_ID: Record<string, string> = { username: 'auUser', email: 'auEmail', password: 'auPass', confirm: 'auPass2', age: 'auAdult', terms: 'auTerms' };

/** Writes the per-field messages, marks the inputs invalid, summarises them in one live region, and moves focus to the first problem. */
function showErrors(root: HTMLElement, e: Errors): void {
  $$('.au-err', root).forEach((el: HTMLElement) => { el.textContent = ''; });
  $$('[aria-invalid]', root).forEach((el: HTMLElement) => el.removeAttribute('aria-invalid'));
  let first: HTMLElement | null = null;
  const msgs: string[] = [];
  for (const [k, msg] of Object.entries(e)) {
    if (!msg) continue;
    const id = FIELD_ID[k] as string, el = root.querySelector(`.au-err[data-for="${id}"]`), input = root.querySelector(`#${id}`) as HTMLElement | null;
    if (el) el.textContent = msg;
    if (input && input.getAttribute('type') !== 'hidden') { input.setAttribute('aria-invalid', 'true'); first = first ?? input; }
    msgs.push(msg);
  }
  formError(root, msgs.length ? (msgs.length === 1 ? msgs[0] as string : `Please fix ${msgs.length} things below.`) : '');
  first?.focus();
}
/** The single announced message for the form, placed right above the submit button. */
const formError = (root: HTMLElement, text: string): void => { const el = root.querySelector('#auFormErr'); if (el) el.textContent = text; };

const checks = (): string => `
  <label class="au-check"><input type="checkbox" id="auAdult"> <span>I confirm that <b>I am at least 18 years old</b></span></label><small class="au-err" id="auAdultErr" data-for="auAdult"></small>
  <label class="au-check"><input type="checkbox" id="auTerms"> <span>I have read and agree to the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="#/privacy" target="_blank" rel="noopener">Privacy Policy</a></span></label><small class="au-err" id="auTermsErr" data-for="auTerms"></small>`;

const GOOGLE = '<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7z" fill="#4285f4"/><path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9.5 9.5 0 0 0 12 21z" fill="#34a853"/><path d="M6.7 13.3a5.7 5.7 0 0 1 0-3.6V7.2H3.5a9.5 9.5 0 0 0 0 8.6z" fill="#fbbc05"/><path d="M12 6.4c1.4 0 2.7.5 3.7 1.4l2.8-2.8A9.5 9.5 0 0 0 3.5 7.2l3.2 2.5C7.4 8.1 9.5 6.4 12 6.4z" fill="#ea4335"/>';
const STEAM = '<path d="M12 2a10 10 0 0 0-9.900 8.600l5.300 2.200a2.800 2.800 0 0 1 1.600-.5l2.400-3.400v-.1a3.800 3.800 0 1 1 3.800 3.800h-.1l-3.400 2.500a2.800 2.800 0 0 1-5.500.6L2.200 14A10 10 0 1 0 12 2zM7.800 17.400l-1.200-.5a2.100 2.100 0 1 0 1.100-2.900l1.300.5a1.500 1.500 0 1 1-1.200 2.900zm8-5a2.500 2.500 0 1 1 0-5 2.500 2.500 0 0 1 0 5zm0-.9a1.600 1.600 0 1 0 0-3.200 1.600 1.600 0 0 0 0 3.200z" fill="currentColor"/>';

/** Google and Steam. Without a backend they are shown but switched off, with a plain explanation (no developer instructions). */
const providers = (cloud: boolean): string => {
  const steamOn = cloud && steamEnabled();
  const why = !cloud ? 'Google and Steam sign-in are not available in this demo.' : !steamOn ? 'Steam sign-in is not set up on this site yet.' : '';
  return `<div class="au-or"><span>or</span></div><div class="au-provs">
  <button type="button" class="au-prov" data-prov="google" ${cloud ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true">${GOOGLE}</svg>Google</button>
  <button type="button" class="au-prov" data-prov="steam" ${steamOn ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true">${STEAM}</svg>Steam</button></div>
  <div class="au-note" id="auNote" role="status">${why}</div>`;
};

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

/** Makes an account the active one and reloads so its own state is loaded. A new account starts fresh. The welcome message is shown after the reload. */
function enterLocalAccount(id: string, username: string, fresh: boolean): void {
  if (fresh) {
    const base = newGameState();
    base.name = username; base.legal = { termsAt: Date.now(), termsVersion: TERMS_VERSION };
    base.rg = { ...newGameState().rg, ...base.rg }; if (!base.rg.ageConfirmedAt) base.rg.ageConfirmedAt = Date.now();
    localStorage.setItem(stateKeyFor(id), JSON.stringify(base));
  }
  markKnown();
  try { sessionStorage.setItem(FLASH_KEY, fresh ? `Welcome, ${username}!` : `Welcome back, ${username}`); } catch { /* shown nowhere, harmless */ }
  setActive(id); location.hash = '#/'; location.reload();
}

export function openAuth(opts: { tab?: Tab; reason?: string } = {}): void {
  open?.close();
  const cloud = backendEnabled();
  // First-time visitors (and anyone sent here by a bet or claim) are most likely new, so Register comes first for them.
  let tab: Tab = opts.tab ?? (opts.reason && !knownBrowser() ? 'register' : 'login'), lockUntil = 0, fails = 0, need2fa = false, sent = '';
  const m = modal('', { wide: true, label: 'Log in or register', backdropClose: false, onClose: () => { open = null; } });
  open = m; m.el.classList.add('auth-modal');
  const draft = { email: '', user: '' };           // typed text that survives switching tabs (passwords are never carried over)
  const v = (id: string): string => (($('#' + id, m.el) as HTMLInputElement | null)?.value ?? '');
  const c = (id: string): boolean => !!($('#' + id, m.el) as HTMLInputElement | null)?.checked;
  const note = (t: string): void => { const n = $('#auNote', m.el); if (n) n.textContent = t; };
  const fail = (t: string): void => formError(m.el, t);
  const busy = (on: boolean, label: string): void => { const b = $('#auGo', m.el) as HTMLButtonElement | null; if (b) { b.disabled = on; b.textContent = on ? 'Please wait…' : label; } };

  const twoFa = (): string => field('au2fa', 'Authenticator code', '<input id="au2fa" inputmode="numeric" autocomplete="one-time-code" maxlength="6">', '(6 digits)');
  const loginForm = (): string => `<form id="auForm" class="au-form" novalidate>
      ${field('auEmail', cloud ? 'Email' : 'Email or username', `<input id="auEmail" ${cloud ? 'type="email"' : ''} autocomplete="username" placeholder="${cloud ? 'name@example.com' : 'name@example.com or username'}">`)}
      ${pass('auPass', 'Password', 'current-password')}<button type="button" class="link au-forgot" id="auForgot">Forgot password?</button>
      ${need2fa ? twoFa() : ''}
      <div class="au-formerr" id="auFormErr" role="alert"></div>
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Log in</button></form>${providers(cloud)}`;
  const registerForm = (): string => `<form id="auForm" class="au-form" novalidate>
      ${field('auEmail', 'Email', '<input id="auEmail" type="email" autocomplete="email" placeholder="name@example.com">')}
      ${field('auUser', 'Username', '<input id="auUser" autocomplete="nickname" maxlength="20" placeholder="For example RushPilot">', '(2 to 20 letters or numbers)')}
      ${pass('auPass', 'Password', 'new-password', '(at least 10 characters)', '<div class="au-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="au-meter-t" id="auMeterT" aria-live="polite"></div>')}
      ${pass('auPass2', 'Confirm password', 'new-password')}${checks()}
      <div class="au-formerr" id="auFormErr" role="alert"></div>
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Register</button></form>${providers(cloud)}
      ${cloud ? '' : '<p class="au-local">No server is connected, so accounts are stored in this browser only.</p>'}`;
  const sentPanel = (): string => `<div class="au-sent" role="status"><h3 class="au-h">Check your inbox</h3>
      <p class="au-sub">We sent a confirmation link to <b>${esc(sent)}</b>. Open it, then come back and log in. It can take a minute, and it may land in spam.</p>
      <div class="row"><button class="btn btn-ghost" id="auResend" type="button">Send it again</button><button class="btn btn-primary" id="auBack" type="button">Back to log in</button></div><div class="au-note" id="auNote" role="status"></div></div>`;

  const tabBtn = (t: Tab, label: string): string => `<button role="tab" id="auTab-${t}" data-t="${t}" aria-selected="${tab === t}" aria-controls="auPanel" tabindex="${tab === t ? 0 : -1}" class="${tab === t ? 'on' : ''}">${label}</button>`;
  const draw = (focus: 'field' | 'tab' | 'none' = 'field'): void => {
    m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button>${side()}<section class="au-main"><p class="au-playmoney">Play money only. Coins have no cash value.</p>${opts.reason ? `<div class="au-reason" role="status">${esc(opts.reason)}</div>` : ''}
      ${sent ? '' : `<div class="au-tabs" role="tablist" aria-label="Log in or register">${tabBtn('login', 'Log in')}${tabBtn('register', 'Register')}</div>`}
      <div class="au-panel ${tab === 'register' ? 'reg' : ''}" id="auPanel" role="${sent ? 'group' : 'tabpanel'}" ${sent ? '' : `aria-labelledby="auTab-${tab}"`}>${sent ? sentPanel() : tab === 'login' ? loginForm() : registerForm()}</div></section>`;
    $('.modal-x', m.el).onclick = m.close;
    // each error line is linked to its input
    $$('.au-err[data-for]', m.el).forEach((e: HTMLElement) => { const i = $('#' + e.dataset.for, m.el); if (i) i.setAttribute('aria-describedby', e.id); });
    const emailBox = $('#auEmail', m.el) as HTMLInputElement | null, userBox = $('#auUser', m.el) as HTMLInputElement | null;
    if (emailBox) { emailBox.value = draft.email; emailBox.addEventListener('input', () => { draft.email = emailBox.value; }); }
    if (userBox) { userBox.value = draft.user; userBox.addEventListener('input', () => { draft.user = userBox.value; }); }
    $$('.au-tabs [role=tab]', m.el).forEach((b: HTMLElement) => {
      b.onclick = () => { if (b.dataset.t !== tab) { tab = b.dataset.t as Tab; need2fa = false; draw('tab'); } };
      b.onkeydown = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') { e.preventDefault(); tab = tab === 'login' ? 'register' : 'login'; need2fa = false; draw('tab'); } };
    });
    $$('[data-show]', m.el).forEach((b: HTMLElement) => b.onclick = () => {
      const i = $('#' + b.dataset.show, m.el) as HTMLInputElement, show = i.type === 'password';
      i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    $$('[data-prov]', m.el).forEach((b: HTMLElement) => b.onclick = () => provider(b.dataset.prov as 'google' | 'steam'));
    if (sent) wireSent(); else if (tab === 'login') wireLogin(); else wireRegister();
    if (focus === 'tab') ($(`#auTab-${tab}`, m.el) as HTMLElement | null)?.focus();
    else if (focus === 'field') ((need2fa ? $('#au2fa', m.el) : $('#auEmail', m.el)) as HTMLInputElement | null)?.focus();
  };

  const provider = async (p: 'google' | 'steam'): Promise<void> => {
    if (!cloud) return;
    try {
      if (p === 'google') await signInOAuth('google');
      else if (steamEnabled()) startSteamLogin();
    } catch (e) { note(e instanceof Error ? e.message : String(e)); }
  };

  const wireSent = (): void => {
    $('#auBack', m.el).onclick = () => { sent = ''; tab = 'login'; draw(); };
    $('#auResend', m.el).onclick = async () => {
      try { await resendSignup(sent); note('Sent again. Check your inbox.'); } catch (e) { note(e instanceof Error ? e.message : String(e)); }
    };
  };

  const wireLogin = (): void => {
    $('#auForgot', m.el).onclick = async () => {
      if (!cloud) return fail('Browser accounts have no email recovery. Register a new account, or restore a backup under Account > Security.');
      if (validateEmail(v('auEmail'))) return showErrors(m.el, { email: 'Enter your email first.' });
      try { await resetPassword(v('auEmail').trim()); note('If that email has an account, a reset link is on its way.'); } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
    };
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      showErrors(m.el, {});
      if (need2fa && !v('au2fa').trim()) return showErrors(m.el, {}), fail('Enter the code from your authenticator app.');
      if (!need2fa && (!v('auEmail').trim() || !v('auPass'))) { fail('Enter your email or username and your password.'); ($(!v('auEmail').trim() ? '#auEmail' : '#auPass', m.el) as HTMLElement).focus(); return; }
      if (Date.now() < lockUntil) return fail(`Too many attempts. Try again in ${Math.ceil((lockUntil - Date.now()) / 1000)} seconds.`);
      busy(true, 'Log in');
      try {
        if (cloud) {
          if (!need2fa) {
            const r = await signInPassword(v('auEmail').trim(), v('auPass'));
            if (r.needs2fa) {
              need2fa = true; busy(false, 'Log in');
              ($('#auGo', m.el) as HTMLElement).insertAdjacentHTML('beforebegin', twoFa());
              const box = $('#au2fa', m.el) as HTMLInputElement, err = $('#au2faErr', m.el); box.setAttribute('aria-describedby', err.id); box.focus();
              return fail('Your account uses two-factor authentication. Enter the code from your authenticator app.');
            }
          } else await verifyLogin2fa(v('au2fa'));
          fails = 0; markKnown(); m.close(); sfx.win(); toast('Signed in', 'win', true);
        } else {
          const r = await loginLocal(v('auEmail'), v('auPass'));
          if (r.ok === false) { busy(false, 'Log in'); fail(r.error); ($('#auPass', m.el) as HTMLElement).focus(); return; }
          const acc = (r as { account: { id: string; username: string } }).account;
          enterLocalAccount(acc.id, acc.username, false);
        }
      } catch (err) {
        if (++fails >= 5) { lockUntil = Date.now() + 30_000; fails = 0; }
        busy(false, 'Log in'); fail(err instanceof Error ? err.message : String(err));
      }
    };
  };

  const wireRegister = (): void => {
    const meter = $$('.au-meter i', m.el), label = $('#auMeterT', m.el), words = ['', 'Too weak', 'OK', 'Good', 'Strong'];
    const check = (): void => {
      const pw = v('auPass'), bad = pw.length >= 10 ? validatePassword(pw, { username: v('auUser'), email: v('auEmail') }) : null;
      const s = pw.length === 0 ? 0 : bad ? 1 : pw.length < 10 ? 1 : passwordStrength(pw);
      meter.forEach((el: HTMLElement, i: number) => { el.className = i < s ? `s${s}` : ''; });
      label.textContent = pw.length === 0 ? '' : pw.length < 10 ? `Too short: ${10 - pw.length} more character${10 - pw.length === 1 ? '' : 's'}` : `Strength: ${words[s]}`;
      const err = $('#auPassErr', m.el); if (err) err.textContent = bad ?? '';
    };
    for (const id of ['auPass', 'auUser', 'auEmail']) $('#' + id, m.el).addEventListener('input', check);
    check();
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      const r = validateRegistration({ username: v('auUser'), email: v('auEmail'), password: v('auPass'), confirm: v('auPass2'), terms: c('auTerms'), adult: c('auAdult') }, true);
      showErrors(m.el, r.errors); if (!r.ok) return;
      busy(true, 'Register');
      try {
        if (cloud) {
          const email = v('auEmail').trim();
          const res = await signUp(email, v('auPass'), { display_name: v('auUser').trim(), terms_version: TERMS_VERSION, adult: true });
          markKnown();
          if (res.needsConfirmation) { sent = email; draw('none'); ($('#auPanel h3', m.el) as HTMLElement | null)?.setAttribute('tabindex', '-1'); ($('#auPanel h3', m.el) as HTMLElement | null)?.focus(); }
          else { m.close(); toast('Account created', 'win', true); }
        } else {
          const res = await registerLocal({ email: v('auEmail'), username: v('auUser'), password: v('auPass') });
          if (res.ok === false) { busy(false, 'Register'); const msg = res.error; showErrors(m.el, /email/i.test(msg) ? { email: msg } : { username: msg }); return; }
          const acc = (res as { account: { id: string; username: string } }).account;
          enterLocalAccount(acc.id, acc.username, true);
        }
      } catch (err) { busy(false, 'Register'); fail(err instanceof Error ? err.message : String(err)); }
    };
  };
  draw();
}

/** Shown when someone signed in with Google or Steam (or an email link) but has no profile yet: only what the database requires. It cannot be dismissed; "Not now" signs out. */
export function openFinishProfile(prefill: { name?: string; steam?: boolean } = {}): void {
  open?.close();
  const m = modal('', { locked: true, label: 'Finish your profile', onClose: () => { open = null; } });
  open = m; m.el.classList.add('auth-modal', 'au-finish');
  m.el.innerHTML = `<section class="au-main"><h3 class="au-h">${prefill.steam ? 'Almost there' : 'Choose a username'}</h3><p class="au-sub">${prefill.steam ? `Signed in with Steam as <b>${esc(prefill.name ?? '')}</b>. Confirm the two boxes to start playing.` : 'One last step before you can play.'}</p>
    <form id="auForm" class="au-form" novalidate>${prefill.steam ? `<input id="auUser" type="hidden" value="${esc(prefill.name ?? '')}"><small class="au-err" id="auUserErr" data-for="auUser"></small>` : field('auUser', 'Username', `<input id="auUser" maxlength="20" value="${esc(prefill.name ?? '')}" placeholder="For example RushPilot">`, '(2 to 20 letters or numbers)')}${checks()}
    <div class="au-formerr" id="auFormErr" role="alert"></div>
    <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Start playing</button></form>
    <p class="au-out"><button type="button" class="link" id="auOut">Not now, sign out</button></p></section>`;
  $$('.au-err[data-for]', m.el).forEach((e: HTMLElement) => { const i = $('#' + e.dataset.for, m.el); if (i && i.getAttribute('type') !== 'hidden') i.setAttribute('aria-describedby', e.id); });
  $('#auOut', m.el).onclick = () => { void logout(); };
  ((m.el.querySelector('#auUser:not([type=hidden])') ?? m.el.querySelector('#auAdult')) as HTMLElement | null)?.focus();
  const v = (id: string): string => ($('#' + id, m.el) as HTMLInputElement).value, c = (id: string): boolean => ($('#' + id, m.el) as HTMLInputElement).checked;
  ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
    e.preventDefault();
    const base = v('auUser').trim();
    const r = validateRegistration({ username: base, terms: c('auTerms'), adult: c('auAdult') }, false);
    // A Steam name that the site rejects (taken or reserved) gets a short number added instead of asking the player to type one.
    const nameErrOnly = !!prefill.steam && Object.keys(r.errors).every(k => k === 'username');
    showErrors(m.el, prefill.steam ? { ...r.errors, username: undefined } : r.errors); if (!r.ok && !nameErrOnly) return;
    const candidates = prefill.steam ? [base, ...[1, 2, 3, 4].map(() => `${base.slice(0, 15).trim()}_${Math.floor(100 + Math.random() * 900)}`)] : [base];
    const nameProblem = /username|name|taken|exists|reserved/i;
    let lastErr = '';
    for (const name of candidates) {
      if (validateUsername(name)) continue;
      try { await completeSignup(name, TERMS_VERSION, true); state.name = name; confirmAge(state.rg); save(); markKnown(); sfx.win(); toast(`Welcome, ${name}!`, 'win', true); m.close(); return; }
      catch (err) { lastErr = err instanceof Error ? err.message : String(err); if (!nameProblem.test(lastErr)) break; }
    }
    if (prefill.steam && nameProblem.test(lastErr)) { toast('Could not use your Steam name. Please pick a username.', 'error'); openFinishProfile({ name: base }); return; }
    showErrors(m.el, /username|name/i.test(lastErr) ? { username: lastErr } : {}); if (!/username|name/i.test(lastErr)) formError(m.el, lastErr || 'Could not finish sign-up'); toast(lastErr || 'Could not finish sign-up', 'error');
  };
}

/** Start-up wiring: the top-right Log in button, the Steam return, and (with a backend) session changes. */
export async function initAuth(): Promise<void> {
  const slot = $('#meBtn')?.closest('.me-wrap') as HTMLElement | null;
  const btn = h(`<button class="btn btn-primary" id="authBtn" aria-label="Log in or register">${icon('user')}<span>Log in<span class="au-more"> / Sign up</span></span></button>`) as HTMLElement;
  slot?.after(btn); btn.onclick = () => { sfx.click(); openAuth(); };
  try { const msg = sessionStorage.getItem(FLASH_KEY); if (msg) { sessionStorage.removeItem(FLASH_KEY); toast(msg, 'win', true); } } catch { /* storage blocked */ }
  // Signed-out visitors can browse, but the balance and account widgets are hidden and any wager or claim opens this popup (see requireLogin in state.ts).
  onLoginRequired(reason => { if (!open) openAuth({ reason }); });
  guardActions();
  let who = '';                                          // the cloud user whose state is loaded; every account keeps its own coins, items and seeds
  const setSignedIn = (on: boolean, userId: string = ''): void => {
    const changed = on !== signedIn || (on && userId !== who);
    signedIn = on; who = on ? userId : ''; btn.hidden = on; setAuthed(on, backendEnabled() ? cloudId(userId) : activeId()); document.body.classList.toggle('logged-out', !on);
    if (on) open?.close();
    if (changed) emit('auth', on);                        // pages that look different when signed in redraw themselves
  };
  if (!backendEnabled()) { setSignedIn(activeAccount() !== null); return; }
  // Cloud: nobody is signed in until the session check says so. The button stays hidden until then so it does not flash for returning players.
  setSignedIn(false); btn.hidden = true;

  try { const e = await finishSteamLogin(); if (e) toast(e, 'error'); } catch { /* the toast above covers the usual failures */ }
  const first = await currentUser().catch(() => null);
  if (first) await useFairFor(cloudId(first.id));
  setSignedIn(!!first, first?.id ?? '');
  if (first) void initLive(first.id);
  const ensure = async (): Promise<void> => {
    try {
      // A cloud profile cannot exist without the adult flag (the database refuses it), so a returning player on a new browser is already confirmed.
      const known = await profileName();
      if (known !== null) {                                   // returning player: the account's own name, and 18+ was confirmed at sign-up
        confirmAge(state.rg); const renamed = !!known && known !== state.name; if (known) state.name = known; save();
        const me = $('.me .avatar'); if (me) me.outerHTML = avatar(state.name, 32);
        if (renamed) emit('auth', true);                       // pages drawn a moment ago still say "You"
        return;
      }
      const u = await currentUser(); const meta = (u as { user_metadata?: Record<string, unknown> } | null)?.user_metadata ?? {};
      if (typeof meta['display_name'] === 'string' && meta['adult'] === true && typeof meta['terms_version'] === 'string') {
        try { await completeSignup(meta['display_name'], meta['terms_version'], true); state.name = meta['display_name']; confirmAge(state.rg); save(); toast('Account ready', 'win', true); return; } catch { /* name taken etc: ask */ }
      }
      openFinishProfile(typeof meta['steam_name'] === 'string' && meta['steam_name'] ? { name: meta['steam_name'], steam: true } : { name: typeof meta['display_name'] === 'string' ? meta['display_name'] : '' });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  // Profile picture from the login provider: Steam stores steam_avatar, Google stores avatar_url / picture.
  const applyPicture = async (): Promise<void> => {
    const u = await currentUser().catch(() => null); const meta = (u as { user_metadata?: Record<string, unknown> } | null)?.user_metadata ?? {};
    const pic = [meta['steam_avatar'], meta['avatar_url'], meta['picture']].find(x => typeof x === 'string' && /^https:\/\//.test(x)) as string | undefined;
    if (!pic || state.avatar === pic) return;
    state.avatar = pic; save();
    const me = $('.me .avatar'); if (me) me.outerHTML = avatar(state.name, 32);
  };
  await onAuthChange(async (event, on, uid) => { if (on) await useFairFor(cloudId(uid)); setSignedIn(on, uid); if (on) { markKnown(); void initLive(uid); } else stopLive(); if (on && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) void ensure().then(applyPicture); });
}

// ---- click guard for signed-out visitors ----
// Only buttons that opt in with data-needs-auth="<kind>" are blocked: the ones that wager, claim, sell, create or join. Browsing, filters,
// tabs, links and the public tools (Verify, RTP check, RNG lab) are never touched. debit() and grant() in state.ts still refuse as a second line.
export type NeedsAuth = 'bet' | 'battle' | 'claim' | 'upgrade' | 'inventory' | 'chat' | 'rain' | 'seeds';
const REASONS: Record<NeedsAuth, string> = {
  bet: 'Log in or create a free account to place bets.',
  battle: 'Log in or create a free account to create or join a battle.',
  claim: 'Log in or create a free account to claim rewards.',
  upgrade: 'Log in or create a free account to upgrade items.',
  inventory: 'Log in or create a free account to manage your inventory.',
  chat: 'Log in or create a free account to chat.',
  rain: 'Log in or create a free account to join the coin rain.',
  seeds: 'Log in or create a free account to get your own seeds.',
};
export const reasonFor = (kind: NeedsAuth): string => REASONS[kind];

function guardActions(): void {
  const stop = (e: Event, kind: string | undefined): void => { e.preventDefault(); e.stopImmediatePropagation(); requireLogin(REASONS[(kind ?? 'bet') as NeedsAuth] ?? REASONS.bet); };
  document.addEventListener('click', e => {
    const t = e.target as Element | null;
    const opener = t?.closest?.('[data-auth-open]') as HTMLElement | null;       // "Create free account" and "Log in" buttons on guest cards
    if (opener) { e.preventDefault(); openAuth({ tab: opener.dataset.authOpen as Tab }); return; }
    if (isAuthed()) return;
    const b = t?.closest?.('[data-needs-auth]') as HTMLElement | null;
    if (b) stop(e, b.dataset.needsAuth);
  }, true);
  document.addEventListener('submit', e => {
    const f = e.target as Element;
    if (isAuthed() || !f.closest?.('#view, #chat')) return;
    const kind = (f.closest('[data-needs-auth]') as HTMLElement | null)?.dataset.needsAuth ?? (f.closest('#chat') ? 'chat' : 'claim');
    stop(e, kind);
  }, true);
}
