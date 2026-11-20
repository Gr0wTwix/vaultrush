// The admin site against a fake API: every sign-in step, the panel for different roles, and the pages (staff, permissions, audit, explorer).
// The rules themselves are tested in admin-db.test.ts; here we check that the screens show the right step and call the right functions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admin, AdminApi, AuditRow, Matrix, QueryResult, Status } from '../src/admin/api.js';
import { boot, type AdminApp } from '../src/admin/app.js';

const ROLES = [
  { role: 'owner', rank: 100, label: 'Owner', description: '' }, { role: 'admin', rank: 80, label: 'Admin', description: '' },
  { role: 'moderator', rank: 60, label: 'Moderator', description: '' }, { role: 'readonly', rank: 10, label: 'Read-only', description: '' },
];
const MATRIX: Matrix = {
  roles: ROLES,
  permissions: [
    { key: 'players.view', area: 'Players', label: 'See players', sensitive: false },
    { key: 'players.view_email', area: 'Players', label: 'Reveal e-mail', sensitive: true },
    { key: 'chat.delete', area: 'Chat', label: 'Delete chat messages', sensitive: false },
  ],
  grants: [{ role: 'admin', permission: 'players.view' }, { role: 'admin', permission: 'chat.delete' }, { role: 'moderator', permission: 'players.view' }],
};
const OWNER_PERMS = ['audit.read', 'chat.delete', 'explorer.query', 'players.view', 'players.view_email', 'roles.manage'];
const unlocked = (o: Partial<Status> = {}): Status => ({ is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: true, unlocked: true, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), ...o });

interface Fake { api: AdminApi; calls: Record<string, any[][]>; state: { user: { id: string } | null; status: Status; perms: string[]; factors: { id: string; status: string }[]; unlockResult: any; admins: Admin[]; audit: AuditRow[]; queryResult: QueryResult } }
function fake(over: Partial<Fake['state']> = {}, apiOver: Partial<AdminApi> = {}): Fake {
  const calls: Fake['calls'] = {};
  const state: Fake['state'] = {
    user: { id: 'me' }, status: unlocked(), perms: OWNER_PERMS, factors: [{ id: 'f1', status: 'verified' }], unlockResult: { ok: true },
    admins: [
      { user_id: 'me', name: 'Mirage', role: 'owner', rank: 100, granted_at: '2026-11-21T10:00:00Z' },
      { user_id: 'a1', name: 'Kai', role: 'admin', rank: 80, granted_at: '2026-11-21T11:00:00Z' },
      { user_id: 'm1', name: 'Vexx', role: 'moderator', rank: 60, granted_at: '2026-11-21T12:00:00Z' },
    ],
    audit: [
      { id: 12, at: '2026-11-21T12:05:00Z', actor: 'me', actor_name: 'Mirage', actor_role: 'owner', action: 'role.set', target_type: 'player', target_id: 'm1', before: { role: null }, after: { role: 'moderator' }, reason: 'chat help', meta: {} },
      { id: 11, at: '2026-11-21T12:00:00Z', actor: 'me', actor_name: 'Mirage', actor_role: 'owner', action: 'admin.unlock', target_type: 'admin', target_id: 'me', before: null, after: null, reason: null, meta: {} },
    ],
    queryResult: { columns: ['display_name', 'id'], rows: [{ display_name: 'Kai', id: 'k' }, { display_name: 'Mirage', id: 'm' }], truncated: false },
    ...over,
  };
  const rec = <T,>(name: string, fn: (...a: any[]) => T) => (...a: any[]): T => { (calls[name] ||= []).push(a); return fn(...a); };
  const api: AdminApi = {
    configured: () => true, steamAvailable: () => true, startSteam: rec('startSteam', () => undefined), finishSteam: async () => null,
    user: async () => state.user, onAuth: async () => undefined, signOut: rec('signOut', async () => { state.user = null; }),
    status: rec('status', async () => state.status), factors: async () => state.factors,
    enroll: rec('enroll', async () => ({ id: 'new', qr: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD EFGH' })),
    removeFactor: rec('removeFactor', async () => undefined),
    verify: rec('verify', async () => { state.status = { ...state.status, mfa: true }; }),
    setPassword: rec('setPassword', async () => { state.status = { ...state.status, password_set: true }; return { ok: true }; }),
    unlock: rec('unlock', async () => { if (state.unlockResult.ok) state.status = unlocked({ role: state.status.role, label: state.status.label, rank: state.status.rank }); return state.unlockResult; }),
    lock: rec('lock', async () => { state.status = { ...state.status, unlocked: false }; }),
    touch: rec('touch', async () => new Date(Date.now() + 30 * 60_000).toISOString()),
    myPermissions: async () => state.perms, listAdmins: async () => state.admins, findPlayer: rec('findPlayer', async () => [{ id: 'p1', name: 'Nova', created_at: '2026-11-18T10:00:00Z', role: null }]),
    setRole: rec('setRole', async () => undefined), matrix: async () => MATRIX, setPermission: rec('setPermission', async () => undefined),
    audit: rec('audit', async () => state.audit), query: rec('query', async () => state.queryResult), ...apiOver,
  };
  return { api, calls, state };
}

let root: HTMLElement, app: AdminApp | undefined;
const start = async (f: Fake): Promise<void> => { root = document.createElement('div'); document.body.append(root); location.hash = ''; app = await boot(root, f.api); };
const wait = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 2000 });
const q = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
const type = (sel: string, v: string): void => { const el = q<HTMLInputElement>(sel); el.value = v; };
const submit = (sel = '#f'): void => { q<HTMLFormElement>(sel).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); };
const goto = async (page: string, ready: string): Promise<void> => { location.hash = `#/${page}`; window.dispatchEvent(new HashChangeEvent('hashchange')); await wait(() => expect(q(ready)).not.toBeNull()); };
const answerReason = async (text: string): Promise<void> => { await wait(() => expect(document.querySelector('#dlgReason')).not.toBeNull()); (document.querySelector('#dlgReason') as HTMLTextAreaElement).value = text; (document.querySelector('#dlgYes') as HTMLElement).click(); };
const cancelReason = async (): Promise<void> => { await wait(() => expect(document.querySelector('#dlgNo')).not.toBeNull()); (document.querySelector('#dlgNo') as HTMLElement).click(); };

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { app?.stop(); app = undefined; document.body.innerHTML = ''; location.hash = ''; });

