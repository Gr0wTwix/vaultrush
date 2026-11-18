// Account window: one modal with a left menu (Account, Security, Affiliates, Options, Game History, Transactions, Self Exclusion).
import { state, save, level, levelFromXp, xpForLevel, isExcluded, resetAccount, START_BALANCE } from './state.js';
import { getFair, setClientSeed, rotate, randHex } from './fair.js';
import { BOTS } from './data.js';
import { $, $$, esc, fmt, money, icon, avatar, toast, modal } from './ui.js';
import { sfx } from './sfx.js';
import { renderResponsible } from './account-rg.js';
import { renderVerification } from './account-kyc.js';
import { renderCloud, renderSecurityCloud } from './account-cloud.js';
import { renderOverview } from './account-overview.js';
import { activeId, fairKeyFor, stateKeyFor } from './accounts.js';

const TABS = [
  ['account', 'Account', 'user'], ['security', 'Security', 'lock'], ['affiliates', 'Affiliates', 'users'], ['options', 'Options', 'gear'],
  ['history', 'Game History', 'list'], ['tx', 'Transactions', 'clock'], ['kyc', 'Verification', 'id'], ['responsible', 'Responsible Play', 'heart'], ['cloud', 'Cloud Account', 'users'],
];

/** Interface switches that live outside the modal (chat visibility, streamer mode). Call once at start-up and after changes. */
export function applyUi() {
  document.body.classList.toggle('no-fx', !state.ui.fx);
  document.body.classList.toggle('no-chat', !state.ui.chat);
  document.body.classList.toggle('streamer', !!state.ui.streamer);
}

