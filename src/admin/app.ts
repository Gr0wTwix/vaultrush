// The admin site: a three-step sign-in (Steam, then an authenticator code, then the admin password) and, once unlocked, the panel.
// The page never decides who is allowed in: it asks the database (admin_status) and shows the step that is missing. Every action is
// checked again by the database on each call.
import type { AdminApi, Status } from './api.js';
import { errorText } from './api.js';
import { $, $$, esc, mmss, toast } from './dom.js';
import { PAGES, ROADMAP, type PageCtx } from './pages.js';

const IDLE_TOUCH_MS = 60_000, ACTIVE_WINDOW_MS = 5 * 60_000;

export interface AdminApp { stop(): void; refresh(): Promise<void> }

export async function boot(root: HTMLElement, api: AdminApi): Promise<AdminApp> {
  let shown = '';                                                // the page currently drawn, so one navigation draws once
  let status: Status | null = null, perms: string[] = [], expiresAt = 0, lastActive = Date.now(), alive = true, busy = false, tickTimer = 0, touchTimer = 0, rendering = 0;
  const bump = (): void => { lastActive = Date.now(); };
  document.addEventListener('click', bump); document.addEventListener('keydown', bump);

  const card = (title: string, body: string, extra = ''): void => {
    root.innerHTML = `<div class="gate"><div class="gate-card"><div class="brand">VAULT<b>RUSH</b> <span class="tag">ADMIN</span></div><h1>${esc(title)}</h1>${body}${extra}</div></div><div id="toasts" role="status" aria-live="polite"></div>`;
  };
  const steps = (n: number): string => `<ol class="steps" aria-label="Sign-in steps">${['Steam', 'Authenticator', 'Admin password'].map((s, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'now' : ''}">${i + 1}. ${s}</li>`).join('')}</ol>`;
  const signOutBtn = '<p class="center"><button class="link" id="signout">Sign out</button></p>';
  const wireSignOut = (): void => { const b = $('#signout', root); if (b) b.onclick = async () => { await api.signOut(); location.hash = ''; await refresh(); }; };

  // ---------------------------------------------------------------- the sign-in steps
  const stepSteam = (msg = ''): void => {
    card('Staff sign-in', `${steps(1)}<p class="muted">Sign in with the same Steam account you use on Vaultrush. Only staff can go further.</p>${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}
      ${api.steamAvailable() ? '<button class="btn primary block" id="steam">Sign in with Steam</button>' : '<p class="err">Steam sign-in is not switched on for this site (VITE_STEAM_LOGIN).</p>'}`);
    const b = $('#steam', root); if (b) b.onclick = () => api.startSteam();
  };
  const stepDenied = (): void => {
    card('No access', `<p>This account is not staff, so there is nothing here for it.</p>${signOutBtn}`); wireSignOut();
  };
  const stepMfa = async (): Promise<void> => {
    card('Authenticator code', `${steps(2)}<p class="muted">Loading…</p>`);
    let factors: { id: string; status: string }[] = [];
    try { factors = await api.factors(); } catch (e) { return card('Authenticator code', `${steps(2)}<p class="err" role="alert">${esc(errorText(e))}</p>${signOutBtn}`), wireSignOut(); }
    const verified = factors.find(f => f.status === 'verified');
    if (verified) {
      card('Authenticator code', `${steps(2)}<p class="muted">Enter the 6-digit code from your authenticator app.</p>
        <form id="f"><label for="code">Code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><p class="err" id="err" role="alert"></p><button class="btn primary block">Continue</button></form>${signOutBtn}`);
      wireSignOut(); $('#code', root).focus();
      $<HTMLFormElement>('#f', root).onsubmit = async e => {
        e.preventDefault(); if (busy) return; busy = true;
        try { await api.verify(verified.id, ($<HTMLInputElement>('#code', root)).value); await refresh(); }
        catch (er) { $('#err', root).textContent = errorText(er) || 'That code was not accepted.'; } finally { busy = false; }
      };
      return;
    }
    for (const f of factors) await api.removeFactor(f.id).catch(() => {});             // a half-finished setup from before
    let enr: { id: string; qr: string; secret: string };
    try { enr = await api.enroll(); } catch (e) { return card('Authenticator setup', `${steps(2)}<p class="err" role="alert">${esc(errorText(e))}</p>${signOutBtn}`), wireSignOut(); }
    card('Set up your authenticator', `${steps(2)}<p class="muted">Scan this with an authenticator app (Google Authenticator, Aegis, 1Password...). Then enter the 6-digit code it shows.</p>
      <div class="qr"><img alt="QR code for the authenticator app" src="${esc(enr.qr)}"></div><p class="muted small">Cannot scan? Enter this key by hand: <code>${esc(enr.secret)}</code></p>
      <form id="f"><label for="code">Code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><p class="err" id="err" role="alert"></p><button class="btn primary block">Turn on and continue</button></form>${signOutBtn}`);
    wireSignOut(); $('#code', root).focus();
    $<HTMLFormElement>('#f', root).onsubmit = async e => {
      e.preventDefault(); if (busy) return; busy = true;
      try { await api.verify(enr.id, ($<HTMLInputElement>('#code', root)).value); await refresh(); }
      catch (er) { $('#err', root).textContent = errorText(er) || 'That code was not accepted.'; } finally { busy = false; }
    };
  };
  const stepSetPassword = (): void => {
    card('Create your admin password', `${steps(3)}<p class="muted">A separate password just for this site, never used anywhere else. At least 14 characters, with at least 3 of: lower case, upper case, numbers, symbols. No obvious words and not your name. Write it down somewhere safe: it cannot be recovered, only reset by SQL.</p>
      <form id="f"><label for="pw1">New admin password</label><input id="pw1" type="password" autocomplete="new-password" required minlength="14">
      <label for="pw2">Repeat it</label><input id="pw2" type="password" autocomplete="new-password" required minlength="14"><p class="err" id="err" role="alert"></p><button class="btn primary block">Save and unlock</button></form>${signOutBtn}`);
    wireSignOut(); $('#pw1', root).focus();
    $<HTMLFormElement>('#f', root).onsubmit = async e => {
      e.preventDefault(); if (busy) return;
      const a = ($<HTMLInputElement>('#pw1', root)).value, b = ($<HTMLInputElement>('#pw2', root)).value;
      if (a !== b) { $('#err', root).textContent = 'The two passwords are different.'; return; }
      busy = true;
      try {
        const r = await api.setPassword(a);
        if (!r.ok) { $('#err', root).textContent = r.reason === 'locked' ? 'Too many wrong attempts. Try again later.' : 'That did not work.'; return; }
        const u = await api.unlock(a);
        if (!u.ok) { $('#err', root).textContent = 'Saved, but unlocking failed. Reload and enter the password.'; return; }
        await refresh();
      } catch (er) { $('#err', root).textContent = errorText(er); } finally { busy = false; }
    };
  };
  const stepUnlock = (msg = ''): void => {
    const lockedUntil = status?.locked_until ? new Date(status.locked_until) : null;
    card('Admin password', `${steps(3)}<p class="muted">Enter your admin password to unlock the panel for this session.</p>
      ${lockedUntil && lockedUntil.getTime() > Date.now() ? `<p class="err" role="alert">Too many wrong attempts. Try again at ${esc(lockedUntil.toLocaleTimeString())}.</p>` : ''}
      <form id="f"><label for="pw">Admin password</label><input id="pw" type="password" autocomplete="current-password" required><p class="err" id="err" role="alert">${esc(msg)}</p><button class="btn primary block">Unlock</button></form>${signOutBtn}`);
    wireSignOut(); $('#pw', root).focus();
    $<HTMLFormElement>('#f', root).onsubmit = async e => {
      e.preventDefault(); if (busy) return; busy = true;
      try {
        const r = await api.unlock(($<HTMLInputElement>('#pw', root)).value);
        if (r.ok) { await refresh(); return; }
        if (r.reason === 'locked') { await refresh(); return; }
        $('#err', root).textContent = r.reason === 'no_password' ? 'No admin password is set yet.' : `Wrong password. ${r.remaining ?? 0} attempt${r.remaining === 1 ? '' : 's'} left before a 15-minute lockout.`;
        ($<HTMLInputElement>('#pw', root)).value = '';
      } catch (er) { $('#err', root).textContent = errorText(er); } finally { busy = false; }
    };
  };

  // ---------------------------------------------------------------- the panel
  const ctx = (): PageCtx => ({ api, status: status as Status, perms, toast, reload: () => void renderPage(), lock });
  const lock = async (): Promise<void> => { try { await api.lock(); } catch { /* already locked */ } await refresh(); };
  const currentPage = (): string => { const h = location.hash.replace(/^#\/?/, ''); return PAGES[h] ? h : 'overview'; };
  const renderPanel = (): void => {
    const here = currentPage(); shown = here;
    const visible = Object.entries(PAGES).filter(([, p]) => !p.perm || perms.includes(p.perm));
    root.innerHTML = `<div class="shell"><aside class="side" aria-label="Admin sections"><div class="brand">VAULT<b>RUSH</b> <span class="tag">ADMIN</span></div>
        <nav>${visible.map(([k, p]) => `<a href="#/${k}" class="${k === here ? 'on' : ''}" ${k === here ? 'aria-current="page"' : ''}>${esc(p.title)}</a>`).join('')}</nav>
        <div class="side-foot"><span class="tag role" id="roleTag">${esc(status?.label ?? '')}</span><span class="muted small">Session <b id="timer">--:--</b></span>
          <button class="btn ghost block" id="lockBtn">Lock now</button><button class="btn ghost block" id="outBtn">Sign out</button></div></aside>
      <main class="main" id="page" tabindex="-1"></main></div><div id="toasts" role="status" aria-live="polite"></div>`;
    $('#lockBtn', root).onclick = () => void lock();
    $('#outBtn', root).onclick = async () => { await lock(); await api.signOut(); await refresh(); };
    void renderPage(); tick();
  };
  const renderPage = async (): Promise<void> => {
    const my = ++rendering, page = PAGES[currentPage()] as (typeof PAGES)[string];
    const main = $('#page', root); if (!main) return;
    main.innerHTML = `<h1>${esc(page.title)}</h1><div id="pageBody"><p class="muted">Loading…</p></div>`;
    try { await page.render($('#pageBody', root), ctx()); }
    catch (e) {
      if (my !== rendering) return;
      const m = e instanceof Error ? e.message : String(e);
      if (/admin_session_required|admin_mfa_required/.test(m)) { await refresh(); return; }
      $('#pageBody', root).innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`;
    }
  };
  const onHash = (): void => { if (status?.unlocked && currentPage() !== shown) renderPanel(); };
  window.addEventListener('hashchange', onHash);

  const tick = (): void => {
    if (!alive || !status?.unlocked) return;
    const left = expiresAt - Date.now();
    const t = $('#timer', root); if (t) t.textContent = mmss(left);
    if (left <= 0) void refresh();
  };
  const heartbeat = async (): Promise<void> => {
    if (!alive || !status?.unlocked || Date.now() - lastActive > ACTIVE_WINDOW_MS) return;     // idle: let the session run out
    try { expiresAt = Date.parse(await api.touch()); } catch { void refresh(); }
  };

  // ---------------------------------------------------------------- deciding which screen to show
  async function refresh(): Promise<void> {
    if (!alive) return;
    const wasPanel = !!status?.unlocked;
    try {
      const me = await api.user();
      if (!me) { status = null; return stepSteam(); }
      status = await api.status();
    } catch (e) { return card('Could not reach the server', `<p class="err" role="alert">${esc(errorText(e))}</p><p><button class="btn primary" id="retry">Try again</button></p>${signOutBtn}`), ($('#retry', root).onclick = () => void refresh()), wireSignOut(); }
    if (!status.is_admin) return stepDenied();
    if (!status.mfa) return void (await stepMfa());
    if (!status.password_set) return stepSetPassword();
    if (!status.unlocked) return stepUnlock();
    try { perms = await api.myPermissions(); } catch (e) { return card('Could not load your permissions', `<p class="err" role="alert">${esc(errorText(e))}</p>${signOutBtn}`), wireSignOut(); }
    expiresAt = status.expires_at ? Date.parse(status.expires_at) : Date.now() + 30 * 60_000;
    if (!wasPanel || !$('#page', root)) renderPanel();
    $$('.tag.role', root).forEach(el => { el.textContent = status?.label ?? ''; });
  }

  const fromSteam = await api.finishSteam().catch(() => 'Steam sign-in failed. Try again.');
  if (!api.configured()) card('Not configured', '<p class="err">This admin site has no database connection (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).</p>');
  else { await refresh(); if (fromSteam && !status) stepSteam(fromSteam); }
  void api.onAuth(() => { if (alive && !busy) void refresh(); }).catch(() => {});
  tickTimer = window.setInterval(tick, 1000);
  touchTimer = window.setInterval(() => void heartbeat(), IDLE_TOUCH_MS);
  return { refresh, stop: () => { alive = false; clearInterval(tickTimer); clearInterval(touchTimer); document.removeEventListener('click', bump); document.removeEventListener('keydown', bump); window.removeEventListener('hashchange', onHash); } };
}
export { ROADMAP };