describe('the three-step sign-in', () => {
  it('says so when there is no database connection', async () => {
    await start(fake({}, { configured: () => false }));
    expect(root.textContent).toMatch(/not configured/i);
  });

  it('step 1: signed out shows only the Steam button', async () => {
    const f = fake({ user: null }); await start(f);
    expect(root.textContent).toContain('Staff sign-in');
    q('#steam').click();
    expect(f.calls['startSteam']).toHaveLength(1);
    expect(root.querySelector('nav')).toBeNull();
  });

  it('a signed-in player who is not staff gets "No access" and nothing else', async () => {
    await start(fake({ status: { is_admin: false } }));
    expect(root.textContent).toContain('No access');
    expect(root.textContent).not.toMatch(/authenticator|password|Overview/i);
  });

  it('step 2: with an authenticator already set up, asks for the code and sends it for the verified factor', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: true, unlocked: false } }); await start(f);
    await wait(() => expect(q('#code')).not.toBeNull());
    expect(root.textContent).toContain('Authenticator code');
    type('#code', '123456'); submit();
    await wait(() => expect(f.calls['verify']).toEqual([['f1', '123456']]));
    await wait(() => expect(root.textContent).toContain('Admin password'));           // moves on to step 3
  });

  it('step 2: with no authenticator yet, shows the QR code and the manual key, and clears a half-finished setup first', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: false, unlocked: false }, factors: [{ id: 'old', status: 'unverified' }] }); await start(f);
    await wait(() => expect(q('.qr img')).not.toBeNull());
    expect(f.calls['removeFactor']).toEqual([['old']]);
    expect(root.textContent).toContain('ABCD EFGH');
    type('#code', '654321'); submit();
    await wait(() => expect(f.calls['verify']).toEqual([['new', '654321']]));
    await wait(() => expect(root.textContent).toContain('Create your admin password'));
  });

  it('a wrong authenticator code shows an error and stays on the step', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: true, unlocked: false } }, { verify: async () => { throw new Error('Invalid TOTP code entered'); } }); await start(f);
    await wait(() => expect(q('#code')).not.toBeNull());
    type('#code', '000000'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/invalid/i));
    expect(root.textContent).toContain('Authenticator code');
  });

  it('step 3 (first time): refuses two different passwords, shows the server\'s weak-password rules, then saves, unlocks and opens the panel', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: false, unlocked: false } }); await start(f);
    expect(root.textContent).toContain('Create your admin password');
    type('#pw1', 'Correct-Horse-Battery-9'); type('#pw2', 'something else entirely'); submit();
    expect(q('#err').textContent).toMatch(/different/);
    expect(f.calls['setPassword']).toBeUndefined();
    f.api.setPassword = async () => { throw new Error('weak_password'); };
    type('#pw2', 'Correct-Horse-Battery-9'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/at least 14 characters/));
    f.api.setPassword = (async (...a: any[]) => { (f.calls['setPassword'] ||= []).push(a); f.state.status = { ...f.state.status, password_set: true }; return { ok: true }; }) as any;
    submit();
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect(f.calls['setPassword']).toEqual([['Correct-Horse-Battery-9']]);
    expect(f.calls['unlock']).toEqual([['Correct-Horse-Battery-9']]);
  });

  it('step 3: a wrong password says how many tries are left; a lockout is shown; the right password opens the panel', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: true, unlocked: false }, unlockResult: { ok: false, reason: 'wrong_password', remaining: 3 } }); await start(f);
    type('#pw', 'nope'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/3 attempts left/));
    expect(q<HTMLInputElement>('#pw').value).toBe('');
    f.state.unlockResult = { ok: false, reason: 'locked', until: new Date(Date.now() + 900_000).toISOString() };
    f.state.status = { ...f.state.status, locked_until: f.state.unlockResult.until };
    type('#pw', 'nope'); submit();
    await wait(() => expect(root.textContent).toMatch(/Too many wrong attempts/));
    f.state.unlockResult = { ok: true }; f.state.status = { ...f.state.status, locked_until: null };
    type('#pw', 'Correct-Horse-Battery-9'); submit();
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
  });

  it('Sign out from any step ends the session', async () => {
    const f = fake({ status: { is_admin: false } }); await start(f);
    q('#signout').click();
    await wait(() => expect(f.calls['signOut']).toHaveLength(1));
    await wait(() => expect(root.textContent).toContain('Staff sign-in'));
  });
});