const copy = async text => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed', 'error'); } };
const ago = t => {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const device = () => {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${b} (${o})`;
};
const switchRow = (id, label, on, hint = '') => `<label class="ac-row ac-switch"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
const head = (title, sub = '') => `<h2 class="ac-h">${title}</h2>${sub ? `<p class="ac-sub">${sub}</p>` : ''}`;

/** Numbered pagination like: ‹ 1 2 3 … N › */
function pager(page, pages) {
  if (pages <= 1) return '';
  const nums = new Set([1, 2, 3, pages, page - 1, page, page + 1].filter(n => n >= 1 && n <= pages));
  const sorted = [...nums].sort((a, b) => a - b);
  let out = `<button data-p="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>`, prev = 0;
  for (const n of sorted) { if (n - prev > 1) out += '<span>…</span>'; out += `<button data-p="${n}" class="${n === page ? 'on' : ''}">${n}</button>`; prev = n; }
  return `<div class="ac-pager">${out}<button data-p="${page + 1}" ${page === pages ? 'disabled' : ''}>›</button></div>`;
}

let current = null;

export function openAccount(tab = 'account') {
  if (tab === 'exclude') tab = 'responsible';
  if (current) return current.go(tab);
  const m = modal('', { wide: true, onClose: () => { current = null; } });
  m.el.classList.add('acct');
  m.el.insertAdjacentHTML('beforeend', `
    <nav class="ac-rail"><div class="ac-rail-title">Account</div>${TABS.map(([k, label, ic]) => `<button data-t="${k}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>
    <section class="ac-pane" id="acPane"></section>`);
  const pane = $('#acPane', m.el);
  const pg = { history: { page: 1, per: 10, filter: 'all' }, tx: { page: 1, per: 10, filter: 'all' } };
  let tabNow = tab;

  const ctx = { rerender: () => VIEWS[tabNow]?.(), close: () => m.close() };
  const VIEWS = {
    // ---- Account ------------------------------------------------------------------------------------------
    account() { renderOverview(pane, ctx, go); },

    // ---- Security -----------------------------------------------------------------------------------------
    security() {
      pane.innerHTML = `${head('Security', 'This demo has no password or email, so there is nothing to hack. Your progress lives in this browser only.')}
        <div class="ac-card"><h3>Back up your progress</h3><p class="ac-note">Download your balance, items, levels and history as a file, or restore it on another browser. Clearing site data erases it, so a backup is the only way to recover.</p>
          <div class="ac-links"><button class="btn btn-primary" id="acExport">Download backup</button><label class="btn btn-ghost" for="acImport">Restore from file</label><input type="file" id="acImport" accept="application/json,.json" hidden></div></div>
        <div class="ac-card"><h3>Active sessions</h3><p class="ac-note">Sessions on this device. A real account would list other devices here and let you sign them out.</p>
          <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Device</th><th>Location</th><th>Started</th></tr></thead><tbody><tr><td>${esc(device())}</td><td>This device</td><td><b class="pos">Current session</b> <span class="muted small">since ${new Date(state.rg.sessionStart || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td></tr></tbody></table></div></div>
        <div id="acSecCloud"></div>
        <div class="ac-card ac-danger"><div><h3>Reset demo account</h3><p class="ac-note">Back to ${fmt(START_BALANCE)} coins, level 0, an empty inventory and no history. This cannot be undone.</p></div><button class="btn btn-ghost" id="acReset">Reset account</button></div>`;
      $('#acExport', pane).onclick = () => {
        const blob = new Blob([JSON.stringify({ app: 'vaultrush', version: 1, savedAt: new Date().toISOString(), state, fair: getFair() }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'vaultrush-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      $('#acImport', pane).onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (data.app !== 'vaultrush' || typeof data.state?.balance !== 'number') throw new Error('bad file');
          if (!confirm('Replace your current progress with this backup?')) return;
          localStorage.setItem(stateKeyFor(activeId()), JSON.stringify(data.state));
          if (data.fair) localStorage.setItem(fairKeyFor(activeId()), JSON.stringify(data.fair));
          location.reload();
        } catch { toast('That is not a Vaultrush backup', 'error'); }
      };
      $('#acReset', pane).onclick = () => { if (confirm('Reset your demo account? This cannot be undone.')) { resetAccount(); applyUi(); toast('Account reset'); VIEWS.security(); } };
      void renderSecurityCloud($('#acSecCloud', pane), ctx);
    },

    // ---- Affiliates ---------------------------------------------------------------------------------------
    affiliates() {
      const link = `${location.origin}${location.pathname}#/?ref=${encodeURIComponent(state.name)}`;
      const tiers = [[1, 1, 0], [2, 1.5, 100], [3, 2, 1000], [4, 2.5, 2500], [5, 3, 5000]];
      pane.innerHTML = `${head('Affiliates', 'Invite friends and earn a kickback on what they wager. Demo mode: referrals need a server, so the numbers stay at zero.')}
        <div class="ac-stats three"><div class="ac-stat"><b class="pos">Tier 1</b><span>1% kickback</span></div><div class="ac-stat">${money(0)}<span>Total wagered by referrals</span></div><div class="ac-stat"><b>0</b><span>Current users</span></div></div>
        <div class="ac-card"><h3>Share your referral link</h3><p class="ac-note">Friends who open this link are prompted to use your code.</p>
          <div class="ac-inline"><input readonly value="${esc(link)}" id="acRef"><button class="btn btn-ghost" id="acRefCopy">${icon('copy')} Copy</button></div></div>
        <div class="ac-card ac-split"><div><h3>Affiliate balance</h3><p class="ac-note">Cash out your affiliate earnings as coins. Minimum cash out is 1 coin.</p></div><button class="btn btn-ghost" disabled>${money(0)} Cash out</button></div>
        <h3 class="ac-tier-h">Affiliate tiers</h3>
        <div class="ac-tiers">${tiers.map(([t, p, need], i) => `<div class="${i === 0 ? 'on' : ''}"><b>Tier ${t}</b><span>${p}% kickback</span><em>${need.toLocaleString('en-US')} coins referred</em></div>`).join('')}</div>`;
      $('#acRefCopy', pane).onclick = () => copy(link);
      $('#acRef', pane).onfocus = e => e.target.select();
    },

    // ---- Options ------------------------------------------------------------------------------------------
    options() {
      const f = getFair();
      pane.innerHTML = `${head('Options', 'Interface, sound and provably fair seeds.')}
        <div class="ac-card"><h3>User interface</h3>
          ${switchRow('acSnd', 'Sound effects', !state.muted)}
          ${switchRow('acChat', 'Show chat', state.ui.chat, 'Hide the chat column for a wider game area')}
          ${switchRow('acLvl', 'Level-up pop-ups', state.ui.levelPopup)}
          ${switchRow('acStream', 'Streamer mode', state.ui.streamer, 'Blurs your balance and name')}
          <div class="ac-row"><span>Default animation speed</span><div class="seg" id="acSpd">${['normal', 'fast', 'turbo'].map(v => `<button data-v="${v}" class="${state.speed === v ? 'active' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div></div>
        <div class="ac-card"><h3>Fairness</h3><p class="ac-note">Your server and client seed pair decides every result. Verify bets on the <a href="#/fair" id="acFairLink">Fairness page</a>.</p>
          <label class="ac-field">Current server seed (hashed)<div class="ac-copy"><code>${esc(f.serverHash)}</code><button data-copy="${esc(f.serverHash)}" aria-label="Copy">${icon('copy')}</button></div></label>
          <label class="ac-field">Next server seed (hashed)<div class="ac-copy"><code>${esc(f.next.serverHash)}</code><button data-copy="${esc(f.next.serverHash)}" aria-label="Copy">${icon('copy')}</button></div></label>
          <label class="ac-field">Current client seed<div class="ac-copy"><code>${esc(f.clientSeed)}</code><button data-copy="${esc(f.clientSeed)}" aria-label="Copy">${icon('copy')}</button></div></label>
          <label class="ac-field">Amount of games with this pair<div class="ac-copy"><code>${f.nonce}</code></div></label>
          <div class="ac-field">New client seed<div class="ac-inline"><input id="acSeed" maxlength="64" placeholder="Random words or characters"><button class="btn btn-ghost btn-sm" id="acGen">Generate</button><button class="btn btn-primary" id="acSeedSave">Change</button></div></div>
          <div class="ac-split ac-rot"><div><b>Rotate server seed</b><p class="ac-note">Reveals the current seed so you can check your past games, and starts the pair you were shown above.</p></div><button class="btn btn-primary" id="acRotate">Rotate</button></div></div>
        <div class="ac-card"><h3>Ignored players</h3><p class="ac-note">Chat messages from these players are hidden. Click a name in chat to ignore someone.</p>
          <div id="acBlocked">${state.blocked.length ? state.blocked.map(u => `<div class="ac-row"><span class="ac-user">${avatar(u, 24)} ${esc(u)}</span><button class="btn btn-ghost btn-sm" data-un="${esc(u)}">Unignore</button></div>`).join('') : '<div class="ac-empty">No players ignored</div>'}</div></div>`;
      $('#acSnd', pane).onchange = e => { state.muted = !e.target.checked; save(); const b = $('#muteBtn'); if (b) b.innerHTML = icon(state.muted ? 'mute' : 'sound'); };
      $('#acChat', pane).onchange = e => { state.ui.chat = e.target.checked; save(); applyUi(); };
      $('#acLvl', pane).onchange = e => { state.ui.levelPopup = e.target.checked; save(); };
      $('#acStream', pane).onchange = e => { state.ui.streamer = e.target.checked; save(); applyUi(); };
      $$('#acSpd button', pane).forEach(b => b.onclick = () => { state.speed = b.dataset.v; save(); $$('#acSpd button', pane).forEach(x => x.classList.toggle('active', x === b)); });
      $$('[data-copy]', pane).forEach(b => b.onclick = () => copy(b.dataset.copy));
      $('#acFairLink', pane).onclick = () => m.close();
      $('#acGen', pane).onclick = () => { $('#acSeed', pane).value = randHex(8); };
      $('#acSeedSave', pane).onclick = () => { const v = $('#acSeed', pane).value.trim(); if (!v) return toast('Type a seed or press Generate', 'error'); setClientSeed(v); sfx.click(); toast('Client seed changed', 'win'); VIEWS.options(); };
      $('#acRotate', pane).onclick = async () => { if (!confirm('Rotate your server seed? The current one is revealed.')) return; await rotate(); sfx.click(); toast('Seed revealed. Check your bets on the Fairness page.', 'win'); VIEWS.options(); };
      $$('[data-un]', pane).forEach(b => b.onclick = () => { state.blocked = state.blocked.filter(u => u !== b.dataset.un); save(); VIEWS.options(); });
    },

    // ---- Game history -------------------------------------------------------------------------------------
    history() {
      const p = pg.history, games = [...new Set(state.history.map(h => h.game))];
      const rows = state.history.filter(h => p.filter === 'all' || h.game === p.filter), pages = Math.max(1, Math.ceil(rows.length / p.per));
      p.page = Math.min(p.page, pages);
      const slice = rows.slice((p.page - 1) * p.per, p.page * p.per), at = i => state.history.indexOf(slice[i]);
      pane.innerHTML = `${head('Game History', `Your last ${state.history.length} bets.`)}
        <div class="ac-pills">${['all', ...games].map(g => `<button data-f="${esc(g)}" class="${g === p.filter ? 'on' : ''}">${g === 'all' ? 'All' : esc(g)}</button>`).join('')}</div>
        <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Id</th><th>Game</th><th>Wager</th><th>Multi</th><th>Payout</th><th class="r">Time</th></tr></thead><tbody>
        ${slice.map((h, i) => `<tr><td class="muted">${h.id ?? state.history.length - at(i)}</td><td>${esc(h.game)}</td><td>${money(h.amount)}</td><td class="${h.payout > 0 ? 'pos' : 'neg'}">${fmt(h.multi)}×</td><td class="${h.payout > 0 ? 'pos' : 'neg'}">${h.payout > 0 ? `+${fmt(h.payout)}` : fmt(0)}</td><td class="r muted">${ago(h.at)}</td></tr>`).join('') || '<tr><td colspan="6" class="ac-empty">No bets yet. Play a game and it shows up here.</td></tr>'}
        </tbody></table></div>
        <div class="ac-foot"><label>Rows per page <select id="acPer">${[10, 25, 50].map(n => `<option ${n === p.per ? 'selected' : ''}>${n}</option>`).join('')}</select></label><span class="muted small">${rows.length ? `${(p.page - 1) * p.per + 1}–${Math.min(rows.length, p.page * p.per)} of ${rows.length}` : '0 bets'}</span></div>
        ${pager(p.page, pages)}`;
      wireList(p, 'history');
    },

    // ---- Transactions -------------------------------------------------------------------------------------
    tx() {
      const p = pg.tx, cat = t => (t.type === 'Free coins' || t.type === 'Coin rain' || /^Payout/.test(t.type) ? 'Coins' : /case|gift|key/i.test(t.type) ? 'Cases' : 'Rewards');
      const rows = state.tx.filter(t => p.filter === 'all' || cat(t) === p.filter), pages = Math.max(1, Math.ceil(rows.length / p.per));
      p.page = Math.min(p.page, pages);
      const slice = rows.slice((p.page - 1) * p.per, p.page * p.per);
      pane.innerHTML = `${head('Transactions', 'Coins and items you received outside of bets: free coins, rain, rakeback, rewards and free cases.')}
        <div class="ac-pills">${['all', 'Coins', 'Rewards', 'Cases'].map(g => `<button data-f="${g}" class="${g === p.filter ? 'on' : ''}">${g === 'all' ? 'All' : g}</button>`).join('')}</div>
        <div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Id</th><th>Type</th><th>Status</th><th>Amount</th><th class="r">Time</th></tr></thead><tbody>
        ${slice.map(t => `<tr><td class="muted">${t.id}</td><td>${esc(t.type)}${t.note ? `<small class="ac-subtle">${esc(t.note)}</small>` : ''}</td><td><span class="ac-ok">Complete</span></td><td class="${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td><td class="r muted">${ago(t.at)}</td></tr>`).join('') || '<tr><td colspan="5" class="ac-empty">Nothing here yet. Claim free coins or open a reward case.</td></tr>'}
        </tbody></table></div>
        <div class="ac-foot"><label>Rows per page <select id="acPer">${[10, 25, 50].map(n => `<option ${n === p.per ? 'selected' : ''}>${n}</option>`).join('')}</select></label><span class="muted small">${rows.length ? `${(p.page - 1) * p.per + 1}–${Math.min(rows.length, p.page * p.per)} of ${rows.length}` : '0 transactions'}</span></div>
        ${pager(p.page, pages)}`;
      wireList(p, 'tx');
    },

    // ---- Verification (KYC / AML, sandbox) and Responsible Play: see account-kyc.ts and account-rg.ts ----
    kyc() { renderVerification(pane, ctx); },
    responsible() { renderResponsible(pane, ctx); },
    cloud() { void renderCloud(pane, ctx); },
  };

  /** Shared wiring for the two paged tables. */
  function wireList(p, key) {
    $$('.ac-pills button', pane).forEach(b => b.onclick = () => { p.filter = b.dataset.f; p.page = 1; VIEWS[key](); });
    $$('.ac-pager button', pane).forEach(b => b.onclick = () => { p.page = +b.dataset.p; VIEWS[key](); pane.scrollTop = 0; });
    $('#acPer', pane).onchange = e => { p.per = +e.target.value; p.page = 1; VIEWS[key](); };
  }

  const go = t => {
    tabNow = t in VIEWS ? t : 'account';
    $$('.ac-rail button', m.el).forEach(b => b.classList.toggle('on', b.dataset.t === tabNow));
    VIEWS[tabNow](); pane.scrollTop = 0;
  };
  $$('.ac-rail button', m.el).forEach(b => b.onclick = () => { sfx.click(); go(b.dataset.t); });
  current = { go, m };
  go(tab);
}
