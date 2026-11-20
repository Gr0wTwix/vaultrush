// The pages of the admin panel that exist so far (step A of the plan). The other modules are listed on the "Coming next" page.
import type { AdminApi, AuditRow, Status } from './api.js';
import { errorText } from './api.js';
import { $, $$, esc, reasonDialog, when } from './dom.js';

export interface PageCtx { api: AdminApi; status: Status; perms: string[]; toast: (m: string, k?: 'info' | 'ok' | 'error') => void; reload: () => void; lock: () => Promise<void> }
export interface Page { title: string; perm?: string; render(el: HTMLElement, c: PageCtx): Promise<void> }

/** The whole plan, in order (docs/admin-panel-proposal-2026-11-21.md). */
export const ROADMAP: { step: string; title: string; items: string; state: 'done' | 'next' | 'later' }[] = [
  { step: 'A', title: 'Admin site, roles, permissions, audit log, explorer', items: 'This site: three-step sign-in, staff roles, editable permissions, audit log, read-only data explorer', state: 'done' },
  { step: 'B', title: 'Control and visibility', items: 'Dashboard, players, account actions, chat moderation (English room), live rooms, round control, maintenance, site notice, game switches, country restrictions', state: 'next' },
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
        <h2>Plan</h2><table class="grid"><thead><tr><th>Step</th><th>What</th><th>Status</th></tr></thead><tbody>${ROADMAP.map(r => `<tr><td>${esc(r.step)}</td><td><b>${esc(r.title)}</b><br><span class="muted small">${esc(r.items)}</span></td><td><span class="pill ${r.state}">${r.state === 'done' ? 'built' : r.state === 'next' ? 'next' : 'later'}</span></td></tr>`).join('')}</tbody></table>
        <p class="muted small">Everything you do here is written to the audit log with your name, the time and a reason. The log cannot be edited or deleted.</p>`;
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