describe('the panel', () => {
  it('shows the owner every page, with the role and a session timer', async () => {
    await start(fake());
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(['Overview', 'Staff and roles', 'Permissions', 'Audit log', 'Data explorer']);
    expect(q('#roleTag').textContent).toBe('Owner');
    expect(q('#timer').textContent).toMatch(/^\d+:\d\d$/);
    expect(root.textContent).toContain('Everything you do here is written to the audit log');
  });

  it('shows a moderator only what its permissions allow', async () => {
    await start(fake({ status: unlocked({ role: 'moderator', label: 'Moderator', rank: 60 }), perms: ['dashboard.view', 'players.view', 'chat.delete'] }));
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(['Overview']);
    await goto('explorer', '#page');                                                  // typing the address does not open a hidden page's data
    expect(q('#page h1').textContent).toBe('Data explorer');
  });

  it('Lock now locks the session and returns to the password step', async () => {
    const f = fake(); await start(f);
    await wait(() => expect(q('#lockBtn')).not.toBeNull());
    q('#lockBtn').click();
    await wait(() => expect(root.textContent).toContain('Admin password'));
    expect(f.calls['lock']).toHaveLength(1);
  });

  it('when the session expires on the server, the next call sends you back to the password step', async () => {
    const f = fake({}, { listAdmins: async () => { throw new Error('admin_session_required'); } }); await start(f);
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    f.state.status = { ...f.state.status, unlocked: false };
    await goto('staff', '#page');
    await wait(() => expect(root.textContent).toContain('Admin password'));
  });
});

