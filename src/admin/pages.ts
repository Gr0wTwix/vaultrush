// The pages of the admin panel that exist so far (step A of the plan). The other modules are listed on the "Coming next" page.
import type { AdminApi, AuditRow, Controls, Status } from './api.js';
import { errorText } from './api.js';
import { $, $$, esc, reasonDialog, when } from './dom.js';

export interface PageCtx { api: AdminApi; status: Status; perms: string[]; toast: (m: string, k?: 'info' | 'ok' | 'error') => void; reload: () => void; lock: () => Promise<void> }
export interface Page { title: string; perm?: string; render(el: HTMLElement, c: PageCtx): Promise<void> }

/** The whole plan, in order (docs/admin-panel-proposal-2026-11-21.md). */
export const ROADMAP: { step: string; title: string; items: string; state: 'done' | 'partial' | 'next' | 'later' }[] = [
  { step: 'A', title: 'Admin site, roles, permissions, audit log, explorer', items: 'This site: three-step sign-in, staff roles, editable permissions, audit log, read-only data explorer', state: 'done' },
  { step: 'B', title: 'Control and visibility', items: 'Built: site controls (maintenance, notice, game switches, sign-ups, country restrictions). Still to build: dashboard, players, account actions, chat moderation (English room), live rooms, round control', state: 'partial' },
  { step: 'C', title: 'Catalogue in the database', items: 'Cases, items and odds you can add, edit and delete here', state: 'later' },
  { step: 'D', title: 'Full server wallet', items: 'All coins in the database, every game rewritten around it, everyone starts at 0, owner wallet adjustments, bets and ledger viewer', state: 'later' },
  { step: 'E', title: 'Rewards and operations', items: 'Promo codes, free crates, races, rain, giveaways, game configuration, bots, in-app announcements', state: 'later' },
  { step: 'F', title: 'Compliance, fairness, economy, risk, analytics', items: 'Verification queues, responsible-play enforcement, fairness audit, economy monitor, risk signals with IP and device marker, reports', state: 'later' },
  { step: 'G', title: 'Legal, system health, developer tools', items: 'Legal pages editor and privacy requests, system health, developer and test tools', state: 'later' },
];

const group = <T,>(xs: T[], key: (x: T) => string): [string, T[]][] => { const m = new Map<string, T[]>(); for (const x of xs) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); } return [...m.entries()]; };

