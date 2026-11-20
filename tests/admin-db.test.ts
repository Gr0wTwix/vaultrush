// @vitest-environment node
// Runs migrations 0001 to 0006 in an in-process Postgres (PGlite) and checks the admin foundation: the three-step sign-in (a staff role,
// a two-factor session, the admin password), lockout and timeout, the role hierarchy and editable permissions, the append-only audit
// log, the permission-gated e-mail reveal, and the read-only data explorer.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const MOD = '33333333-3333-3333-3333-333333333333';
const PLAYER = '44444444-4444-4444-4444-444444444444';
const PW = 'Correct-Horse-Battery-9';
let db: PGlite;

const PRELUDE = `
  create schema extensions; create schema auth;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
  insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${ADMIN}', 'admin@example.com'), ('${MOD}', 'mod@example.com'), ('${PLAYER}', 'player@example.com');
`;

/** Run as a signed-in user. aal2 = the session completed two-factor sign-in. */
async function as<T>(uid: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: uid, aal });
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${claims}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, args: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<any> =>
  as(uid, aal, async () => {
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    return ((await db.query(`select public.${fn}(${ph}) as v`, args)).rows[0] as { v: unknown }).v;
  });
const q = (uid: string | null, text: string, params: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2') => as(uid, aal, async () => (await db.query(text, params)).rows as any[]);
const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
const fails = async (p: Promise<unknown>, what: string) => { await expect(p).rejects.toThrow(what); };
const TERMS = '2026-11-21';

/** Sign in all three steps as this user (two-factor session, admin password set and unlocked). */
async function unlock(uid: string): Promise<void> {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
}
const lastLog = async (action: string): Promise<any> => (await sql(`select * from public.admin_audit_log where action = $1 order by id desc limit 1`, [action]))[0];

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin']) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [ADMIN, 'Kai'], [MOD, 'Vexx'], [PLAYER, 'Nova']] as const) await rpc(id, 'complete_signup', [n, TERMS, true], 'aal1');
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1)`, [OWNER]);      // the one-time statement from the migration
}, 90_000);
afterAll(async () => { await db.close(); });

describe('who is staff', () => {
  it('shows a player nothing, and refuses every admin function', async () => {
    expect(await rpc(PLAYER, 'admin_status')).toEqual({ is_admin: false });
    for (const [fn, args] of [['admin_touch', []], ['admin_my_permissions', []], ['admin_list_admins', []], ['admin_find_player', ['sa']], ['admin_query', ['select 1']],
      ['admin_permission_matrix', []], ['admin_player_email', [OWNER, 'why not']]] as const) await fails(rpc(PLAYER, fn, [...args]), 'admin_denied');
    await fails(rpc(PLAYER, 'admin_unlock', [PW]), 'admin_denied');
    await fails(rpc(PLAYER, 'admin_set_password', [PW]), 'admin_denied');
    await fails(rpc(null, 'admin_status'), 'permission denied');
  });
  it('the admin tables cannot be read or written by anyone directly', async () => {
    for (const t of ['admin_roles', 'admin_security', 'admin_sessions', 'admin_role_permissions', 'admin_role_defs', 'admin_permissions'])
      await fails(q(OWNER, `select * from public.${t}`), 'permission denied');
    await fails(q(OWNER, `insert into public.admin_roles (user_id, role) values ('${PLAYER}', 'owner')`), 'permission denied');
  });
});

describe('the three-step sign-in', () => {
  it('step 2: a session without two-factor is refused at every step', async () => {
    expect((await rpc(OWNER, 'admin_status', [], 'aal1')).mfa).toBe(false);
    await fails(rpc(OWNER, 'admin_set_password', [PW], 'aal1'), 'admin_mfa_required');
    await fails(rpc(OWNER, 'admin_unlock', [PW], 'aal1'), 'admin_mfa_required');
    await fails(rpc(OWNER, 'admin_touch', [], 'aal1'), 'admin_mfa_required');
  });
  it('step 3: a weak password is refused, a strong one is stored hashed, and nothing is unlocked until it is entered', async () => {
    expect(await rpc(OWNER, 'admin_status')).toMatchObject({ is_admin: true, role: 'owner', mfa: true, password_set: false, unlocked: false });
    await fails(rpc(OWNER, 'admin_unlock', [PW]).then(r => { if (!r.ok) throw new Error(r.reason); }), 'no_password');
    for (const weak of ['short1A!', 'alllowercaseletters', 'ALLUPPERCASELETTERS1', 'Mirage-Mirage-Mirage1', 'Password-Password-1234', 'aaaaaaaaaaaaaaaaaaaa']) await fails(rpc(OWNER, 'admin_set_password', [weak]), 'weak_password');
    expect((await rpc(OWNER, 'admin_set_password', [PW])).ok).toBe(true);
    const [row] = await sql(`select password_hash from public.admin_security where user_id = $1`, [OWNER]);
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);                              // bcrypt, never the password
    expect(row.password_hash).not.toContain(PW);
    expect((await rpc(OWNER, 'admin_status')).unlocked).toBe(false);
    await fails(rpc(OWNER, 'admin_touch'), 'admin_session_required');
    await fails(rpc(OWNER, 'admin_list_admins'), 'admin_session_required');
  });
  it('a wrong password is counted and returned (so the count is saved), and five wrong tries lock the sign-in for 15 minutes', async () => {
    let r = await rpc(OWNER, 'admin_unlock', ['Wrong-Password-1234!']);
    expect(r).toMatchObject({ ok: false, reason: 'wrong_password', remaining: 4 });
    expect((await sql(`select failed_count from public.admin_security where user_id = $1`, [OWNER]))[0].failed_count).toBe(1);
    for (let i = 0; i < 3; i++) r = await rpc(OWNER, 'admin_unlock', ['Wrong-Password-1234!']);
    expect(r.remaining).toBe(1);
    r = await rpc(OWNER, 'admin_unlock', ['Wrong-Password-1234!']);
    expect(r.reason).toBe('wrong_password');
    const locked = await rpc(OWNER, 'admin_unlock', [PW]);                              // even the right password is refused during the lockout
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    expect((await rpc(OWNER, 'admin_status')).locked_until).not.toBeNull();
    await sql(`update public.admin_security set locked_until = now() - interval '1 second' where user_id = $1`, [OWNER]);
    expect((await rpc(OWNER, 'admin_unlock', [PW])).ok).toBe(true);                     // the lockout ended
    expect((await sql(`select failed_count from public.admin_security where user_id = $1`, [OWNER]))[0].failed_count).toBe(0);
  });
  it('unlocked: admin calls work and keep the session alive; it expires after idling; lock ends it at once', async () => {
    expect((await rpc(OWNER, 'admin_status')).unlocked).toBe(true);
    const t1 = (await rpc(OWNER, 'admin_touch')).expires_at;
    await sql(`update public.admin_sessions set expires_at = now() + interval '1 minute' where user_id = $1`, [OWNER]);
    const t2 = (await rpc(OWNER, 'admin_touch')).expires_at;
    expect(Date.parse(t2)).toBeGreaterThan(Date.now() + 25 * 60_000);                    // pushed out to about 30 minutes again
    expect(Date.parse(t1)).toBeGreaterThan(Date.now() + 25 * 60_000);
    await sql(`update public.admin_sessions set expires_at = now() - interval '1 second' where user_id = $1`, [OWNER]);
    await fails(rpc(OWNER, 'admin_touch'), 'admin_session_required');
    expect((await rpc(OWNER, 'admin_status')).unlocked).toBe(false);
    await unlock(OWNER);
    await rpc(OWNER, 'admin_lock');
    await fails(rpc(OWNER, 'admin_touch'), 'admin_session_required');
    await unlock(OWNER);
  });
  it('changing the password needs the current one, and the new one signs you out', async () => {
    expect(await rpc(OWNER, 'admin_set_password', ['Another-Strong-Pass-77', 'nope'])).toMatchObject({ ok: false, reason: 'wrong_password' });
    expect((await rpc(OWNER, 'admin_set_password', ['Another-Strong-Pass-77', PW])).ok).toBe(true);
    await fails(rpc(OWNER, 'admin_touch'), 'admin_session_required');
    expect((await rpc(OWNER, 'admin_unlock', [PW])).ok).toBe(false);
    expect((await rpc(OWNER, 'admin_unlock', ['Another-Strong-Pass-77'])).ok).toBe(true);
    expect((await rpc(OWNER, 'admin_set_password', [PW, 'Another-Strong-Pass-77'])).ok).toBe(true);
    await unlock(OWNER);
  });
});

describe('the audit log', () => {
  it('records the sign-in steps, never a password, and every entry names who did what', async () => {
    const all = JSON.stringify(await sql(`select * from public.admin_audit_log`));
    expect(all).not.toContain(PW); expect(all).not.toContain('Another-Strong');
    for (const a of ['admin.password_set', 'admin.unlock', 'admin.unlock_failed', 'admin.lock', 'admin.password_changed']) expect(await lastLog(a), a).toBeTruthy();
    expect(await lastLog('admin.unlock')).toMatchObject({ actor: OWNER, actor_name: 'Mirage', actor_role: 'owner' });
  });
  it('is readable by staff with the permission and unlocked, and by nobody else', async () => {
    expect((await q(OWNER, `select count(*)::int as n from public.admin_audit_log`))[0].n).toBeGreaterThan(5);
    await fails(q(null, `select * from public.admin_audit_log`), 'permission denied');
    expect(await q(PLAYER, `select * from public.admin_audit_log`)).toEqual([]);          // RLS: no rows for a player
    expect(await q(OWNER, `select * from public.admin_audit_log`, [], 'aal1')).toEqual([]); // and none without two-factor
  });
  it('cannot be edited or deleted by anyone, the owner included', async () => {
    await fails(q(OWNER, `update public.admin_audit_log set reason = 'changed'`), 'permission denied');
    await fails(q(OWNER, `delete from public.admin_audit_log`), 'permission denied');
    await fails(q(OWNER, `insert into public.admin_audit_log (action) values ('forged')`), 'permission denied');
    await fails(q(OWNER, `truncate public.admin_audit_log`), 'permission denied');
    await fails(rpc(OWNER, 'admin_log', ['forged']), 'permission denied');
  });
});

describe('roles and the hierarchy', () => {
  it('the owner makes an admin and a moderator, with a reason, and each change is logged', async () => {
    await fails(rpc(OWNER, 'admin_set_role', [ADMIN, 'admin', '']), 'reason_required');
    await rpc(OWNER, 'admin_set_role', [ADMIN, 'admin', 'trusted helper']);
    await rpc(OWNER, 'admin_set_role', [MOD, 'moderator', 'chat help']);
    expect(await rpc(ADMIN, 'admin_status')).toMatchObject({ is_admin: true, role: 'admin', rank: 80, password_set: false });
    expect(await lastLog('role.set')).toMatchObject({ target_id: MOD, reason: 'chat help', after: { role: 'moderator' } });
    const admins = await rpc(OWNER, 'admin_list_admins');
    expect(admins.map((a: any) => a.role)).toEqual(['owner', 'admin', 'moderator']);
  });
  it('refuses the owner role by function, changing yourself, the unknown, and the missing', async () => {
    await fails(rpc(OWNER, 'admin_set_role', [PLAYER, 'owner', 'make owner']), 'owner_by_sql_only');
    await fails(rpc(OWNER, 'admin_set_role', [OWNER, 'admin', 'demote myself']), 'not_allowed_self');
    await fails(rpc(OWNER, 'admin_set_role', [PLAYER, 'wizard', 'x y z']), 'unknown_role');
    await fails(rpc(OWNER, 'admin_set_role', ['99999999-9999-9999-9999-999999999999', 'admin', 'x y z']), 'no_account');
  });
  it('an admin without role management cannot grant roles; with it, only below its own rank', async () => {
    await unlock(ADMIN);
    await fails(rpc(ADMIN, 'admin_set_role', [PLAYER, 'moderator', 'why not']), 'admin_denied');
    await rpc(OWNER, 'admin_set_permission', ['admin', 'roles.manage', true, 'let admins manage lower roles']);
    expect((await rpc(ADMIN, 'admin_set_role', [PLAYER, 'moderator', 'new helper'])).role).toBe('moderator');
    await fails(rpc(ADMIN, 'admin_set_role', [PLAYER, 'admin', 'promote']), 'rank_too_low');          // not equal to its own rank
    await fails(rpc(ADMIN, 'admin_set_role', [OWNER, null, 'remove owner']), 'rank_too_low');          // never above
    await fails(rpc(ADMIN, 'admin_set_role', [OWNER, 'moderator', 'demote the owner']), 'rank_too_low');
    expect((await rpc(ADMIN, 'admin_set_role', [PLAYER, null, 'not needed']).then(r => r.role))).toBeNull();
    await rpc(OWNER, 'admin_set_permission', ['admin', 'roles.manage', false, 'back to default']);
  });
  it('a moderator cannot manage anything', async () => {
    await unlock(MOD);
    await fails(rpc(MOD, 'admin_list_admins'), 'admin_denied');
    await fails(rpc(MOD, 'admin_permission_matrix'), 'admin_denied');
    await fails(rpc(MOD, 'admin_set_permission', ['readonly', 'players.view', true, 'x y z']), 'admin_denied');
    expect((await rpc(MOD, 'admin_find_player', ['nov'])).map((p: any) => p.name)).toEqual(['Nova']);
  });
  it('removing a role signs that person out at once', async () => {
    await rpc(OWNER, 'admin_set_role', [PLAYER, 'readonly', 'temp']);
    await unlock(PLAYER);
    expect((await rpc(PLAYER, 'admin_touch')).expires_at).toBeTruthy();
    await rpc(OWNER, 'admin_set_role', [PLAYER, null, 'done']);
    await fails(rpc(PLAYER, 'admin_touch'), 'admin_denied');
  });
});

describe('every permission is a switch', () => {
  it('the matrix lists every role and permission, and the owner column is implicit', async () => {
    const m = await rpc(OWNER, 'admin_permission_matrix');
    expect(m.roles.map((r: any) => r.role)).toEqual(['owner', 'admin', 'moderator', 'compliance', 'readonly']);
    expect(m.permissions.length).toBeGreaterThan(50);
    expect(m.grants.some((g: any) => g.role === 'owner')).toBe(false);
    expect((await rpc(OWNER, 'admin_my_permissions')).length).toBe(m.permissions.length);          // the owner holds all of them
    expect((await rpc(MOD, 'admin_my_permissions'))).not.toContain('players.view_email');
  });
  it('moderators cannot see e-mail by default; the owner can switch it on and off, and every reveal is logged without the address', async () => {
    await fails(rpc(MOD, 'admin_player_email', [PLAYER, 'support request']), 'admin_denied');
    await rpc(OWNER, 'admin_set_permission', ['moderator', 'players.view_email', true, 'moderators may help with e-mail issues']);
    await fails(rpc(MOD, 'admin_player_email', [PLAYER, '']), 'reason_required');
    expect(await rpc(MOD, 'admin_player_email', [PLAYER, 'player lost access'])).toBe('player@example.com');
    const log = await lastLog('pii.reveal');
    expect(log).toMatchObject({ actor: MOD, actor_role: 'moderator', target_id: PLAYER, reason: 'player lost access' });
    expect(JSON.stringify(await sql(`select * from public.admin_audit_log`))).not.toContain('player@example.com');
    await rpc(OWNER, 'admin_set_permission', ['moderator', 'players.view_email', false, 'switch it off again']);
    await fails(rpc(MOD, 'admin_player_email', [PLAYER, 'again']), 'admin_denied');
    expect(await lastLog('permission.set')).toMatchObject({ before: { allowed: true }, after: { allowed: false } });
  });
  it('the owner role is fixed; unknown names are refused; a change needs a reason', async () => {
    await fails(rpc(OWNER, 'admin_set_permission', ['owner', 'players.view', false, 'x y z']), 'owner_is_fixed');
    await fails(rpc(OWNER, 'admin_set_permission', ['moderator', 'fly.rockets', true, 'x y z']), 'unknown_permission');
    await fails(rpc(OWNER, 'admin_set_permission', ['wizard', 'players.view', true, 'x y z']), 'unknown_role');
    await fails(rpc(OWNER, 'admin_set_permission', ['moderator', 'players.view', true, '']), 'reason_required');
  });
  it('a higher rank may change lower ranks only, and only grant what it holds', async () => {
    await rpc(OWNER, 'admin_set_permission', ['admin', 'roles.manage', true, 'test']);
    await unlock(ADMIN);
    await rpc(ADMIN, 'admin_set_permission', ['moderator', 'chat.view', false, 'test lower rank']);       // a lower rank: allowed
    await rpc(ADMIN, 'admin_set_permission', ['moderator', 'chat.view', true, 'restore']);
    await fails(rpc(ADMIN, 'admin_set_permission', ['admin', 'players.view', false, 'own rank']), 'rank_too_low');   // its own rank
    await fails(rpc(ADMIN, 'admin_set_permission', ['moderator', 'explorer.query', true, 'it lacks it']), 'cannot_grant_what_you_lack');
    await fails(rpc(ADMIN, 'admin_set_permission', ['owner', 'players.view', false, 'x y z']), 'owner_is_fixed');
    await rpc(OWNER, 'admin_set_permission', ['admin', 'roles.manage', false, 'test over']);
  });
});

describe('the owner\'s data explorer', () => {
  it('runs a read-only query, returns columns in order, and logs the query before running it', async () => {
    const r = await rpc(OWNER, 'admin_query', [`select display_name, id from public.profiles order by display_name`]);
    expect(r.columns).toEqual(['display_name', 'id']);
    expect(r.rows.map((x: any) => x.display_name)).toEqual(['Kai', 'Mirage', 'Nova', 'Vexx']);
    expect(r.truncated).toBe(false);
    expect(await lastLog('explorer.query')).toMatchObject({ actor: OWNER, meta: { sql: 'select display_name, id from public.profiles order by display_name' } });
  });
  it('sees everything: the sign-in table with e-mail and the secret seeds', async () => {
    expect((await rpc(OWNER, 'admin_query', [`select email from auth.users order by email limit 1`])).rows[0].email).toBe('admin@example.com');
    expect((await rpc(OWNER, 'admin_query', [`select count(*)::int as n from public.seed_pairs`])).rows[0].n).toBeGreaterThan(0);
  });
  /** The explorer returns a problem as data (so the log entry is kept); a normal result has no error. */
  const problem = async (text: string): Promise<string> => { const r = await rpc(OWNER, 'admin_query', [text]); expect(r.rows).toEqual([]); return String(r.error); };
  it('cannot change anything: writes, data-changing CTEs, several statements, functions that write and non-queries are all refused', async () => {
    expect(await problem(`delete from public.chat_messages`)).toBe('read_only_only');
    expect(await problem(`update public.wallets set balance = 1000000`)).toBe('read_only_only');
    expect(await problem(`drop table public.wallets`)).toBe('read_only_only');
    expect(await problem(`select 1; delete from public.wallets`)).toBe('one_statement_only');
    expect(await problem(`with d as (delete from public.wallets returning 1) select * from d`)).toMatch(/data-modifying/);
    expect(await problem(`with i as (insert into public.chat_messages (user_id, body) values ('${OWNER}', 'x') returning 1) select * from i`)).toMatch(/data-modifying/);
    expect(await problem(`select public.admin_log('forged by explorer')`)).toMatch(/read-only/);                 // a function that writes is stopped by the read-only lock
    expect(await problem(`select nextval('public.admin_audit_log_id_seq')`)).toMatch(/read-only/);
    expect(await problem(`select set_config('transaction_read_only', 'off', true), public.admin_log('x')`)).toMatch(/read-only|cannot/);
    expect(await problem('')).toBe('invalid_query');
    expect((await sql(`select count(*)::int as n from public.admin_audit_log where action = 'forged by explorer'`))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.wallets`))[0].n).toBeGreaterThan(0);
  });
  it('logs every attempt, including the ones that were refused or failed', async () => {
    const before = (await sql(`select count(*)::int as n from public.admin_audit_log where action = 'explorer.query'`))[0].n;
    await problem(`delete from public.wallets`);
    await problem(`select * from table_that_does_not_exist`);
    await rpc(OWNER, 'admin_query', ['select 1 as ok']);
    expect((await sql(`select count(*)::int as n from public.admin_audit_log where action = 'explorer.query'`))[0].n).toBe(before + 3);
    expect(await lastLog('explorer.query')).toMatchObject({ meta: { sql: 'select 1 as ok' } });
  });
  it('limits the rows and says so', async () => {
    const r = await rpc(OWNER, 'admin_query', [`select generate_series(1, 50) as n`, 10]);
    expect(r.rows).toHaveLength(10); expect(r.truncated).toBe(true);
    const all = await rpc(OWNER, 'admin_query', [`select generate_series(1, 5) as n`, 10]);
    expect(all.rows).toHaveLength(5); expect(all.truncated).toBe(false);
    expect((await rpc(OWNER, 'admin_query', [`select 1 as n where false`])).columns).toEqual([]);
  });
  it('is for the owner only unless the owner switches it on for a role it outranks', async () => {
    await fails(rpc(ADMIN, 'admin_query', ['select 1']), 'admin_denied');
    await fails(rpc(MOD, 'admin_query', ['select 1']), 'admin_denied');
  });
});

describe('the migration itself', () => {
  it('has no owner by default except the one inserted by hand, and the helper functions are private', async () => {
    expect((await sql(`select count(*)::int as n from public.admin_roles where role = 'owner'`))[0].n).toBe(1);
    await fails(rpc(OWNER, 'admin_guard', ['players.view']), 'permission denied');
    await fails(rpc(OWNER, 'admin_has_perm', ['owner', 'x']), 'permission denied');
  });
});
