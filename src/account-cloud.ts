// Account > Cloud Account and the cloud half of Account > Security. Bets here are drawn and settled by the database, not the browser.
import {
  BACKEND_URL, backendEnabled, changePassword, confirm2fa, currentUser, dailyRace, deleteAccount, enroll2fa, exportMyData, hasProfile, list2fa, myBets, mySeeds,
  remove2fa, rotateServerSeed, serverBet, signOut, signOutEverywhere,
} from './backend.js';
import { openAuth, openFinishProfile } from './auth.js';
import { validatePassword } from './signup.js';
import { recompute } from './verify.js';
import type { PaneCtx } from './account-rg.js';
import { $, esc, fmt, money, toast } from './ui.js';
import { sfx } from './sfx.js';

const hint = (t: string): string => `<p class="ac-note">${t}</p>`;
const fail = (e: unknown): void => { toast(e instanceof Error ? e.message : String(e), 'error'); };
const download = (name: string, data: unknown): void => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export async function renderCloud(pane: HTMLElement, ctx: PaneCtx): Promise<void> {
  pane.innerHTML = `<h2 class="ac-h">Cloud account</h2>
    <p class="ac-sub">Optional. Signed in, your balance and bets live on a server: the browser can no longer edit its own wallet, and the secret seed never leaves the database.</p>`;
  if (!backendEnabled()) {
    pane.insertAdjacentHTML('beforeend', `<div class="ac-card"><h3>Not connected</h3>
      ${hint('This copy of Vaultrush runs entirely in your browser. To turn the cloud account on, create a free Supabase project, run <code>supabase/migrations/0001_core.sql</code>, and set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>supabase/README.md</code>).')}
      <ul class="rgp-list"><li>Accounts: your coins and history follow you across devices.</li><li>Real fairness: the server holds the seed and makes every roll.</li><li>Leaderboards from real players, and realtime chat.</li></ul>
      <div class="ac-links"><button class="btn btn-ghost" id="cLocal">Create or edit my local profile</button></div></div>`);
    $('#cLocal', pane).onclick = () => { ctx.close(); openAuth({ cloud: false }); };
    return;
  }
  const user = await currentUser().catch(() => null);
  if (!user) {
    pane.insertAdjacentHTML('beforeend', `<div class="ac-card"><h3>Sign in</h3>${hint(`Connected to <code>${esc(BACKEND_URL)}</code>. Log in or register with email and password, Google, Discord, Twitch or Steam.`)}
      <div class="ac-links"><button class="btn btn-primary" id="cIn">Log in</button><button class="btn btn-ghost" id="cReg">Register</button></div></div>`);
    $('#cIn', pane).onclick = () => { ctx.close(); openAuth({ tab: 'login' }); };
    $('#cReg', pane).onclick = () => { ctx.close(); openAuth({ tab: 'register' }); };
    return;
  }
  if (!(await hasProfile().catch(() => false))) {
    pane.insertAdjacentHTML('beforeend', `<div class="ac-card ac-warn"><h3>One more step</h3>${hint('You are signed in, but your player profile is not finished yet.')}<button class="btn btn-primary" id="cFin">Finish my profile</button></div>`);
    $('#cFin', pane).onclick = () => { ctx.close(); openFinishProfile(); };
    return;
  }
  const [seeds, bets, race] = await Promise.all([mySeeds().catch(() => []), myBets(10).catch(() => []), dailyRace().catch(() => [])]);
  pane.insertAdjacentHTML('beforeend', `
    <div class="ac-card kyc-tier"><div><span class="muted small">Signed in as</span><b class="kyc-tier-n">${esc(user.email?.replace(/@steam\.vaultrush\.invalid$/, ' (Steam)') ?? 'player')}</b></div>
      <div class="kyc-lim"><button class="btn btn-ghost" id="cOut">Sign out</button></div><div class="kyc-lim"><button class="btn btn-ghost" id="cOutAll">Sign out everywhere</button></div></div>
    <div class="ac-card"><h3>Server-side Crash bet</h3>${hint('Pick an amount and a cash-out multiplier. The database draws the roll from your secret seed, checks your limits and settles the bet in one transaction.')}
      <div class="ac-inline"><input id="cAmt" type="number" min="0.01" step="0.01" value="1" aria-label="Amount"><input id="cTarget" type="number" min="1.01" step="0.01" value="2" aria-label="Cash-out multiplier"><button class="btn btn-primary" id="cBet">Bet</button></div><div id="cRes"></div></div>
    <div class="ac-card"><h3>Seeds</h3>${hint('The hash of the next seed is committed before it is used. Rotating reveals the current seed so every bet made with it can be re-checked below.')}
      <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Status</th><th>Hash</th><th>Nonces</th><th>Seed</th></tr></thead><tbody>${seeds.slice(0, 6).map(s => `<tr><td>${s.status}</td><td><code>${esc(s.server_hash.slice(0, 16))}…</code></td><td>${s.nonce}</td><td>${s.server_seed ? `<code>${esc(s.server_seed.slice(0, 16))}…</code>` : '<span class="muted">hidden</span>'}</td></tr>`).join('')}</tbody></table></div>
      <div class="ac-links"><button class="btn btn-ghost" id="cRot">Rotate seed</button></div></div>
    <div class="ac-card"><h3>Recent server bets</h3>${bets.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Amount</th><th>Target</th><th>Crash point</th><th>Payout</th><th>Check</th></tr></thead><tbody>${bets.map(b => `<tr><td>${money(b.amount)}</td><td>${b.result.target}×</td><td>${b.result.crash_point}×</td><td class="${b.payout > 0 ? 'pos' : 'neg'}">${b.payout > 0 ? `+${fmt(b.payout)}` : '0.00'}</td><td data-chk="${b.id}" class="muted">after rotation</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">No server bets yet.</div>'}</div>
    <div class="ac-card"><h3>Today's race (real players)</h3>${race.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>#</th><th>Player</th><th>Wagered</th><th class="r">Bets</th></tr></thead><tbody>${race.slice(0, 10).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.display_name)}</td><td>${money(r.wagered)}</td><td class="r muted">${r.bets}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">Nobody has wagered today.</div>'}</div>
    <div class="ac-card"><h3>Your data</h3>${hint('Download everything the server holds about you, or delete your account. Deleting anonymises your profile, removes your chat messages and date of birth, closes the login and zeroes your balance. Bets and ledger entries stay, without your name, as financial records.')}
      <div class="ac-links"><button class="btn btn-ghost" id="cExport">Download my data</button></div></div>
    <div class="ac-card ac-danger"><div><h3>Delete my account</h3><p class="ac-note">This cannot be undone. Type <b>DELETE</b> to confirm.</p></div>
      <div class="ac-inline"><input id="cDelWord" placeholder="DELETE" aria-label="Type DELETE" style="max-width:130px"><button class="btn btn-ghost" id="cDel" disabled>Delete</button></div></div>`);

  for (const b of bets) {                                      // re-check bets made with a revealed seed, locally, with the Fairness page's code
    const s = seeds.find(x => x.server_hash === b.server_hash && x.server_seed), cell = pane.querySelector(`[data-chk="${b.id}"]`);
    if (!s || !cell) continue;
    const again = await recompute('crash', undefined, s.server_seed as string, b.client_seed, b.nonce).catch(() => null);
    cell.innerHTML = again && Number(again.key) === Number(b.result.crash_point) ? '<span class="sev sev-ok">verified</span>' : '<span class="sev sev-high">mismatch</span>';
  }
  $('#cOut', pane).onclick = async () => { await signOut(); ctx.rerender(); };
  $('#cOutAll', pane).onclick = async () => { try { await signOutEverywhere(); toast('Signed out on every device'); ctx.rerender(); } catch (e) { fail(e); } };
  $('#cRot', pane).onclick = async () => { try { await rotateServerSeed(); toast('Seed revealed', 'win'); ctx.rerender(); } catch (e) { fail(e); } };
  $('#cBet', pane).onclick = async () => {
    try {
      const r = await serverBet(Number(($('#cAmt', pane) as HTMLInputElement).value), Number(($('#cTarget', pane) as HTMLInputElement).value));
      sfx[r.win ? 'win' : 'click']?.();
      $('#cRes', pane).innerHTML = `<div class="ac-card"><h3><span class="sev sev-${r.win ? 'ok' : 'high'}">${r.win ? 'win' : 'loss'}</span> crashed at ${r.crash_point}×</h3><p class="ac-note">Payout ${fmt(r.payout)}. Balance ${fmt(r.balance)}. Nonce ${r.nonce}, roll ${r.float.toFixed(8)}.</p></div>`;
    } catch (e) { fail(e); }
  };
  $('#cExport', pane).onclick = async () => { try { download('vaultrush-my-data.json', await exportMyData()); } catch (e) { fail(e); } };
  const word = $('#cDelWord', pane) as HTMLInputElement, del = $('#cDel', pane) as HTMLButtonElement;
  word.oninput = () => { del.disabled = word.value !== 'DELETE'; };
  del.onclick = async () => { try { await deleteAccount(); toast('Your account was deleted'); ctx.close(); } catch (e) { fail(e); } };
}

/** Appended to Account > Security: password, two-factor authentication and signing out of every device (cloud accounts only). */
export async function renderSecurityCloud(box: HTMLElement | null, ctx: PaneCtx): Promise<void> {
  if (!box) return;
  if (!backendEnabled()) { box.innerHTML = `<div class="ac-card"><h3>Two-factor authentication</h3>${hint('Available with a cloud account. This browser-only profile has no password to protect.')}</div>`; return; }
  const user = await currentUser().catch(() => null);
  if (!user) { box.innerHTML = `<div class="ac-card"><h3>Two-factor authentication</h3>${hint('Sign in to a cloud account to set up an authenticator app.')}</div>`; return; }
  const factors = await list2fa().catch(() => []), on = factors.find(f => f.status === 'verified');
  box.innerHTML = `
    <div class="ac-card"><h3>Two-factor authentication</h3>
      ${hint(on ? 'On. You will be asked for a code from your authenticator app each time you log in with a password.' : 'Add a second step to logging in with an authenticator app (Google Authenticator, 1Password, Authy and others).')}
      <div class="ac-links">${on ? '<button class="btn btn-ghost" id="faOff">Turn off</button>' : '<button class="btn btn-primary" id="faOn">Set up 2FA</button>'}</div><div id="faBox"></div></div>
    <div class="ac-card"><h3>Password</h3>${hint('Signed in with Google, Steam or another provider? You have no password here.')}
      <div class="ac-inline"><input id="pwNew" type="password" autocomplete="new-password" maxlength="72" placeholder="New password (10+ characters)" aria-label="New password"><button class="btn btn-ghost" id="pwSave">Change</button></div></div>
    <div class="ac-card ac-split"><div><h3>Active sessions</h3><p class="ac-note">Sign out of every device, including this one.</p></div><button class="btn btn-ghost" id="allOut">Log out everywhere</button></div>`;
  $('#faOn', box)?.addEventListener('click', async () => {
    try {
      const f = await enroll2fa();
      $('#faBox', box).innerHTML = `<div class="fa-setup"><img alt="QR code for your authenticator app" src="data:image/svg+xml;utf8,${encodeURIComponent(f.qr)}" width="168" height="168"><div><p class="ac-note">Scan the code, or type this key into your app:</p><code>${esc(f.secret)}</code>
        <div class="ac-inline"><input id="faCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" aria-label="Authenticator code"><button class="btn btn-primary" id="faOk">Verify</button></div></div></div>`;
      $('#faOk', box).onclick = async () => { try { await confirm2fa(f.id, ($('#faCode', box) as HTMLInputElement).value); toast('Two-factor authentication is on', 'win'); ctx.rerender(); } catch (e) { fail(e); } };
    } catch (e) { fail(e); }
  });
  $('#faOff', box)?.addEventListener('click', async () => {
    if (!confirm('Turn off two-factor authentication?') || !on) return;
    try { await remove2fa(on.id); toast('Two-factor authentication is off'); ctx.rerender(); } catch (e) { fail(e); }
  });
  $('#pwSave', box).onclick = async () => {
    const pw = ($('#pwNew', box) as HTMLInputElement).value, bad = validatePassword(pw, { email: user.email });
    if (bad) return toast(bad, 'error');
    try { await changePassword(pw); toast('Password changed', 'win'); ($('#pwNew', box) as HTMLInputElement).value = ''; } catch (e) { fail(e); }
  };
  $('#allOut', box).onclick = async () => { try { await signOutEverywhere(); toast('Signed out on every device'); ctx.close(); } catch (e) { fail(e); } };
}