export const PAGES: Record<string, Page> = {
  overview: {
    title: 'Overview',
    async render(el, c) {
      const s = c.status;
      el.innerHTML = `<div class="cards">
        <div class="card"><span class="muted small">Your role</span><b>${esc(s.label)}</b><span class="muted small">Rank ${esc(s.rank)}${s.role === 'owner' ? ' (cannot be restricted)' : ''}</span></div>
        <div class="card"><span class="muted small">Permissions you hold</span><b>${c.perms.length}</b><span class="muted small">${s.role === 'owner' ? 'all of them, including future ones' : 'set by a higher rank'}</span></div>
        <div class="card"><span class="muted small">Security</span><b>3 of 3 steps</b><span class="muted small">Steam, authenticator, admin password</span></div>
        <div class="card"><span class="muted small">Session</span><b>${esc(when(s.expires_at))}</b><span class="muted small">locks after 30 idle minutes</span></div></div>
        <h2>Plan</h2><table class="grid"><thead><tr><th>Step</th><th>What</th><th>Status</th></tr></thead><tbody>${ROADMAP.map(r => `<tr><td>${esc(r.step)}</td><td><b>${esc(r.title)}</b><br><span class="muted small">${esc(r.items)}</span></td><td><span class="pill ${r.state}">${r.state === 'done' ? 'built' : r.state === 'partial' ? 'in progress' : r.state === 'next' ? 'next' : 'later'}</span></td></tr>`).join('')}</tbody></table>
        <p class="muted small">Everything you do here is written to the audit log with your name, the time and a reason. The log cannot be edited or deleted.</p>`;
    },
  },

  site: {
    title: 'Site controls', perm: 'dashboard.view',
    async render(el, c) {
      const NAMES: Record<string, string> = { cases: 'Cases', battles: 'Battles', upgrade: 'Upgrade', crash: 'Crash', double: 'Double', plinko: 'Plinko', mines: 'Mines', coinflip: 'Coinflip' };
      const SERVER: string[] = ['battles', 'coinflip', 'crash', 'double'];                   // enforced by the database; the rest run in the browser until the full wallet (step D)
      const can = (p: string): boolean => c.perms.includes(p);
      const draw = (k: Controls): void => {
        const act = async (title: string, detail: string, label: string, run: (reason: string) => Promise<Controls>): Promise<void> => {
          const reason = await reasonDialog(title, detail, label); if (!reason) return;
          try { k = await run(reason); c.toast('Saved', 'ok'); draw(k); } catch (e) { c.toast(errorText(e), 'error'); }
        };
        const lock = (p: string): string => (can(p) ? '' : 'disabled title="You do not hold this permission"');
        el.innerHTML = `<p class="muted">These switches change the live game site for <b>everyone, at once</b>. Every change asks for a reason and is written to the audit log. Staff are never blocked by maintenance or country rules, so you can always get back in. ${k.updated_by ? `Last change by <b>${esc(k.updated_by)}</b>, ${esc(when(k.updated_at))}.` : ''}</p>
          <section class="block"><h2>Maintenance <span class="pill ${k.maintenance_on ? 'warn' : 'done'}">${k.maintenance_on ? 'ON' : 'off'}</span></h2>
            <p class="muted small">Turning it on gives players on the site one minute of warning, then covers the page with your message. New games, bets and sign-ups are refused by the database too. Leaving a game and cashing out stay open.</p>
            <label for="mMsg">Message shown to players (optional, up to 200 characters)</label><textarea id="mMsg" rows="2" maxlength="200" ${lock('site.maintenance')}>${esc(k.maintenance_message)}</textarea>
            <div class="row">${k.maintenance_on ? `<button class="btn" id="mOff" ${lock('site.maintenance')}>Turn maintenance off</button><button class="btn ghost" id="mMsgSave" ${lock('site.maintenance')}>Update message</button>` : `<button class="btn danger" id="mOn" ${lock('site.maintenance')}>Turn maintenance on</button>`}</div></section>
          <section class="block"><h2>Site notice <span class="pill ${k.notice_on ? 'warn' : 'done'}">${k.notice_on ? 'showing' : 'hidden'}</span></h2>
            <p class="muted small">A bar under the top menu, visible to everyone. Does not stop anyone from playing.</p>
            <label for="nTxt">Text (up to 300 characters)</label><input id="nTxt" maxlength="300" value="${esc(k.notice_text)}" ${lock('site.notice')}>
            <div class="row"><label for="nKind">Style</label><select id="nKind" ${lock('site.notice')}><option value="info" ${k.notice_kind === 'info' ? 'selected' : ''}>Information</option><option value="warn" ${k.notice_kind === 'warn' ? 'selected' : ''}>Warning</option></select>
              <button class="btn" id="nShow" ${lock('site.notice')}>${k.notice_on ? 'Update notice' : 'Show notice'}</button>${k.notice_on ? `<button class="btn ghost" id="nHide" ${lock('site.notice')}>Hide notice</button>` : ''}</div></section>
          <section class="block"><h2>Games</h2>
            <p class="muted small">A paused game shows a "paused" page and refuses new bets. Players can always cancel or cash out what they already have. Games marked <b>browser</b> run on the player's own device until the full server wallet exists (step D): pausing them hides the page, but a determined player could still reach them.</p>
            <div class="tablewrap"><table class="grid"><thead><tr><th>Game</th><th>Enforced by</th><th>State</th><th></th></tr></thead><tbody>${k.games.map(g => {
              const off = k.games_off.includes(g);
              return `<tr data-g="${esc(g)}"><td>${esc(NAMES[g] ?? g)}</td><td>${SERVER.includes(g) ? 'database' : 'browser'}</td><td><span class="pill ${off ? 'warn' : 'done'}">${off ? 'paused' : 'on'}</span></td><td><button class="btn ${off ? '' : 'ghost'}" data-game ${lock('site.games')}>${off ? 'Resume' : 'Pause'}</button></td></tr>`;
            }).join('')}</tbody></table></div></section>
          <section class="block"><h2>Sign-ups <span class="pill ${k.signups_open ? 'done' : 'warn'}">${k.signups_open ? 'open' : 'closed'}</span></h2>
            <p class="muted small">Closed means no new accounts. Existing players can still log in and play.</p>
            <div class="row"><button class="btn ${k.signups_open ? 'danger' : ''}" id="sBtn" ${lock('site.signups')}>${k.signups_open ? 'Close sign-ups' : 'Open sign-ups'}</button></div></section>
          <section class="block"><h2>Country restrictions <span class="pill ${k.blocked_countries.length ? 'warn' : 'done'}">${k.blocked_countries.length ? k.blocked_countries.length + ' blocked' : 'none'}</span></h2>
            <p class="muted small">Players connecting from a listed country see a "not available" page and cannot start games, claim crates or sign up. The country is taken from the visitor's connection at the moment of the request and compared with this list. <b>Nothing about the visitor's address or country is stored.</b> If the country cannot be determined, the visitor is let in. Staff are never blocked.</p>
            <label for="cList">Two-letter country codes, separated by commas (for example US, GB, DE)</label><input id="cList" value="${esc(k.blocked_countries.join(', '))}" ${lock('site.countries')} autocomplete="off">
            <div class="row"><button class="btn" id="cSave" ${lock('site.countries')}>Save the list</button></div></section>`;
        const val = (id: string): string => ($<HTMLInputElement>('#' + id, el)).value;
        $('#mOn', el)?.addEventListener('click', () => void act('Turn maintenance on?', 'Players get a one-minute warning, then the site closes for them. Staff can still get in.', 'Turn on', r => c.api.setMaintenance(true, val('mMsg'), r)));
        $('#mOff', el)?.addEventListener('click', () => void act('Turn maintenance off?', 'The site opens again for everyone.', 'Turn off', r => c.api.setMaintenance(false, val('mMsg'), r)));
        $('#mMsgSave', el)?.addEventListener('click', () => void act('Update the maintenance message?', 'Players see the new text on their next check (within 30 seconds).', 'Update', r => c.api.setMaintenance(true, val('mMsg'), r)));
        $('#nShow', el)?.addEventListener('click', () => void act(k.notice_on ? 'Update the notice?' : 'Show the notice?', 'Everyone sees it within 30 seconds.', k.notice_on ? 'Update' : 'Show', r => c.api.setNotice(true, val('nTxt'), ($<HTMLSelectElement>('#nKind', el)).value as 'info' | 'warn', r)));
        $('#nHide', el)?.addEventListener('click', () => void act('Hide the notice?', 'The bar disappears for everyone.', 'Hide', r => c.api.setNotice(false, k.notice_text, k.notice_kind, r)));
        $$('tr[data-g]', el).forEach(tr => $('[data-game]', tr)?.addEventListener('click', () => {
          const g = tr.dataset['g'] as string, off = !k.games_off.includes(g);
          void act(`${off ? 'Pause' : 'Resume'} ${NAMES[g] ?? g}?`, off ? 'New bets and games are refused. Cancelling and cashing out stay open.' : 'The game opens again for everyone.', off ? 'Pause' : 'Resume', r => c.api.setGame(g, off, r));
        }));
        $('#sBtn', el)?.addEventListener('click', () => void act(k.signups_open ? 'Close sign-ups?' : 'Open sign-ups?', k.signups_open ? 'Nobody new can register. Existing players are not affected.' : 'Anyone can register again.', k.signups_open ? 'Close' : 'Open', r => c.api.setSignups(!k.signups_open, r)));
        $('#cSave', el)?.addEventListener('click', () => {
          const codes = val('cList').split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
          void act('Save the country list?', codes.length ? `Blocked: ${[...new Set(codes)].sort().join(', ')}. Visitors from there lose access within moments.` : 'No country will be blocked.', 'Save', r => c.api.setCountries(codes, r));
        });
      };
      draw(await c.api.controls());
    },
  },

  staff: {
    title: 'Staff and roles', perm: 'roles.manage',
    async render(el, c) {
      const [admins, matrix, me] = await Promise.all([c.api.listAdmins(), c.api.matrix(), c.api.user()]);
      const myRank = c.status.rank ?? 0;
      const assignable = matrix.roles.filter(r => r.rank < myRank).sort((a, b) => a.rank - b.rank);     // least powerful first, so the default is the safest
      const opt = (cur?: string): string => assignable.map(r => `<option value="${esc(r.role)}" ${r.role === cur ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
      el.innerHTML = `<p class="muted">People with a staff role. Players have no role. You can only change people and roles below your own rank. The Owner role is only given by SQL.</p>
        <table class="grid"><thead><tr><th>Name</th><th>Role</th><th>Since</th><th></th></tr></thead><tbody>${admins.map(a => {
          const can = a.rank < myRank && a.user_id !== me?.id;
          return `<tr data-u="${esc(a.user_id)}"><td>${esc(a.name)}${a.user_id === me?.id ? ' <span class="muted small">(you)</span>' : ''}</td><td>${can ? `<select data-role aria-label="Role of ${esc(a.name)}">${opt(a.role)}</select>` : esc(matrix.roles.find(r => r.role === a.role)?.label ?? a.role)}</td>
            <td>${esc(when(a.granted_at))}</td><td>${can ? '<button class="btn ghost" data-save>Change</button> <button class="btn danger" data-remove>Remove staff role</button>' : '<span class="muted small">locked</span>'}</td></tr>`;
        }).join('')}</tbody></table>
        <h2>Add staff</h2><form id="find" class="row"><label class="sr" for="q">Search players</label><input id="q" placeholder="Search a player by name" minlength="2" required><button class="btn">Search</button></form><div id="found"></div>`;
      const change = async (user: string, role: string | null, name: string): Promise<void> => {
        const reason = await reasonDialog(role ? `Make ${name} ${assignable.find(r => r.role === role)?.label ?? role}?` : `Remove ${name}'s staff role?`, role ? 'They must sign in again with the three steps.' : 'They lose all admin access immediately.', role ? 'Confirm' : 'Remove');
        if (!reason) return;
        try { await c.api.setRole(user, role, reason); c.toast('Saved', 'ok'); c.reload(); } catch (e) { c.toast(errorText(e), 'error'); }
      };
      $$('tr[data-u]', el).forEach(tr => {
        const user = tr.dataset['u'] as string, name = tr.firstElementChild?.textContent?.replace(' (you)', '').trim() ?? '';
        $('[data-save]', tr)?.addEventListener('click', () => void change(user, ($<HTMLSelectElement>('[data-role]', tr)).value, name));
        $('[data-remove]', tr)?.addEventListener('click', () => void change(user, null, name));
      });
      $<HTMLFormElement>('#find', el).onsubmit = async e => {
        e.preventDefault();
        const list = await c.api.findPlayer(($<HTMLInputElement>('#q', el)).value).catch(er => { c.toast(errorText(er), 'error'); return []; });
        $('#found', el).innerHTML = list.length ? `<table class="grid"><tbody>${list.map(p => `<tr data-p="${esc(p.id)}"><td>${esc(p.name)}</td><td class="muted small">joined ${esc(when(p.created_at))}</td><td>${p.role ? esc(p.role) : `<select aria-label="Role for ${esc(p.name)}">${opt()}</select> <button class="btn" data-add>Add</button>`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No player found.</p>';
        $$('tr[data-p]', $('#found', el)).forEach(tr => $('[data-add]', tr)?.addEventListener('click', () => void change(tr.dataset['p'] as string, ($<HTMLSelectElement>('select', tr)).value, tr.firstElementChild?.textContent ?? '')));
      };
    },
  },

  permissions: {
    title: 'Permissions', perm: 'roles.manage',
    async render(el, c) {
      const m = await c.api.matrix(), myRank = c.status.rank ?? 0;
      const held = new Set(c.perms), granted = new Set(m.grants.map(g => `${g.role}:${g.permission}`));
      const roles = m.roles;
      el.innerHTML = `<p class="muted">Every permission is a switch. You can switch permissions for roles <b>below</b> your own rank, and only grant ones you hold yourself. The Owner holds everything and cannot be restricted. <span class="pill warn">sensitive</span> marks powerful permissions. Each change asks for a reason and is logged.</p>
        <div class="tablewrap"><table class="grid matrix"><thead><tr><th>Permission</th>${roles.map(r => `<th scope="col">${esc(r.label)}<br><span class="muted small">rank ${r.rank}</span></th>`).join('')}</tr></thead><tbody>
        ${group(m.permissions, p => p.area).map(([area, ps]) => `<tr class="area"><th colspan="${roles.length + 1}" scope="colgroup">${esc(area)}</th></tr>${ps.map(p => `<tr><th scope="row">${esc(p.label)}${p.sensitive ? ' <span class="pill warn">sensitive</span>' : ''}<br><code class="muted small">${esc(p.key)}</code></th>${roles.map(r => {
          const on = r.role === 'owner' || granted.has(`${r.role}:${p.key}`), fixed = r.rank >= myRank, lacks = !on && !held.has(p.key);
          return `<td class="c"><input type="checkbox" ${on ? 'checked' : ''} ${fixed || lacks ? 'disabled' : ''} data-role="${esc(r.role)}" data-perm="${esc(p.key)}" aria-label="${esc(r.label)}: ${esc(p.label)}" title="${fixed ? 'Same or higher rank than you' : lacks ? 'You do not hold this permission' : ''}"></td>`;
        }).join('')}</tr>`).join('')}`).join('')}</tbody></table></div>`;
      $$<HTMLInputElement>('input[data-perm]', el).forEach(box => box.onchange = async () => {
        const role = box.dataset['role'] as string, perm = box.dataset['perm'] as string, allowed = box.checked;
        const label = roles.find(r => r.role === role)?.label ?? role;
        const reason = await reasonDialog(`${allowed ? 'Grant' : 'Remove'} ${perm} ${allowed ? 'to' : 'from'} ${label}?`, m.permissions.find(p => p.key === perm)?.sensitive ? 'This is a sensitive permission.' : 'It takes effect on their next admin action.', allowed ? 'Grant' : 'Remove');
        if (!reason) { box.checked = !allowed; return; }
        try { await c.api.setPermission(role, perm, allowed, reason); c.toast('Saved', 'ok'); }
        catch (e) { box.checked = !allowed; c.toast(errorText(e), 'error'); }
      });
    },
  },

  audit: {
    title: 'Audit log', perm: 'audit.read',
    async render(el, c) {
      let rows: AuditRow[] = [], oldest = 0, filters = { action: '', actor: '' };
      el.innerHTML = `<p class="muted">Every admin action, newest first. Entries cannot be edited or deleted by anyone. Passwords and e-mail addresses are never written here.</p>
        <form id="flt" class="row"><label class="sr" for="fa">Action contains</label><input id="fa" placeholder="Action contains (e.g. role, unlock, explorer)"><label class="sr" for="fb">Person contains</label><input id="fb" placeholder="Person contains"><button class="btn">Filter</button></form>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead><tbody id="rows"></tbody></table></div>
        <p><button class="btn ghost" id="more" hidden>Load older</button></p><div id="detail" class="detail" hidden></div>`;
      const draw = (): void => {
        $('#rows', el).innerHTML = rows.map(r => `<tr data-i="${r.id}" tabindex="0"><td>${esc(when(r.at))}</td><td>${esc(r.actor_name ?? 'system')} <span class="muted small">${esc(r.actor_role ?? '')}</span></td><td><code>${esc(r.action)}</code></td><td class="muted small">${esc([r.target_type, r.target_id].filter(Boolean).join(' '))}</td><td>${esc(r.reason ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing matches.</td></tr>';
        $$('#rows tr[data-i]', el).forEach(tr => { const open = (): void => { const r = rows.find(x => String(x.id) === tr.dataset['i']); if (!r) return; const d = $('#detail', el); d.hidden = false; d.innerHTML = `<h3>Entry ${r.id}</h3><pre>${esc(JSON.stringify({ at: r.at, actor: r.actor_name, role: r.actor_role, action: r.action, target: [r.target_type, r.target_id], reason: r.reason, before: r.before, after: r.after, meta: r.meta }, null, 2))}</pre>`; };
          tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); }; });
      };
      const load = async (more: boolean): Promise<void> => {
        const got = await c.api.audit({ ...filters, before: more ? oldest : undefined, limit: 100 });
        rows = more ? [...rows, ...got] : got; oldest = rows.length ? Math.min(...rows.map(r => r.id)) : 0;
        ($('#more', el) as HTMLButtonElement).hidden = got.length < 100; draw();
      };
      $<HTMLFormElement>('#flt', el).onsubmit = e => { e.preventDefault(); filters = { action: ($<HTMLInputElement>('#fa', el)).value.trim(), actor: ($<HTMLInputElement>('#fb', el)).value.trim() }; void load(false).catch(er => c.toast(errorText(er), 'error')); };
      $('#more', el).onclick = () => void load(true).catch(er => c.toast(errorText(er), 'error'));
      await load(false);
    },
  },

  explorer: {
    title: 'Data explorer', perm: 'explorer.query',
    async render(el, c) {
      const examples: [string, string][] = [
        ['All tables', "select table_name from information_schema.tables where table_schema = 'public' order by 1"],
        ['Newest players', 'select id, display_name, created_at from public.profiles order by created_at desc limit 50'],
        ['Biggest wallets', 'select p.display_name, w.balance, w.wagered, w.won from public.wallets w join public.profiles p on p.id = w.user_id order by w.balance desc limit 50'],
        ['Recent chat', 'select id, display_name, body, created_at from public.chat_messages order by id desc limit 100'],
        ['Open battles', "select id, format, mode, status, created_at from public.live_battles where status = 'waiting' order by created_at desc"],
        ['Recent rounds', 'select id, game, status, result, created_at from public.game_rounds order by id desc limit 50'],
        ['Sign-in e-mails', 'select id, email, created_at from auth.users order by created_at desc limit 50'],
      ];
      el.innerHTML = `<p class="muted">The Owner can ask the database anything, <b>read-only</b>. Nothing can be changed (a data-changing query is refused even inside a function). One statement, up to 5 seconds, up to 1,000 rows. <b>Every query is written to the audit log, including refused ones.</b> It sees everything, including secret seeds of unfinished rounds: do not play on the account you use to look at them.</p>
        <div class="row wrap">${examples.map(([l], i) => `<button class="btn ghost" data-ex="${i}">${esc(l)}</button>`).join('')}</div>
        <label class="sr" for="sql">SQL query</label><textarea id="sql" rows="6" spellcheck="false" placeholder="select ..."></textarea>
        <div class="row"><button class="btn primary" id="run">Run (Ctrl+Enter)</button><label>Rows <input id="lim" type="number" min="1" max="1000" value="200" style="width:6em"></label><span class="muted small" id="info"></span></div>
        <div id="out"></div>`;
      const sql = $<HTMLTextAreaElement>('#sql', el);
      $$('[data-ex]', el).forEach(b => b.onclick = () => { sql.value = examples[+(b.dataset['ex'] as string)]?.[1] ?? ''; sql.focus(); });
      const run = async (): Promise<void> => {
        const out = $('#out', el); out.innerHTML = '<p class="muted">Running…</p>';
        try {
          const t0 = performance.now(), r = await c.api.query(sql.value, +($<HTMLInputElement>('#lim', el)).value || 200);
          if (r.error) { out.innerHTML = `<p class="err" role="alert">${esc(errorText(r.error))}</p>`; return; }
          $('#info', el).textContent = `${r.rows.length} row${r.rows.length === 1 ? '' : 's'} in ${Math.round(performance.now() - t0)} ms${r.truncated ? ' (more rows exist: raise the limit)' : ''}`;
          out.innerHTML = r.rows.length ? `<div class="tablewrap"><table class="grid"><thead><tr>${r.columns.map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(row => `<tr>${r.columns.map(k => `<td>${esc(typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">No rows.</p>';
        } catch (e) { out.innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; }
      };
      $('#run', el).onclick = () => void run();
      sql.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); } };
    },
  },
};
