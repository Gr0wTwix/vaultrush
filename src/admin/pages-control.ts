// Step B of the admin plan: Dashboard, Players (with account actions), Chat, Live rooms and Rounds (migration 0021).
// Every change asks for a reason and is checked and logged by the database; these screens only draw what it answers.
import type { BattleRoom, ChatMsg, ChatReport, ChatSettings, Dashboard, FlagKind, FlipRoom, PlayerProfile, PlayerRow, RoundBet, RoundRow } from './api.js';
import { errorText } from './api.js';
import { $, $$, coins, esc, reasonDialog, when } from './dom.js';
import type { Page, PageCtx } from './pages.js';

const FLAG_LABEL: Record<FlagKind, string> = { mute: 'Muted', warn: 'Warned', bet_ban: 'Betting ban', site_ban: 'Site ban' };
const TAGS = ['vip', 'watch', 'friend', 'tester', 'streamer'];
const DURATIONS: [string, number | null][] = [['15 minutes', 15], ['1 hour', 60], ['24 hours', 1440], ['7 days', 10080], ['30 days', 43200], ['Until lifted', null]];
const ago = (iso: string | null | undefined): string => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const can = (c: PageCtx, p: string): boolean => c.perms.includes(p);
const lockIf = (c: PageCtx, p: string): string => (can(c, p) ? '' : 'disabled title="You do not hold this permission"');
/** Runs an admin change after asking for its reason; reports the outcome. Returns true when it went through. */
async function act(c: PageCtx, title: string, detail: string, label: string, run: (reason: string) => Promise<unknown>, done = 'Saved'): Promise<boolean> {
  const reason = await reasonDialog(title, detail, label); if (!reason) return false;
  try { await run(reason); c.toast(done, 'ok'); return true; } catch (e) { c.toast(errorText(e), 'error'); return false; }
}
/** A tiny bar chart drawn with CSS: one bar per value, the label under each. */
const bars = (vals: { label: string; value: number; title: string }[]): string => {
  const max = Math.max(1, ...vals.map(v => v.value));
  return `<div class="bars" role="img" aria-label="${esc(vals.map(v => v.title).join(', '))}">${vals.map(v => `<div class="bar" title="${esc(v.title)}"><i style="height:${Math.round((v.value / max) * 100)}%"></i><span>${esc(v.label)}</span></div>`).join('')}</div>`;
};

// ============================================================================ Dashboard
const dashboard: Page = {
  title: 'Dashboard', perm: 'dashboard.view',
  async render(el, c) {
    const draw = (d: Dashboard): void => {
      const f = d.flags, rounds = d.rounds.map(r => `<div class="card"><span class="muted small">${esc(r.game === 'crash' ? 'Crash' : 'Double')} round #${r.id}</span><b>${esc(r.status)}</b><span class="muted small">${r.bets} bets, ${coins(r.staked)} staked</span></div>`).join('');
      el.innerHTML = `<p class="muted">What is happening on the game site now, straight from the database. Refreshes every 15 seconds while this page is open. "Active" means the player placed a bet or wrote in chat.</p>
        ${d.site.maintenance_on ? '<p class="err" role="alert">Maintenance is ON: players cannot play.</p>' : ''}${d.site.games_off.length ? `<p class="muted">Paused games: <b>${esc(d.site.games_off.join(', '))}</b></p>` : ''}
        <div class="cards">
          <div class="card"><span class="muted small">Active, last 15 minutes</span><b>${d.players.active_15m}</b><span class="muted small">${d.players.active_today} active today (UTC)</span></div>
          <div class="card"><span class="muted small">Players</span><b>${d.players.total}</b><span class="muted small">${d.players.new_today} new today, ${d.players.new_7d} in 7 days</span></div>
          <div class="card"><span class="muted small">Bets, last 15 minutes</span><b>${d.bets_15m.count}</b><span class="muted small">${coins(d.bets_15m.staked)} staked (solo games and settled live games)</span></div>
          <div class="card"><span class="muted small">Chat, last 15 minutes</span><b>${d.chat_15m}</b><span class="muted small">${d.chat.locked ? 'room LOCKED' : d.chat.slow_seconds ? `slow mode ${d.chat.slow_seconds} s` : 'open'}</span></div>
          <a class="card link-card" href="#/rooms"><span class="muted small">Open lobbies</span><b>${d.rooms.battles_waiting + d.rooms.coinflips_waiting}</b><span class="muted small">${d.rooms.battles_waiting} battles, ${d.rooms.coinflips_waiting} coinflips${d.rooms.stuck ? `, <b class="warn-t">${d.rooms.stuck} stuck</b>` : ''}</span></a>
          <a class="card link-card" href="#/chat"><span class="muted small">Open chat reports</span><b>${d.reports_open}</b><span class="muted small">reported by players</span></a>
          <a class="card link-card" href="#/players"><span class="muted small">Active restrictions</span><b>${f.mute + f.bet_ban + f.site_ban}</b><span class="muted small">${f.mute} muted, ${f.bet_ban} betting bans, ${f.site_ban} site bans, ${f.warn} warnings</span></a>
          ${rounds}</div>
        <div class="two"><section class="block"><h2>Bets per hour, last 24 hours</h2>${bars(d.bets_24h.map(b => ({ label: new Date(b.hour).getHours().toString().padStart(2, '0'), value: b.count, title: `${new Date(b.hour).toLocaleString()}: ${b.count} bets, ${coins(b.staked)} staked` })))}</section>
          <section class="block"><h2>New players per day</h2>${bars(d.signups_7d.map(s => ({ label: new Date(s.day).toLocaleDateString([], { weekday: 'short' }), value: s.count, title: `${s.day}: ${s.count}` })))}</section></div>
        <p class="muted small">Updated ${esc(new Date(d.now).toLocaleTimeString())}.</p>`;
    };
    draw(await c.api.dashboard());
    const t = window.setInterval(() => { if (!el.isConnected) { clearInterval(t); return; } void c.api.dashboard().then(draw).catch(() => {}); }, 15_000);
  },
};

