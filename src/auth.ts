// Sign in / register. With a Supabase project connected: email + password (with 2FA), Google, Discord, Twitch and Steam.
// Without one: a local profile (username, date of birth, terms) kept in this browser. Either way age and terms are captured here;
// with a backend the database re-checks them (complete_signup).
import {
  backendEnabled, completeSignup, currentUser, finishSteamLogin, hasProfile, onAuthChange, resetPassword, signInOAuth, signInPassword, signUp, startSteamLogin,
  steamEnabled, verifyLogin2fa, type OAuthProvider,
} from './backend.js';
import { submitDob } from './kyc.js';
import { passwordStrength, validatePassword, validateRegistration, TERMS_VERSION, validateEmail, type Errors } from './signup.js';
import { confirmAge } from './rg.js';
import { state, save } from './state.js';
import { applyUi } from './account.js';
import { $, $$, esc, h, icon, modal, toast } from './ui.js';
import { sfx } from './sfx.js';

type Tab = 'login' | 'register';
const field = (id: string, label: string, input: string, extra = ''): string => `<div class="au-field"><label for="${id}">${label}</label>${input}${extra}<small class="au-err" data-for="${id}" role="alert"></small></div>`;
const checks = (): string => `
  <label class="au-check"><input type="checkbox" id="auAdult"> <span>I am 18 years or older.</span></label><small class="au-err" data-for="auAdult" role="alert"></small>
  <label class="au-check"><input type="checkbox" id="auRegion"> <span>Online gambling content is allowed where I live.</span></label><small class="au-err" data-for="auRegion" role="alert"></small>
  <label class="au-check"><input type="checkbox" id="auTerms"> <span>I accept the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="#/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label><small class="au-err" data-for="auTerms" role="alert"></small>`;
const showErrors = (root: HTMLElement, e: Errors): void => {
  const map: Record<string, string> = { username: 'auUser', email: 'auEmail', password: 'auPass', dob: 'auDob', age: 'auAdult', region: 'auRegion', terms: 'auTerms' };
  $$('.au-err', root).forEach((el: HTMLElement) => { el.textContent = ''; });
  for (const [k, msg] of Object.entries(e)) { const el = root.querySelector(`.au-err[data-for="${map[k] as string}"]`); if (el) el.textContent = msg ?? ''; }
};
const today = (): string => new Date().toISOString().slice(0, 10);

const PROVIDERS: { id: OAuthProvider | 'steam'; label: string; svg: string }[] = [
  { id: 'google', label: 'Google', svg: '<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7z"/><path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9.5 9.5 0 0 0 12 21z"/><path d="M6.7 13.3a5.7 5.7 0 0 1 0-3.6V7.2H3.5a9.5 9.5 0 0 0 0 8.6z"/><path d="M12 6.4c1.4 0 2.7.5 3.7 1.4l2.8-2.8A9.5 9.5 0 0 0 3.5 7.2l3.2 2.5C7.4 8.1 9.5 6.4 12 6.4z"/>' },
  { id: 'discord', label: 'Discord', svg: '<path d="M18.6 6.2A15 15 0 0 0 15 5l-.4.8a11 11 0 0 0-3.2 0L11 5a15 15 0 0 0-3.6 1.2C5.2 9.5 4.6 12.7 4.9 15.9a15 15 0 0 0 4.5 2.3l1-1.6c-.5-.2-1-.5-1.5-.8l.4-.3a10.700 10.700 0 0 0 9.400 0l.4.3c-.5.3-1 .6-1.500.8l1 1.600a15 15 0 0 0 4.500-2.300c.4-3.700-.6-6.900-2.800-9.700zM9.700 13.900c-.9 0-1.600-.8-1.600-1.800s.7-1.800 1.600-1.800 1.600.8 1.600 1.800-.7 1.800-1.600 1.800zm5.600 0c-.9 0-1.600-.8-1.600-1.800s.7-1.800 1.600-1.800 1.600.8 1.600 1.800-.7 1.800-1.600 1.800z"/>' },
  { id: 'twitch', label: 'Twitch', svg: '<path d="M5 3 3.500 7v13H8v2.500h2.500L13 20h3.500L21 15.500V3zm14 11.500-2.500 2.500H12l-2.500 2.500V17H6.500V5H19zM16 8h-1.500v4.500H16zm-4 0h-1.500v4.500H12z"/>' },
  { id: 'steam', label: 'Steam', svg: '<path d="M12 2a10 10 0 0 0-9.900 8.600l5.300 2.200a2.800 2.800 0 0 1 1.600-.5l2.400-3.400v-.1a3.800 3.800 0 1 1 3.800 3.800h-.1l-3.400 2.500a2.800 2.800 0 0 1-5.500.6L2.200 14A10 10 0 1 0 12 2zM7.800 17.400l-1.200-.5a2.100 2.100 0 1 0 1.100-2.900l1.300.5a1.500 1.500 0 1 1-1.200 2.900zm8-5a2.500 2.500 0 1 1 0-5 2.500 2.500 0 0 1 0 5zm0-.9a1.600 1.600 0 1 0 0-3.200 1.600 1.600 0 0 0 0 3.200z"/>' },
];
const providerButtons = (): string => PROVIDERS.filter(p => p.id !== 'steam' || steamEnabled())
  .map(p => `<button type="button" class="au-prov" data-prov="${p.id}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${p.svg}</svg>${p.label}</button>`).join('');

