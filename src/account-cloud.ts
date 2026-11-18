// Account window > Cloud: optional server-backed account. Bets here are drawn and settled by the database, not the browser.
import { BACKEND_URL, backendEnabled, currentUser, dailyRace, ensureAccount, confirmAgeOnServer, mySeeds, myBets, rotateServerSeed, serverBet, signInWithEmail, signOut } from './backend.js';
import { recompute } from './verify.js';
import { state } from './state.js';
import type { PaneCtx } from './account-rg.js';
import { $, esc, fmt, money, toast } from './ui.js';
import { sfx } from './sfx.js';

const hint = (t: string): string => `<p class="ac-note">${t}</p>`;

export async function renderCloud(pane: HTMLElement, ctx: PaneCtx): Promise<void> {
  pane.innerHTML = `<h2 class="ac-h">Cloud account</h2>
    <p class="ac-sub">Optional. Signed in, your balance and bets live on a server: the browser can no longer edit its own wallet, and the secret seed never leaves the database.</p>`;
  if (!backendEnabled()) {
    pane.insertAdjacentHTML('beforeend', `<div class="ac-card"><h3>Not connected</h3>
      ${hint('This copy of Vaultrush runs entirely in your browser. To turn the cloud account on, create a free Supabase project, run <code>supabase/migrations/0001_core.sql</code>, and set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>supabase/README.md</code>).')}
      <ul class="rgp-list"><li>Accounts: your coins and history follow you across devices.</li><li>Real fairness: the server holds the seed and makes every roll.</li><li>Leaderboards from real players, and realtime chat.</li></ul></div>`);
    return;
  }
  const user = await currentUser().catch(() => null);
  if (!user) {
    pane.insertAdjacentHTML('beforeend', `<div class="ac-card"><h3>Sign in</h3>${hint(`Connected to <code>${esc(BACKEND_URL)}</code>. We email you a one-time sign-in link, with no password to remember.`)}
      <div class="ac-inline"><input id="cEmail" type="email" placeholder="you@example.com"><button class="btn btn-primary" id="cSend">Email me a link</button></div></div>`);
    $('#cSend', pane).onclick = async () => {
      try { await signInWithEmail(($('#cEmail', pane) as HTMLInputElement).value.trim()); toast('Check your inbox for the sign-in link', 'win'); }
      catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    };
    return;
  }
  let acct: { display_name: string; balance: number };
  try { acct = await ensureAccount(); } catch (e) { pane.insertAdjacentHTML('beforeend', `<div class="ac-card ac-warn">${esc(e instanceof Error ? e.message : String(e))}</div>`); return; }
  const [seeds, bets, race] = await Promise.all([mySeeds().catch(() => []), myBets(10).catch(() => []), dailyRace().catch(() => [])]);
  const active = seeds.find(s => s.status === 'active'), next = seeds.find(s => s.status === 'next');
  pane.insertAdjacentHTML('beforeend', `
    <div class="ac-card kyc-tier"><div><span class="muted small">Signed in as</span><b class="kyc-tier-n">${esc(acct.display_name)}</b><span class="muted">${esc(user.email ?? '')}</span></div>
      <div class="kyc-lim"><span class="muted small">Server balance</span><b>${fmt(acct.balance)}</b></div><div class="kyc-lim"><button class="btn btn-ghost" id="cOut">Sign out</button></div></div>
    <div class="ac-card"><h3>Server-side Crash bet</h3>${hint('Pick an amount and a cash-out multiplier. The database draws the roll from your secret seed, checks your limits and settles the bet in one transaction.')}
      <div class="ac-inline"><input id="cAmt" type="number" min="0.01" step="0.01" value="1" aria-label="Amount"><input id="cTarget" type="number" min="1.01" step="0.01" value="2" aria-label="Cash-out multiplier"><button class="btn btn-primary" id="cBet">Bet</button></div>
      <div class="ac-inline"><button class="btn btn-ghost btn-sm" id="cAge">Confirm I am 18+</button></div><div id="cRes"></div></div>
    <div class="ac-card"><h3>Seeds</h3>${hint('The hash of the next seed is committed before it is used. Rotating reveals the current seed so every bet made with it can be re-checked below.')}
      <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Status</th><th>Hash</th><th>Nonces</th><th>Seed</th></tr></thead><tbody>${seeds.slice(0, 6).map(s => `<tr><td>${s.status}</td><td><code>${esc(s.server_hash.slice(0, 16))}…</code></td><td>${s.nonce}</td><td>${s.server_seed ? `<code>${esc(s.server_seed.slice(0, 16))}…</code>` : '<span class="muted">hidden</span>'}</td></tr>`).join('')}</tbody></table></div>
      <div class="ac-links"><button class="btn btn-ghost" id="cRot">Rotate seed</button></div></div>
    <div class="ac-card"><h3>Recent server bets</h3>${bets.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Amount</th><th>Target</th><th>Crash point</th><th>Payout</th><th>Check</th></tr></thead><tbody>${bets.map(b => `<tr><td>${money(b.amount)}</td><td>${b.result.target}×</td><td>${b.result.crash_point}×</td><td class="${b.payout > 0 ? 'pos' : 'neg'}">${b.payout > 0 ? `+${fmt(b.payout)}` : '0.00'}</td><td data-chk="${b.id}" class="muted">after rotation</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">No server bets yet.</div>'}</div>
    <div class="ac-card"><h3>Today's race (real players)</h3>${race.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>#</th><th>Player</th><th>Wagered</th><th class="r">Bets</th></tr></thead><tbody>${race.slice(0, 10).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.display_name)}</td><td>${money(r.wagered)}</td><td class="r muted">${r.bets}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">Nobody has wagered today.</div>'}</div>`);

  // Re-check every bet made with a revealed seed, locally, with the same code the Fairness page uses.
  for (const b of bets) {
    const s = seeds.find(x => x.server_hash === b.server_hash && x.server_seed);
    const cell = pane.querySelector(`[data-chk="${b.id}"]`);
    if (!s || !cell) continue;
    const again = await recompute('crash', undefined, s.server_seed as string, b.client_seed, b.nonce).catch(() => null);
    const ok = again && Number(again.key) === Number(b.result.crash_point);
    cell.innerHTML = ok ? '<span class="sev sev-ok">verified</span>' : '<span class="sev sev-high">mismatch</span>';
  }
  $('#cOut', pane).onclick = async () => { await signOut(); ctx.rerender(); };
  $('#cAge', pane).onclick = async () => { try { await confirmAgeOnServer(); toast('Confirmed', 'win'); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } };
  $('#cRot', pane).onclick = async () => { try { await rotateServerSeed(); toast('Seed revealed', 'win'); ctx.rerender(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } };
  $('#cBet', pane).onclick = async () => {
    try {
      const r = await serverBet(Number(($('#cAmt', pane) as HTMLInputElement).value), Number(($('#cTarget', pane) as HTMLInputElement).value));
      sfx[r.win ? 'win' : 'click']?.();
      $('#cRes', pane).innerHTML = `<div class="ac-card"><h3><span class="sev sev-${r.win ? 'ok' : 'high'}">${r.win ? 'win' : 'loss'}</span> crashed at ${r.crash_point}×</h3><p class="ac-note">Payout ${fmt(r.payout)}. Balance ${fmt(r.balance)}. Nonce ${r.nonce}, roll ${r.float.toFixed(8)}.</p></div>`;
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  void state;
}