describe('staff and roles', () => {
  it('lists staff, offers only roles below my own, and locks my own row and ranks above mine', async () => {
    await start(fake({ status: unlocked({ role: 'admin', label: 'Admin', rank: 80 }), perms: ['roles.manage', 'audit.read'], user: { id: 'a1' }, admins: [
      { user_id: 'me', name: 'Mirage', role: 'owner', rank: 100, granted_at: '2026-11-21T10:00:00Z' }, { user_id: 'a1', name: 'Kai', role: 'admin', rank: 80, granted_at: '2026-11-21T11:00:00Z' },
      { user_id: 'm1', name: 'Vexx', role: 'moderator', rank: 60, granted_at: '2026-11-21T12:00:00Z' }] }));
    await goto('staff', 'table.grid');
    const rows = [...root.querySelectorAll('tr[data-u]')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('select')).toBeNull();                              // the owner is above me
    expect(rows[1]!.querySelector('select')).toBeNull();                              // myself
    const opts = [...rows[2]!.querySelectorAll('option')].map(o => o.textContent);
    expect(opts).toEqual(['Read-only', 'Moderator']);                                // nothing at or above my rank, least powerful first
  });

  it('changing a role asks for a reason, then calls the server with it; cancelling calls nothing', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    const row = q('tr[data-u="m1"]');
    (row.querySelector('[data-role]') as HTMLSelectElement).value = 'readonly';
    (row.querySelector('[data-save]') as HTMLElement).click();
    await cancelReason();
    expect(f.calls['setRole']).toBeUndefined();
    (row.querySelector('[data-save]') as HTMLElement).click();
    await answerReason('only needs to look');
    await wait(() => expect(f.calls['setRole']).toEqual([['m1', 'readonly', 'only needs to look']]));
  });

  it('a reason that is too short is not accepted by the dialog', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await wait(() => expect(document.querySelector('#dlgReason')).not.toBeNull());
    (document.querySelector('#dlgReason') as HTMLTextAreaElement).value = 'ab'; (document.querySelector('#dlgYes') as HTMLElement).click();
    expect(document.querySelector('#dlgErr')!.textContent).toMatch(/at least 3/);
    expect(f.calls['setRole']).toBeUndefined();
    (document.querySelector('#dlgNo') as HTMLElement).click();
  });

  it('removing a role and adding someone from a search both go through a reason', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await answerReason('left the team');
    await wait(() => expect(f.calls['setRole']).toEqual([['m1', null, 'left the team']]));
    await goto('staff', '#find');
    type('#q', 'nov'); submit('#find');
    await wait(() => expect(q('tr[data-p="p1"]')).not.toBeNull());
    expect((q('tr[data-p="p1"]').querySelector('select') as HTMLSelectElement).value).toBe('readonly');     // the default is the least powerful role
    (q('tr[data-p="p1"]').querySelector('select') as HTMLSelectElement).value = 'moderator';
    (q('tr[data-p="p1"]').querySelector('[data-add]') as HTMLElement).click();
    await answerReason('new chat helper');
    await wait(() => expect(f.calls['setRole']![1]).toEqual(['p1', 'moderator', 'new chat helper']));
  });

  it('shows the server\'s refusal in plain words', async () => {
    const f = fake({}, { setRole: async () => { throw new Error('rank_too_low'); } }); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await answerReason('testing it');
    await wait(() => expect(document.getElementById('toasts')!.textContent).toMatch(/below your own rank/));
  });
});