const side = (): string => `<aside class="au-side"><div class="au-brand"><span class="logo-mark">${icon('bolt')}</span><b>VAULT<i>RUSH</i></b></div>
  <h2>Play the vault.</h2><p>A play-money skin-game demo. Coins have no cash value and cannot be bought or withdrawn.</p>
  <ul><li>${icon('fair')} Every result can be re-checked</li><li>${icon('heart')} Limits, breaks and self-exclusion</li><li>${icon('id')} Age and identity checks (sandbox)</li></ul>
  <small>By continuing you confirm you are at least 18 years old and have read the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a>.</small></aside>`;

let open: { close: () => void } | null = null;

export function openAuth(opts: { tab?: Tab; cloud?: boolean } = {}): void {
  open?.close();
  const cloud = opts.cloud ?? backendEnabled();
  let tab: Tab = opts.tab ?? 'login', fails = 0, lockUntil = 0, need2fa = false;
  const m = modal('', { wide: true, onClose: () => { open = null; } });
  open = m;
  m.el.classList.add('auth-modal');
  const draw = (): void => {
    const body = !cloud ? localForm() : tab === 'login' ? loginForm() : registerForm();
    m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button>${side()}<section class="au-main">${cloud ? `<div class="au-tabs" role="tablist"><button role="tab" data-t="login" class="${tab === 'login' ? 'on' : ''}">Log in</button><button role="tab" data-t="register" class="${tab === 'register' ? 'on' : ''}">Register</button></div>` : ''}${body}</section>`;
    $('.modal-x', m.el).onclick = m.close;
    $$('.au-tabs button', m.el).forEach((b: HTMLElement) => b.onclick = () => { tab = b.dataset.t as Tab; need2fa = false; draw(); });
    $$('[data-prov]', m.el).forEach((b: HTMLElement) => b.onclick = async () => {
      try { if (b.dataset.prov === 'steam') startSteamLogin(); else await signInOAuth(b.dataset.prov as OAuthProvider); }
      catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    });
    $$('[data-show]', m.el).forEach((b: HTMLElement) => b.onclick = () => { const i = $('#' + b.dataset.show, m.el) as HTMLInputElement; i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'Show' : 'Hide'; });
    if (!cloud) wireLocal(); else if (tab === 'login') wireLogin(); else wireRegister();
    ($('input:not([type=checkbox])', m.el) as HTMLInputElement | null)?.focus();
  };

  // ---- forms ----
  const pass = (id: string, label: string, auto: string): string => field(id, label, `<div class="au-pass"><input id="${id}" type="password" autocomplete="${auto}" maxlength="72"><button type="button" class="au-show" data-show="${id}">Show</button></div>`);
  const loginForm = (): string => `<form id="auForm" novalidate>${field('auEmail', 'Email', '<input id="auEmail" type="email" autocomplete="email" placeholder="you@example.com">')}
      ${pass('auPass', 'Password', 'current-password')}<button type="button" class="link au-forgot" id="auForgot">Forgot password?</button>
      <div id="au2faBox" ${need2fa ? '' : 'hidden'}>${field('au2fa', 'Authenticator code', '<input id="au2fa" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code">')}</div>
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">${need2fa ? 'Verify code' : 'Log in'}</button></form>
      <div class="au-or"><span>or continue with</span></div><div class="au-provs">${providerButtons()}</div>`;
  const registerForm = (): string => `<form id="auForm" novalidate>${field('auUser', 'Username', '<input id="auUser" autocomplete="username" maxlength="20" placeholder="2 to 20 characters">')}
      ${field('auEmail', 'Email', '<input id="auEmail" type="email" autocomplete="email" placeholder="you@example.com">')}
      ${pass('auPass', 'Password', 'new-password').replace('</small></div>', '</small><div class="au-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div><small class="muted" id="auPassHint">At least 10 characters.</small></div>')}
      ${field('auDob', 'Date of birth', `<input id="auDob" type="date" max="${today()}" autocomplete="bday">`)}${checks()}
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Create account</button></form>
      <div class="au-or"><span>or sign up with</span></div><div class="au-provs">${providerButtons()}</div>`;
  const localForm = (): string => `<h3 class="au-h">Create your player profile</h3><p class="au-sub">Stored in this browser only. Nothing is sent anywhere. To get real accounts that follow you across devices, connect a Supabase project (see supabase/README.md).</p>
      <form id="auForm" novalidate>${field('auUser', 'Username', `<input id="auUser" maxlength="20" value="${state.name === 'You' ? '' : esc(state.name)}" placeholder="2 to 20 characters" autocomplete="nickname">`)}
      ${field('auDob', 'Date of birth', `<input id="auDob" type="date" max="${today()}" value="${esc(state.kyc.dob)}">`)}${checks()}
      <button class="btn btn-primary btn-lg block" id="auGo" type="submit">Play now</button></form>`;

  // ---- behaviour ----
  const busy = (on: boolean, label: string): void => { const b = $('#auGo', m.el) as HTMLButtonElement; b.disabled = on; b.textContent = on ? 'Please wait…' : label; };
  const wireLocal = (): void => {
    const form = $('#auForm', m.el) as HTMLFormElement;
    form.onsubmit = e => {
      e.preventDefault();
      const r = validateRegistration({ username: v('auUser'), dob: v('auDob'), terms: c('auTerms'), adult: c('auAdult'), region: c('auRegion') }, false);
      showErrors(m.el, r.errors); if (!r.ok) return;
      state.name = v('auUser').trim();
      const dob = submitDob(state.kyc, v('auDob')); if (!dob.ok) { showErrors(m.el, { dob: dob.error }); return; }
      state.legal = { termsAt: Date.now(), termsVersion: TERMS_VERSION };
      confirmAge(state.rg); applyUi(); save(); sfx.win(); toast(`Welcome, ${state.name}!`, 'win'); m.close();
      const me = $('.me .avatar'); if (me) me.textContent = state.name[0]?.toUpperCase() ?? '?';
    };
  };
  const v = (id: string): string => (($('#' + id, m.el) as HTMLInputElement | null)?.value ?? '');
  const c = (id: string): boolean => !!($('#' + id, m.el) as HTMLInputElement | null)?.checked;
  const wireLogin = (): void => {
    $('#auForgot', m.el).onclick = async () => {
      const bad = validateEmail(v('auEmail')); if (bad) return showErrors(m.el, { email: 'Enter your email first.' });
      try { await resetPassword(v('auEmail').trim()); toast('If that email has an account, a reset link is on its way.', 'win'); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    };
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      if (Date.now() < lockUntil) return toast(`Too many attempts. Try again in ${Math.ceil((lockUntil - Date.now()) / 1000)} seconds.`, 'error');
      try {
        busy(true, 'Log in');
        if (need2fa) { await verifyLogin2fa(v('au2fa')); m.close(); toast('Signed in', 'win'); return; }
        const r = await signInPassword(v('auEmail').trim(), v('auPass'));
        if (r.needs2fa) { need2fa = true; draw(); toast('Enter the code from your authenticator app'); return; }
        fails = 0; m.close(); toast('Signed in', 'win'); sfx.win();
      } catch (err) {
        if (++fails >= 5) { lockUntil = Date.now() + 30_000; fails = 0; }
        toast(err instanceof Error ? err.message : String(err), 'error'); busy(false, need2fa ? 'Verify code' : 'Log in');
      }
    };
  };
  const wireRegister = (): void => {
    const meter = $$('.au-meter i', m.el), hint = $('#auPassHint', m.el);
    $('#auPass', m.el).oninput = () => {
      const s = passwordStrength(v('auPass')); meter.forEach((el: HTMLElement, i: number) => { el.className = i < s ? `s${s}` : ''; });
      hint.textContent = validatePassword(v('auPass'), { username: v('auUser'), email: v('auEmail') }) ?? ['', 'Weak', 'Okay', 'Good', 'Strong'][s] ?? '';
    };
    ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
      e.preventDefault();
      const r = validateRegistration({ username: v('auUser'), email: v('auEmail'), password: v('auPass'), dob: v('auDob'), terms: c('auTerms'), adult: c('auAdult'), region: c('auRegion') }, true);
      showErrors(m.el, r.errors); if (!r.ok) return;
      try {
        busy(true, 'Create account');
        const res = await signUp(v('auEmail').trim(), v('auPass'), { display_name: v('auUser').trim(), dob: v('auDob'), terms_version: TERMS_VERSION });
        m.close();
        toast(res.needsConfirmation ? 'Check your inbox to confirm your email, then log in.' : 'Account created', 'win');
      } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); busy(false, 'Create account'); }
    };
  };
  draw();
}

/** Shown when someone signed in (Google, Steam, email link) but has no profile yet. Collects exactly what the database requires. */
export function openFinishProfile(prefill: { name?: string; dob?: string } = {}): void {
  open?.close();
  const m = modal('', { onClose: () => { open = null; } });
  open = m; m.el.classList.add('auth-modal', 'au-finish');
  m.el.innerHTML = `<button class="modal-x" aria-label="Close">×</button><section class="au-main"><h3 class="au-h">Finish your profile</h3><p class="au-sub">One last step before you can play.</p>
    <form id="auForm" novalidate>${field('auUser', 'Username', `<input id="auUser" maxlength="20" value="${esc(prefill.name ?? '')}" placeholder="2 to 20 characters">`)}
    ${field('auDob', 'Date of birth', `<input id="auDob" type="date" max="${today()}" value="${esc(prefill.dob ?? '')}">`)}${checks()}<button class="btn btn-primary btn-lg block" id="auGo" type="submit">Start playing</button></form></section>`;
  $('.modal-x', m.el).onclick = m.close;
  const v = (id: string): string => (($('#' + id, m.el) as HTMLInputElement).value);
  const c = (id: string): boolean => ($('#' + id, m.el) as HTMLInputElement).checked;
  ($('#auForm', m.el) as HTMLFormElement).onsubmit = async e => {
    e.preventDefault();
    const r = validateRegistration({ username: v('auUser'), dob: v('auDob'), terms: c('auTerms'), adult: c('auAdult'), region: c('auRegion') }, false);
    showErrors(m.el, r.errors); if (!r.ok) return;
    try { await completeSignup(v('auUser').trim(), v('auDob'), TERMS_VERSION); state.name = v('auUser').trim(); save(); sfx.win(); toast('Welcome aboard!', 'win'); m.close(); }
    catch (err) { const t = err instanceof Error ? err.message : String(err); showErrors(m.el, /username|name/i.test(t) ? { username: t } : /18|birth/i.test(t) ? { dob: t } : {}); toast(t, 'error'); }
  };
};

/** Start-up wiring for the cloud account: Steam return, session changes, the top-bar button and the finish-profile step. */
export async function initAuth(): Promise<void> {
  if (!backendEnabled()) return;
  const slot = $('#freeBtn');
  const btn = h(`<button class="btn btn-primary" id="authBtn">${icon('user')}<span>Sign in</span></button>`) as HTMLElement;
  slot?.before(btn); btn.onclick = () => openAuth();
  const setSignedIn = (on: boolean): void => { btn.hidden = on; };
  try { const e = await finishSteamLogin(); if (e) toast(e, 'error'); } catch { /* handled by the toast above on the next attempt */ }
  setSignedIn(!!(await currentUser().catch(() => null)));
  const ensure = async (): Promise<void> => {
    try {
      if (await hasProfile()) return;
      const u = await currentUser(); const meta = (u as { user_metadata?: Record<string, string> } | null)?.user_metadata ?? {};
      if (meta['display_name'] && meta['dob'] && meta['terms_version']) { try { await completeSignup(meta['display_name'], meta['dob'], meta['terms_version']); state.name = meta['display_name']; save(); toast('Account ready', 'win'); return; } catch { /* name taken etc: ask */ } }
      openFinishProfile({ name: meta['display_name'], dob: meta['dob'] });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  await onAuthChange((event, signedIn) => { setSignedIn(signedIn); if (signedIn && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) void ensure(); });
}