// ============================================================================ Players
const statusPills = (p: { closed: boolean; staff_role: string | null; flags: FlagKind[]; excluded?: boolean; tags: string[] }): string =>
  [p.closed ? '<span class="pill later">closed</span>' : '', p.staff_role ? `<span class="pill partial">staff: ${esc(p.staff_role)}</span>` : '',
   ...p.flags.map(f => `<span class="pill warn">${esc(FLAG_LABEL[f])}</span>`), p.excluded ? '<span class="pill warn">self-excluded / break</span>' : '',
   ...p.tags.map(t => `<span class="pill next">${esc(t)}</span>`)].join(' ');

const players: Page = {
  title: 'Players', perm: 'players.view',
  async render(el, c) {
    let rows: PlayerRow[] = [], q = '', filter = '';
    el.innerHTML = `<p class="muted">Every account. Search by name or paste an id. Click a player to see everything about them and to act on the account.</p>
      <form id="pFind" class="row wrap"><label class="sr" for="pq">Search</label><input id="pq" placeholder="Name or id" style="max-width:280px">
        <label class="sr" for="pf">Show</label><select id="pf" style="max-width:220px"><option value="">Everyone</option><option value="banned">Banned</option><option value="muted">Muted</option><option value="warned">Warned</option>
          <option value="excluded">Self-excluded or on a break</option><option value="closed">Closed accounts</option><option value="staff">Staff</option>${TAGS.map(t => `<option value="tag:${t}">Tag: ${t}</option>`).join('')}</select>
        <button class="btn">Show</button></form>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Player</th><th>Status</th><th>Balance</th><th>Last active</th><th>Joined</th></tr></thead><tbody id="pRows"></tbody></table></div>
      <p><button class="btn ghost" id="pMore" hidden>Load more</button></p><div id="pOne"></div>`;
    const draw = (): void => {
      $('#pRows', el).innerHTML = rows.map(p => `<tr data-p="${esc(p.id)}" tabindex="0" class="click"><td><b>${esc(p.name)}</b></td><td>${statusPills(p) || '<span class="muted small">ok</span>'}</td>
        <td>${p.balance === null ? '' : coins(p.balance)}</td><td class="muted small">${esc(ago(p.last_seen))}</td><td class="muted small">${esc(when(p.created_at))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nobody matches.</td></tr>';
      $$('tr[data-p]', el).forEach(tr => { const open = (): void => void openPlayer(c, $('#pOne', el), tr.dataset['p'] as string, () => void load(false)); tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); }; });
    };
    const load = async (more: boolean): Promise<void> => {
      const got = await c.api.players(q, filter, more ? rows.length : 0);
      rows = more ? [...rows, ...got] : got; ($('#pMore', el) as HTMLButtonElement).hidden = got.length < 50; draw();
    };
    $<HTMLFormElement>('#pFind', el).onsubmit = e => { e.preventDefault(); q = $<HTMLInputElement>('#pq', el).value.trim(); filter = $<HTMLSelectElement>('#pf', el).value; void load(false).catch(er => c.toast(errorText(er), 'error')); };
    $('#pMore', el).onclick = () => void load(true).catch(er => c.toast(errorText(er), 'error'));
    await load(false);
    const want = new URLSearchParams(location.hash.split('?')[1] ?? '').get('id');
    if (want) await openPlayer(c, $('#pOne', el), want, () => void load(false));
  },
};

async function openPlayer(c: PageCtx, box: HTMLElement, id: string, onChange: () => void): Promise<void> {
  box.innerHTML = '<p class="muted">Loading…</p>';
  let p: PlayerProfile;
  try { p = await c.api.player(id); } catch (e) { box.innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; return; }
  const me = p.player, active = p.flags.filter(f => f.active), open = !me.closed;
  const reload = async (): Promise<void> => { onChange(); await openPlayer(c, box, id, onChange); };
  box.innerHTML = `<section class="block" id="profile"><h2>${esc(me.name)} ${statusPills({ closed: me.closed, staff_role: me.staff_role, flags: active.map(f => f.kind), tags: p.tags })}</h2>
    <p class="muted small">Joined ${esc(when(me.created_at))}${me.sign_in?.provider ? `, signs in with ${esc(me.sign_in.provider)}` : ''}${me.sign_in?.last_sign_in_at ? `, last sign-in ${esc(when(me.sign_in.last_sign_in_at))}` : ''}. Terms ${esc(me.terms_version ?? 'not accepted')}. <code>${esc(me.id)}</code></p>
    <div class="cards">
      ${p.wallet ? `<a class="card link-card" href="#/wallets"><span class="muted small">Balance</span><b>${coins(p.wallet.balance)}</b><span class="muted small">wagered ${coins(p.wallet.wagered)}, won ${coins(p.wallet.won)}</span></a>` : ''}
      <div class="card"><span class="muted small">Live games</span><b>${p.games.battles + p.games.coinflips}</b><span class="muted small">${p.games.battles} battles, ${p.games.coinflips} coinflips, ${p.games.round_bets} Crash/Double bets</span></div>
      <div class="card"><span class="muted small">Free crates taken</span><b>${p.claims.length}</b><span class="muted small">${esc(p.claims.map(x => `${x.kind} ${when(x.at)}`).join(', ') || 'none')}</span></div>
      ${p.controls ? `<div class="card"><span class="muted small">Responsible play</span><b>${p.controls.excluded_until && Date.parse(p.controls.excluded_until) > Date.now() ? 'excluded' : p.controls.cool_off_until && Date.parse(p.controls.cool_off_until) > Date.now() ? 'on a break' : 'none'}</b><span class="muted small">verification level ${p.controls.kyc_tier}</span></div>` : ''}</div>

    <h3>Account actions</h3>${open ? `<form id="aForm" class="row wrap">
      <label for="aKind">Action</label><select id="aKind" style="max-width:200px">
        <option value="mute" ${lockIf(c, 'accounts.mute')}>Mute in chat</option><option value="warn" ${lockIf(c, 'accounts.mute')}>Warn (shown at next visit)</option>
        <option value="bet_ban" ${lockIf(c, 'accounts.ban')}>Ban from betting</option><option value="site_ban" ${lockIf(c, 'accounts.ban')}>Ban from the site</option></select>
      <label for="aDur">For</label><select id="aDur" style="max-width:150px">${DURATIONS.map(([l, m], i) => `<option value="${i}" ${m === 1440 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label for="aMsg">Message to the player</label><input id="aMsg" maxlength="300" placeholder="Required for a warning" style="max-width:340px">
      <button class="btn danger">Apply…</button></form>
      <p class="muted small">A betting ban stops every game; a site ban also stops rewards and chat, signs the player out and refuses new sign-ins until it ends. Staff of your rank or above cannot be acted on.</p>
      <div class="row wrap"><button class="btn ghost" id="aOut" ${lockIf(c, 'accounts.signout')}>Force sign-out</button><button class="btn ghost" id="aRename" ${lockIf(c, 'accounts.rename')}>Rename…</button>
        ${p.claims.map(x => `<button class="btn ghost" data-claim="${esc(x.kind)}" ${lockIf(c, 'rewards.edit')}>Reset ${esc(x.kind === 'welcome' ? 'welcome crate' : 'daily crate')}</button>`).join('')}
        <button class="btn danger" id="aClose" ${lockIf(c, 'accounts.close')}>Close account…</button></div>` : `<p class="muted">This account was closed ${esc(when(me.closed_at))}.</p>`}

    <h3>Restrictions and warnings</h3><div class="tablewrap"><table class="grid"><thead><tr><th>What</th><th>Until</th><th>Reason</th><th>By</th><th></th></tr></thead><tbody>${p.flags.map(f => `<tr>
      <td>${esc(FLAG_LABEL[f.kind])}${f.message ? `<br><span class="muted small">"${esc(f.message)}"</span>` : ''}${f.kind === 'warn' ? `<br><span class="muted small">${f.seen_at ? `read ${esc(when(f.seen_at))}` : 'not read yet'}</span>` : ''}</td>
      <td>${f.lifted_at ? `<span class="muted small">lifted ${esc(when(f.lifted_at))}: ${esc(f.lift_reason ?? '')}</span>` : f.until ? esc(when(f.until)) + (f.active ? '' : ' <span class="muted small">(ended)</span>') : f.kind === 'warn' ? '' : 'until lifted'}</td>
      <td>${esc(f.reason)}</td><td class="muted small">${esc(f.by ?? '')}<br>${esc(when(f.at))}</td>
      <td>${f.active && !f.lifted_at ? `<button class="btn ghost" data-lift="${f.id}" ${lockIf(c, f.kind === 'mute' || f.kind === 'warn' ? 'accounts.mute' : 'accounts.ban')}>Lift…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>'}</tbody></table></div>

    <h3>Tags</h3><div class="row wrap">${TAGS.map(t => `<label class="chk"><input type="checkbox" data-tag="${t}" ${p.tags.includes(t) ? 'checked' : ''} ${lockIf(c, 'players.tags')}> ${t}</label>`).join('')}</div>
    <h3>Notes from staff</h3>${can(c, 'players.notes') ? '<form id="nForm" class="row"><label class="sr" for="nBody">New note</label><input id="nBody" maxlength="1000" placeholder="Write a note other staff will see"><button class="btn">Add note</button></form>' : ''}
    <ul class="notes">${p.notes.map(n => `<li><b>${esc(n.author ?? 'staff')}</b> <span class="muted small">${esc(when(n.at))}</span><br>${esc(n.body)}</li>`).join('') || '<li class="muted">No notes.</li>'}</ul>
    ${p.chat ? `<h3>Recent chat</h3><div class="tablewrap"><table class="grid"><tbody>${p.chat.map(m => `<tr><td class="muted small">${esc(when(m.at))}</td><td>${m.removed_at ? '<i class="muted">removed</i>' : esc(m.body)}</td></tr>`).join('') || '<tr><td class="muted">No messages.</td></tr>'}</tbody></table></div>` : ''}
    ${p.bets ? `<h3>Recent bets</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Time</th><th>Game</th><th>Stake</th><th>Paid back</th></tr></thead><tbody>${p.bets.map(b => `<tr><td class="muted small">${esc(when(b.at))}</td><td>${esc(b.game)}</td><td>${coins(b.amount)}</td><td>${coins(b.payout)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No bets.</td></tr>'}</tbody></table></div>` : ''}
    ${p.actions ? `<h3>Staff actions on this player</h3><div class="tablewrap"><table class="grid"><tbody>${p.actions.map(a => `<tr><td class="muted small">${esc(when(a.at))}</td><td><code>${esc(a.action)}</code></td><td>${esc(a.actor ?? '')}</td><td>${esc(a.reason ?? '')}</td></tr>`).join('') || '<tr><td class="muted">None.</td></tr>'}</tbody></table></div>` : ''}
  </section>`;
  box.querySelector('h2')?.scrollIntoView({ block: 'start' });

  const form = $<HTMLFormElement>('#aForm', box);
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const kind = $<HTMLSelectElement>('#aKind', box).value as FlagKind, dur = DURATIONS[+$<HTMLSelectElement>('#aDur', box).value] as [string, number | null], msg = $<HTMLInputElement>('#aMsg', box).value.trim();
    if (kind === 'warn' && !msg) { c.toast('Write the message the player will see.', 'error'); return; }
    const lasting = kind === 'warn' ? '' : ` for ${dur[0].toLowerCase()}`;
    if (await act(c, `${FLAG_LABEL[kind]}: ${me.name}${lasting}?`, kind === 'site_ban' ? 'They are signed out and cannot sign in, play, claim or chat until it ends.' : kind === 'bet_ban' ? 'Every game refuses their bets until it ends.' : kind === 'mute' ? 'Their chat messages are refused until it ends.' : 'They see your message the next time they open the site.', 'Apply',
      r => c.api.flag(id, kind, kind === 'warn' ? null : dur[1], msg, r))) await reload();
  };
  $('#aOut', box)?.addEventListener('click', async () => { if (await act(c, `Sign ${me.name} out everywhere?`, 'Every open session ends; they can sign in again unless banned.', 'Sign out', r => c.api.signOutPlayer(id, r))) await reload(); });
  $('#aRename', box)?.addEventListener('click', async () => {
    const name = window.prompt(`New name for ${me.name} (2 to 20 letters, numbers, spaces, - or _)`, ''); if (!name) return;
    if (await act(c, `Rename ${me.name} to ${name}?`, 'Old chat messages keep the old name.', 'Rename', r => c.api.rename(id, name.trim(), r))) await reload();
  });
  $$('[data-claim]', box).forEach(b => b.addEventListener('click', async () => {
    const kind = b.dataset['claim'] as string;
    if (await act(c, `Reset ${me.name}'s ${kind === 'welcome' ? 'welcome' : 'daily'} crate?`, 'They can claim it again.', 'Reset', r => c.api.resetClaim(id, kind, r))) await reload();
  }));
  $('#aClose', box)?.addEventListener('click', async () => {
    const typed = window.prompt(`Closing anonymises ${me.name}'s account, removes their coins and chat, and blocks their sign-in. It cannot be undone. Type their name to confirm:`, ''); if (typed === null) return;
    if (await act(c, `Close ${me.name}'s account for good?`, 'This cannot be undone.', 'Close account', r => c.api.closeAccount(id, typed, r), 'Account closed')) await reload();
  });
  $$('[data-lift]', box).forEach(b => b.addEventListener('click', async () => { if (await act(c, 'Lift this restriction?', 'It ends now.', 'Lift', r => c.api.liftFlag(+(b.dataset['lift'] as string), r), 'Lifted')) await reload(); }));
  $$<HTMLInputElement>('input[data-tag]', box).forEach(x => x.onchange = async () => {
    try { await c.api.tag(id, x.dataset['tag'] as string, x.checked); c.toast('Saved', 'ok'); onChange(); } catch (e) { x.checked = !x.checked; c.toast(errorText(e), 'error'); }
  });
  const nf = $<HTMLFormElement>('#nForm', box);
  if (nf) nf.onsubmit = async e => {
    e.preventDefault(); const body = $<HTMLInputElement>('#nBody', box).value.trim(); if (!body) return;
    try { await c.api.note(id, body); c.toast('Note added', 'ok'); await openPlayer(c, box, id, onChange); } catch (er) { c.toast(errorText(er), 'error'); }
  };
}

// ============================================================================ Chat
const chat: Page = {
  title: 'Chat', perm: 'chat.view',
  async render(el, c) {
    let tab: 'live' | 'reports' | 'done' = 'live', msgs: ChatMsg[] = [], settings: ChatSettings, reports: ChatReport[] = [], q = '';
    el.innerHTML = `<p class="muted">The live English room. Removing a message replaces it with "message removed" for everyone at once; the original stays in the audit log. Staff are never limited by the rules below.</p>
      <section class="block" id="cSet"></section>
      <section class="block"><h2>Post as staff</h2><form id="cPost" class="row"><label class="sr" for="cBody">Staff message</label><input id="cBody" maxlength="140" placeholder="Shown with a staff badge" ${lockIf(c, 'chat.post')}><button class="btn" ${lockIf(c, 'chat.post')}>Post</button></form></section>
      <div class="row wrap"><button class="btn" data-tab="live">Messages</button><button class="btn ghost" data-tab="reports">Open reports</button><button class="btn ghost" data-tab="done">Handled reports</button>
        <form id="cFind" class="row"><label class="sr" for="cq">Search</label><input id="cq" placeholder="Search text or name" style="max-width:220px"><button class="btn ghost">Search</button></form>
        <button class="btn danger" id="cClear" ${lockIf(c, 'chat.delete')}>Clear recent…</button></div>
      <div id="cList"></div>`;
    const drawSettings = (): void => {
      const s = settings;
      $('#cSet', el).innerHTML = `<h2>Room rules ${s.locked ? '<span class="pill warn">LOCKED</span>' : '<span class="pill done">open</span>'}</h2>
        <div class="row wrap"><label class="chk"><input type="checkbox" id="sLock" ${s.locked ? 'checked' : ''} ${lockIf(c, 'chat.settings')}> Lock the room (only staff can write)</label>
          <label class="chk"><input type="checkbox" id="sLinks" ${s.links_allowed ? '' : 'checked'} ${lockIf(c, 'chat.settings')}> Block links</label>
          <label for="sSlow">Slow mode: one message per</label><select id="sSlow" style="max-width:140px" ${lockIf(c, 'chat.settings')}>${[0, 5, 10, 30, 60, 120, 300].map(v => `<option value="${v}" ${v === s.slow_seconds ? 'selected' : ''}>${v ? `${v} seconds` : 'off'}</option>`).join('')}</select></div>
        <label for="sWords">Blocked words (separated by commas; a message containing one is refused)</label><input id="sWords" value="${esc(s.blocked_words.join(', '))}" ${lockIf(c, 'chat.settings')}>
        <div class="row"><button class="btn" id="sSave" ${lockIf(c, 'chat.settings')}>Save rules…</button>${s.pinned_id ? `<span class="muted small">A message is pinned.</span><button class="btn ghost" id="sUnpin" ${lockIf(c, 'chat.post')}>Unpin</button>` : ''}</div>`;
      $('#sSave', el)?.addEventListener('click', async () => {
        const words = $<HTMLInputElement>('#sWords', el).value.split(',').map(w => w.trim()).filter(Boolean);
        const locked = $<HTMLInputElement>('#sLock', el).checked, links = !$<HTMLInputElement>('#sLinks', el).checked, slow = +$<HTMLSelectElement>('#sSlow', el).value;
        if (await act(c, 'Save the chat rules?', `${locked ? 'The room is locked. ' : ''}${slow ? `One message per ${slow} s. ` : ''}${links ? '' : 'Links blocked. '}${words.length} blocked words.`, 'Save', async r => { settings = await c.api.chatSettings(slow, locked, links, words, r); })) drawSettings();
      });
      $('#sUnpin', el)?.addEventListener('click', async () => { if (await act(c, 'Unpin the message?', 'It stays in the chat, just not on top.', 'Unpin', r => c.api.chatPin(null, r))) { settings.pinned_id = null; drawSettings(); } });
    };
    const drawList = (): void => {
      const box = $('#cList', el);
      $$('[data-tab]', el).forEach(b => b.classList.toggle('ghost', b.dataset['tab'] !== tab));
      if (tab === 'live') {
        box.innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Time</th><th>Player</th><th>Message</th><th></th></tr></thead><tbody>${msgs.map(m => `<tr data-m="${m.id}">
          <td class="muted small">${esc(when(m.at))}</td><td><a href="#/players?id=${esc(m.user_id)}">${esc(m.name)}</a>${m.is_staff ? ' <span class="pill partial">staff</span>' : ''}</td>
          <td>${m.removed_at ? `<i class="muted">removed${m.removed_by ? ` by ${esc(m.removed_by)}` : ''}</i>` : esc(m.body)}${m.reports ? ` <span class="pill warn">${m.reports} report${m.reports === 1 ? '' : 's'}</span>` : ''}${settings.pinned_id === m.id ? ' <span class="pill next">pinned</span>' : ''}</td>
          <td class="nowrap">${m.removed_at ? '' : `<button class="btn ghost" data-rm ${lockIf(c, 'chat.delete')}>Remove</button> <button class="btn ghost" data-pin ${lockIf(c, 'chat.post')}>Pin</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No messages.</td></tr>'}</tbody></table></div>
          ${msgs.length >= 100 ? '<p><button class="btn ghost" id="cMore">Load older</button></p>' : ''}`;
        $$('tr[data-m]', box).forEach(tr => {
          const id = +(tr.dataset['m'] as string), m = msgs.find(x => x.id === id) as ChatMsg;
          $('[data-rm]', tr)?.addEventListener('click', async () => { if (await act(c, `Remove ${m.name}'s message?`, `"${m.body}"`, 'Remove', r => c.api.chatRemove(id, r), 'Removed')) await loadMsgs(); });
          $('[data-pin]', tr)?.addEventListener('click', async () => { if (await act(c, 'Pin this message?', `"${m.body}" shows on top of the chat for everyone.`, 'Pin', r => c.api.chatPin(id, r), 'Pinned')) { settings.pinned_id = id; drawSettings(); drawList(); } });
        });
        $('#cMore', box)?.addEventListener('click', async () => { const got = await c.api.chat({ before: msgs[msgs.length - 1]?.id, q }); msgs = [...msgs, ...got.messages]; drawList(); });
      } else {
        box.innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Reported</th><th>Message</th><th>Reported by</th><th></th></tr></thead><tbody>${reports.map(r => `<tr data-r="${r.id}">
          <td class="muted small">${esc(when(r.at))}</td><td><a href="#/players?id=${esc(r.author_id)}">${esc(r.author)}</a>: ${r.removed ? '<i class="muted">removed</i>' : esc(r.body)}</td>
          <td>${esc(r.reporter ?? '')}${r.reason ? `<br><span class="muted small">${esc(r.reason)}</span>` : ''}</td>
          <td class="nowrap">${tab === 'reports' ? `<button class="btn danger" data-rm ${lockIf(c, 'chat.delete')}>Remove message</button> <button class="btn ghost" data-ok ${lockIf(c, 'chat.delete')}>Dismiss</button>` : `<span class="muted small">${esc(r.outcome ?? '')} ${esc(when(r.resolved_at))}</span>`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing here.</td></tr>'}</tbody></table></div>`;
        $$('tr[data-r]', box).forEach(tr => {
          const r = reports.find(x => x.id === +(tr.dataset['r'] as string)) as ChatReport;
          $('[data-rm]', tr)?.addEventListener('click', async () => { if (await act(c, `Remove ${r.author}'s message?`, `"${r.body}"`, 'Remove', x => c.api.chatRemove(r.message_id, x), 'Removed')) await loadReports(); });
          $('[data-ok]', tr)?.addEventListener('click', async () => { if (await act(c, 'Dismiss this report?', 'The message stays.', 'Dismiss', x => c.api.chatDismiss(r.id, x), 'Dismissed')) await loadReports(); });
        });
      }
    };
    const loadMsgs = async (): Promise<void> => { const got = await c.api.chat({ q }); msgs = got.messages; settings = got.settings; drawSettings(); drawList(); };
    const loadReports = async (): Promise<void> => { reports = await c.api.chatReports(tab === 'reports'); drawList(); };
    $$('[data-tab]', el).forEach(b => b.addEventListener('click', () => { tab = b.dataset['tab'] as typeof tab; void (tab === 'live' ? loadMsgs() : loadReports()).catch(e => c.toast(errorText(e), 'error')); }));
    $<HTMLFormElement>('#cFind', el).onsubmit = e => { e.preventDefault(); q = $<HTMLInputElement>('#cq', el).value.trim(); tab = 'live'; void loadMsgs().catch(er => c.toast(errorText(er), 'error')); };
    $<HTMLFormElement>('#cPost', el).onsubmit = async e => {
      e.preventDefault(); const body = $<HTMLInputElement>('#cBody', el).value.trim(); if (!body) return;
      try { await c.api.chatPost(body); $<HTMLInputElement>('#cBody', el).value = ''; c.toast('Posted', 'ok'); if (tab === 'live') await loadMsgs(); } catch (er) { c.toast(errorText(er), 'error'); }
    };
    $('#cClear', el).addEventListener('click', async () => {
      const m = window.prompt('Remove every message of the last how many minutes? (1 to 1440)', '10'); if (!m) return;
      const minutes = Math.round(+m); if (!(minutes >= 1 && minutes <= 1440)) { c.toast('Enter 1 to 1440 minutes.', 'error'); return; }
      if (await act(c, `Clear the last ${minutes} minutes of chat?`, 'Every message in that time is replaced with "message removed".', 'Clear', r => c.api.chatClear(minutes, r), 'Cleared')) await loadMsgs();
    });
    await loadMsgs();
  },
};

// ============================================================================ Live rooms
const rooms: Page = {
  title: 'Live rooms', perm: 'rooms.view',
  async render(el, c) {
    let kind: 'battles' | 'coinflips' = 'battles', status = 'waiting';
    el.innerHTML = `<p class="muted">Every case battle and coinflip between real players. Cancelling a lobby nobody has started gives every stake back. "Suspicious" and "void" are records for later (for example collusion between two accounts): no coins move; correct coins on the Wallets page if needed. Lobbies waiting longer than 30 minutes are refunded by the database on their own.</p>
      <div class="row wrap"><button class="btn" data-k="battles">Battles</button><button class="btn ghost" data-k="coinflips">Coinflips</button>
        <label for="rSt">Show</label><select id="rSt" style="max-width:200px"><option value="waiting">Waiting</option><option value="">All recent</option><option value="cancelled">Cancelled</option></select></div><div id="rList"></div>`;
    const flagCell = (f: { flag: string; reason: string }[]): string => f.map(x => `<span class="pill warn" title="${esc(x.reason)}">${esc(x.flag)}</span>`).join(' ');
    const actions = (k: 'battle' | 'coinflip', id: string, waiting: boolean): string => `${waiting ? `<button class="btn ghost" data-cancel="${esc(id)}" data-kind="${k}" ${lockIf(c, 'rooms.cancel')}>Cancel and refund</button> ` : ''}<button class="btn ghost" data-flag="${esc(id)}" data-kind="${k}" data-f="suspicious" ${lockIf(c, 'rooms.cancel')}>Suspicious</button> <button class="btn ghost" data-flag="${esc(id)}" data-kind="${k}" data-f="void" ${lockIf(c, 'rooms.void')}>Void</button>`;
    const load = async (): Promise<void> => {
      $$('[data-k]', el).forEach(b => b.classList.toggle('ghost', b.dataset['k'] !== kind));
      const box = $('#rList', el); box.innerHTML = '<p class="muted">Loading…</p>';
      const st = status || undefined;
      if (kind === 'battles') {
        const list: BattleRoom[] = await c.api.battles(st);
        box.innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Created</th><th>Battle</th><th>Seats</th><th>Stake each</th><th>Status</th><th></th></tr></thead><tbody>${list.map(b => `<tr>
          <td class="muted small">${esc(when(b.created_at))}<br>${esc(ago(b.created_at))}</td><td>${esc(b.format)} ${esc(b.mode)}<br><span class="muted small">${esc(b.cases.join(', '))}</span></td>
          <td>${b.seats.map(s => (s ? `${esc(s.name)}${s.bot ? ' <span class="muted small">(bot)</span>' : ''}` : '<span class="muted">empty</span>')).join('<br>')}</td><td>${coins(b.cost)}</td>
          <td><span class="pill ${b.status === 'waiting' ? (b.stuck ? 'warn' : 'next') : b.status === 'running' ? 'done' : 'later'}">${esc(b.stuck ? 'stuck' : b.status === 'running' ? 'played' : b.status)}</span> ${flagCell(b.flags)}${b.seed ? `<br><span class="muted small">seed <code>${esc(b.seed.slice(0, 12))}…</code></span>` : ''}</td>
          <td class="nowrap">${actions('battle', b.id, b.status === 'waiting')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None.</td></tr>'}</tbody></table></div>`;
      } else {
        const list: FlipRoom[] = await c.api.coinflips(st);
        box.innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Created</th><th>Players</th><th>Stake</th><th>Result</th><th>Status</th><th></th></tr></thead><tbody>${list.map(f => `<tr>
          <td class="muted small">#${f.id} ${esc(when(f.created_at))}<br>${esc(ago(f.created_at))}</td><td>${esc(f.creator)} (${esc(f.side)})<br>${f.joiner ? esc(f.joiner) : f.bot ? '<span class="muted">bot</span>' : '<span class="muted">waiting</span>'}</td>
          <td>${coins(f.amount)}</td><td>${f.result ? `${esc(f.result)}, ${esc(f.winner ?? '')} won` : ''}</td>
          <td><span class="pill ${f.status === 'waiting' ? (f.stuck ? 'warn' : 'next') : f.status === 'done' ? 'done' : 'later'}">${esc(f.stuck ? 'stuck' : f.status)}</span> ${flagCell(f.flags)}</td>
          <td class="nowrap">${actions('coinflip', String(f.id), f.status === 'waiting')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None.</td></tr>'}</tbody></table></div>`;
      }
      $$('[data-cancel]', box).forEach(b => b.addEventListener('click', async () => {
        const k = b.dataset['kind'] as 'battle' | 'coinflip';
        if (await act(c, `Cancel this ${k}?`, 'Every player in it gets their stake back.', 'Cancel and refund', r => c.api.roomCancel(k, b.dataset['cancel'] as string, r), 'Cancelled and refunded')) await load();
      }));
      $$('[data-flag]', box).forEach(b => b.addEventListener('click', async () => {
        const k = b.dataset['kind'] as 'battle' | 'coinflip', f = b.dataset['f'] as 'suspicious' | 'void';
        if (await act(c, `Mark this ${k} ${f}?`, 'A record only: no coins move.', 'Mark', r => c.api.roomFlag(k, b.dataset['flag'] as string, f, r), 'Marked')) await load();
      }));
    };
    $$('[data-k]', el).forEach(b => b.addEventListener('click', () => { kind = b.dataset['k'] as typeof kind; void load().catch(e => c.toast(errorText(e), 'error')); }));
    $<HTMLSelectElement>('#rSt', el).onchange = () => { status = $<HTMLSelectElement>('#rSt', el).value; void load().catch(e => c.toast(errorText(e), 'error')); };
    await load();
  },
};

// ============================================================================ Rounds
const rounds: Page = {
  title: 'Rounds', perm: 'rounds.view',
  async render(el, c) {
    let game: 'crash' | 'double' = 'crash', list: RoundRow[] = [];
    const controls = can(c, 'dashboard.view') ? await c.api.controls().catch(() => null) : null;
    el.innerHTML = `<p class="muted">The shared Crash and Double rounds. A round's seed is secret until it finishes; the Crash point of a running round is never shown here. "Check" recomputes a finished round from its seed and compares it with the published hash and the recorded result. Pausing a game lets the current round finish and refuses new bets.</p>
      <div class="row wrap"><button class="btn" data-g="crash">Crash</button><button class="btn ghost" data-g="double">Double</button><span id="gState"></span></div><div id="gList"></div><div id="gBets"></div>`;
    const drawState = (): void => {
      const off = !!controls?.games_off.includes(game);
      $('#gState', el).innerHTML = controls ? `<span class="pill ${off ? 'warn' : 'done'}">${off ? 'paused' : 'running'}</span> <button class="btn ${off ? '' : 'danger'}" id="gPause" ${lockIf(c, 'site.games')}>${off ? 'Resume' : 'Pause'} ${game === 'crash' ? 'Crash' : 'Double'}…</button>` : '';
      $('#gPause', el)?.addEventListener('click', async () => {
        await act(c, `${off ? 'Resume' : 'Pause'} ${game}?`, off ? 'New rounds take bets again.' : 'The current round finishes; new bets are refused.', off ? 'Resume' : 'Pause', async r => { const k = await c.api.setGame(game, !off, r); if (controls) controls.games_off = k.games_off; });
        drawState();
      });
    };
    const showResult = (r: RoundRow): string => (r.result ? (game === 'crash' ? (r.result.point !== undefined ? `${r.result.point}×` : '') : r.result.n !== undefined ? `tile ${r.result.n}` : '') : '');
    const drawList = (): void => {
      $$('[data-g]', el).forEach(b => b.classList.toggle('ghost', b.dataset['g'] !== game));
      $('#gList', el).innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Round</th><th>Status</th><th>Result</th><th>Bets</th><th>Staked / paid</th><th></th></tr></thead><tbody>${list.map(r => `<tr data-r="${r.id}">
        <td>#${r.id}<br><span class="muted small">${esc(when(r.created_at))}</span></td><td><span class="pill ${r.status === 'finished' ? 'done' : 'next'}">${esc(r.status)}</span> ${r.flags.map(f => `<span class="pill warn" title="${esc(f.reason)}">${esc(f.flag)}</span>`).join(' ')}</td>
        <td>${esc(showResult(r))}</td><td>${r.bets}</td><td>${coins(r.staked)}${r.paid === null ? '' : ` / ${coins(r.paid)}`}</td>
        <td class="nowrap"><button class="btn ghost" data-bets>Bets</button>${r.status === 'finished' ? ` <button class="btn ghost" data-check>Check</button> <button class="btn ghost" data-void ${lockIf(c, 'rounds.void')}>Void…</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rounds yet.</td></tr>'}</tbody></table></div>
        ${list.length >= 30 ? '<p><button class="btn ghost" id="gMore">Load older</button></p>' : ''}`;
      $$('tr[data-r]', el).forEach(tr => {
        const id = +(tr.dataset['r'] as string);
        $('[data-bets]', tr).addEventListener('click', async () => {
          const bets: RoundBet[] = await c.api.roundBets(id).catch(e => { c.toast(errorText(e), 'error'); return []; });
          $('#gBets', el).innerHTML = `<section class="block"><h2>Bets in round #${id}</h2><div class="tablewrap"><table class="grid"><thead><tr><th>Player</th><th>${game === 'crash' ? 'Auto cash-out' : 'Colour'}</th><th>Stake</th><th>Paid</th></tr></thead><tbody>${bets.map(b => `<tr>
            <td><a href="#/players?id=${esc(b.user_id)}">${esc(b.name)}</a></td><td>${game === 'crash' ? (b.auto_cashout ? `${b.auto_cashout}×` : '') + (b.cashouts.length ? ` <span class="muted small">cashed out at ${esc(b.cashouts.join(', '))}×</span>` : '') : esc(b.lane)}</td>
            <td>${coins(b.amount)}</td><td>${b.done ? coins(b.paid) : '<span class="muted">open</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No bets.</td></tr>'}</tbody></table></div></section>`;
          $('#gBets', el).scrollIntoView({ block: 'nearest' });
        });
        $('[data-check]', tr)?.addEventListener('click', async () => {
          try { const v = await c.api.roundVerify(id); c.toast(v.hash_ok && v.result_ok ? `Round #${id} checks out: the seed matches its hash and gives the recorded result.` : `Round #${id} does NOT check out (hash ${v.hash_ok ? 'ok' : 'wrong'}, result ${v.result_ok ? 'ok' : 'different'}).`, v.hash_ok && v.result_ok ? 'ok' : 'error'); }
          catch (e) { c.toast(errorText(e), 'error'); }
        });
        $('[data-void]', tr)?.addEventListener('click', async () => { if (await act(c, `Mark round #${id} void?`, 'A record only: no coins move. Correct coins on the Wallets page if needed.', 'Mark void', r => c.api.roomFlag('round', String(id), 'void', r), 'Marked')) await load(); });
      });
      $('#gMore', el)?.addEventListener('click', async () => { const got = await c.api.rounds(game, list[list.length - 1]?.id); list = [...list, ...got]; drawList(); });
    };
    const load = async (): Promise<void> => { list = await c.api.rounds(game); $('#gBets', el).innerHTML = ''; drawState(); drawList(); };
    $$('[data-g]', el).forEach(b => b.addEventListener('click', () => { game = b.dataset['g'] as typeof game; void load().catch(e => c.toast(errorText(e), 'error')); }));
    await load();
  },
};

export const CONTROL_PAGES: Record<string, Page> = { dashboard, players, chat, rooms, rounds };