describe('permissions', () => {
  it('shows every role and permission, the owner column full and locked, and my own rank and above locked', async () => {
    await start(fake({ status: unlocked({ role: 'admin', label: 'Admin', rank: 80 }), perms: ['roles.manage', 'players.view', 'chat.delete'] }));
    await goto('permissions', 'table.matrix');
    const box = (role: string, perm: string): HTMLInputElement => q<HTMLInputElement>(`input[data-role="${role}"][data-perm="${perm}"]`);
    expect(box('owner', 'players.view').checked).toBe(true); expect(box('owner', 'players.view').disabled).toBe(true);
    expect(box('admin', 'players.view').disabled).toBe(true);                         // my own rank
    expect(box('moderator', 'players.view').checked).toBe(true); expect(box('moderator', 'players.view').disabled).toBe(false);
    expect(box('moderator', 'players.view_email').checked).toBe(false);
    expect(box('moderator', 'players.view_email').disabled).toBe(true);                // I do not hold it, so I cannot grant it
    expect(root.textContent).toContain('sensitive');
  });

  it('switching a permission asks for a reason and saves it; cancelling puts the box back', async () => {
    const f = fake(); await start(f);
    await goto('permissions', 'table.matrix');
    const box = q<HTMLInputElement>('input[data-role="moderator"][data-perm="players.view_email"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await cancelReason();
    await wait(() => expect(box.checked).toBe(false));
    expect(f.calls['setPermission']).toBeUndefined();
    box.checked = true; box.dispatchEvent(new Event('change'));
    await answerReason('moderators may help with e-mail problems');
    await wait(() => expect(f.calls['setPermission']).toEqual([['moderator', 'players.view_email', true, 'moderators may help with e-mail problems']]));
    expect(box.checked).toBe(true);
  });

  it('puts the box back and explains when the server refuses', async () => {
    const f = fake({}, { setPermission: async () => { throw new Error('cannot_grant_what_you_lack'); } }); await start(f);
    await goto('permissions', 'table.matrix');
    const box = q<HTMLInputElement>('input[data-role="moderator"][data-perm="chat.delete"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await answerReason('trying');
    await wait(() => expect(box.checked).toBe(false));
    expect(document.getElementById('toasts')!.textContent).toMatch(/do not hold yourself/);
  });
});

describe('audit log', () => {
  it('lists entries newest first, filters on the server, and shows the full entry on click', async () => {
    const f = fake(); await start(f);
    await goto('audit', '#rows tr[data-i]');
    expect([...root.querySelectorAll('#rows tr')].map(r => r.querySelector('code')?.textContent)).toEqual(['role.set', 'admin.unlock']);
    q('#rows tr[data-i="12"]').click();
    expect(q('#detail').hidden).toBe(false);
    expect(q('#detail').textContent).toContain('chat help');
    expect(q('#detail').textContent).toContain('moderator');
    type('#fa', 'unlock'); type('#fb', 'Mir'); submit('#flt');
    await wait(() => expect(f.calls['audit']!.at(-1)![0]).toMatchObject({ action: 'unlock', actor: 'Mir' }));
  });
  it('says so when nothing matches, and shows a refusal', async () => {
    await start(fake({ audit: [] }));
    await goto('audit', '#rows');
    expect(q('#rows').textContent).toContain('Nothing matches');
  });
});

describe('data explorer', () => {
  it('runs a query and shows the columns in the order the database returned them', async () => {
    const f = fake(); await start(f);
    await goto('explorer', '#sql');
    q<HTMLTextAreaElement>('#sql').value = 'select display_name, id from public.profiles';
    q('#run').click();
    await wait(() => expect(root.querySelector('#out table')).not.toBeNull());
    expect([...root.querySelectorAll('#out th')].map(t => t.textContent)).toEqual(['display_name', 'id']);
    expect(root.querySelectorAll('#out tbody tr')).toHaveLength(2);
    expect(f.calls['query']).toEqual([['select display_name, id from public.profiles', 200]]);
    expect(q('#info').textContent).toMatch(/2 rows/);
  });
  it('shows a refused or failing query as a message and never as a table', async () => {
    const f = fake({ queryResult: { columns: [], rows: [], truncated: false, error: 'read_only_only' } }); await start(f);
    await goto('explorer', '#sql');
    q<HTMLTextAreaElement>('#sql').value = 'delete from public.wallets';
    q('#run').click();
    await wait(() => expect(q('#out').textContent).toMatch(/Only SELECT/));
    expect(root.querySelector('#out table')).toBeNull();
  });
  it('the example buttons fill the box, Ctrl+Enter runs, and cells with objects are shown as JSON, safely escaped', async () => {
    const f = fake({ queryResult: { columns: ['x'], rows: [{ x: { a: '<img src=x onerror=alert(1)>' } }], truncated: true } }); await start(f);
    await goto('explorer', '#sql');
    q('[data-ex="0"]').click();
    expect(q<HTMLTextAreaElement>('#sql').value).toContain('information_schema.tables');
    q('#sql').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await wait(() => expect(root.querySelector('#out table')).not.toBeNull());
    expect(root.querySelector('#out img')).toBeNull();
    expect(q('#out td').textContent).toContain('<img');
    expect(q('#info').textContent).toMatch(/more rows exist/);
  });
});
