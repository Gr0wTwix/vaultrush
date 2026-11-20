// @vitest-environment node
// Runs migrations 0001 to 0007 in an in-process Postgres (PGlite) and checks the site controls: maintenance mode, the site notice, game
// switches, sign-ups, country restrictions. The point of the tests is that the database itself refuses, not the page: every guarded entry point
// is called with its switch off, staff are never locked out, and leaving or cashing out is never blocked.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const OWNER = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const MOD = '33333333-3333-3333-3333-333333333333';
const PLAYER = '44444444-4444-4444-4444-444444444444';
const NEWBIE = '55555555-5555-5555-5555-555555555555';
const NEWBIE2 = '77777777-7777-7777-7777-777777777777';
const READER = '66666666-6666-6666-6666-666666666666';
const PW = 'Correct-Horse-Battery-9';
const TERMS = '2026-11-21';
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
  insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${ADMIN}', 'admin@example.com'), ('${MOD}', 'mod@example.com'),
    ('${PLAYER}', 'player@example.com'), ('${NEWBIE}', 'newbie@example.com'), ('${NEWBIE2}', 'newbie2@example.com'), ('${READER}', 'reader@example.com');
`;

/** Run as a signed-in user (or anon), optionally from a given country (the connection header Cloudflare adds). */
let country: string | null = null;
async function as<T>(uid: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: uid, aal });
  const headers = country ? JSON.stringify({ 'cf-ipcountry': country }) : '';
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${claims}', false), set_config('request.headers', '${headers}', false);`);
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
const unlock = async (uid: string): Promise<void> => {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
};
const lastLog = async (action: string): Promise<any> => (await sql(`select * from public.admin_audit_log where action = $1 order by id desc limit 1`, [action]))[0];
const status = (uid: string | null = PLAYER): Promise<any> => rpc(uid, 'site_status', [], 'aal1');
/** Back to a clean slate: everything on, no notice, nobody blocked. */
const reset = async (): Promise<void> => {
  await sql(`update public.site_controls set maintenance_on = false, maintenance_message = '', notice_on = false, notice_text = '', notice_kind = 'info', signups_open = true, games_off = '{}', blocked_countries = '{}'`);
  country = null;
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls']) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [ADMIN, 'Kai'], [MOD, 'Vexx'], [PLAYER, 'Nova'], [READER, 'Quill']] as const) await rpc(id, 'complete_signup', [n, TERMS, true], 'aal1');
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'admin', $1), ($3, 'moderator', $1), ($4, 'readonly', $1)`, [OWNER, ADMIN, MOD, READER]);
  for (const id of [OWNER, ADMIN, MOD, READER]) await unlock(id);
}, 90_000);
afterAll(async () => { await db.close(); });
beforeEach(reset);

describe('the defaults and what everyone may see', () => {
  it('starts with everything on and nothing blocked', async () => {
    expect(await status(null)).toEqual({ maintenance: false, maintenance_message: '', notice: null, signups_open: true, games_off: [], country: null, country_blocked: false, staff: false });
  });
  it('is readable by a signed-out visitor, but the table itself is not readable by anyone', async () => {
    expect((await status(null)).staff).toBe(false);
    await expect(q(PLAYER, 'select * from public.site_controls', [], 'aal1')).rejects.toThrow(/permission denied/);
    await expect(q(OWNER, 'select * from public.site_controls')).rejects.toThrow(/permission denied/);
    await expect(q(PLAYER, 'update public.site_controls set maintenance_on = true', [], 'aal1')).rejects.toThrow(/permission denied/);
  });
  it('marks staff as staff', async () => {
    expect((await status(OWNER)).staff).toBe(true);
    expect((await status(PLAYER)).staff).toBe(false);
  });
});

describe('who may change what', () => {
  it('refuses players and visitors', async () => {
    for (const [fn, args] of [['admin_get_controls', []], ['admin_set_maintenance', [true, 'x', 'because']], ['admin_set_notice', [true, 'hi', 'info', 'because']],
      ['admin_set_game', ['crash', true, 'because']], ['admin_set_signups', [false, 'because']], ['admin_set_countries', [['US'], 'because']]] as const) {
      await fails(rpc(PLAYER, fn, [...args], 'aal1'), 'admin_denied');
      await fails(rpc(null, fn, [...args], 'aal1'), 'permission denied');       // a visitor is not even allowed to call it
    }
  });
  it('lets a read-only member look but not change; a moderator holds no site switch by default', async () => {
    expect((await rpc(READER, 'admin_get_controls')).signups_open).toBe(true);
    await fails(rpc(READER, 'admin_set_maintenance', [true, '', 'because']), 'admin_denied');
    await fails(rpc(MOD, 'admin_set_maintenance', [true, '', 'because']), 'admin_denied');
    await fails(rpc(MOD, 'admin_set_game', ['crash', true, 'because']), 'admin_denied');
    expect((await status()).maintenance).toBe(false);
  });
  it('lets the Owner and the Admin role change them, and a switch the Owner flips for a role takes effect', async () => {
    await rpc(ADMIN, 'admin_set_signups', [false, 'testing']);
    expect((await status()).signups_open).toBe(false);
    await rpc(OWNER, 'admin_set_permission', ['admin', 'site.signups', false, 'take it away']);
    await fails(rpc(ADMIN, 'admin_set_signups', [true, 'again']), 'admin_denied');
    await rpc(OWNER, 'admin_set_permission', ['admin', 'site.signups', true, 'give it back']);
    await rpc(ADMIN, 'admin_set_signups', [true, 'again']);
    expect((await status()).signups_open).toBe(true);
  });
  it('needs a reason for every change', async () => {
    await fails(rpc(OWNER, 'admin_set_maintenance', [true, 'x', '']), 'reason_required');
    await fails(rpc(OWNER, 'admin_set_notice', [true, 'x', 'info', ' ']), 'reason_required');
    await fails(rpc(OWNER, 'admin_set_game', ['crash', true, null]), 'reason_required');
    await fails(rpc(OWNER, 'admin_set_signups', [false, 'ab']), 'reason_required');
    await fails(rpc(OWNER, 'admin_set_countries', [['US'], '']), 'reason_required');
  });
  it('writes every change to the audit log with before and after', async () => {
    await rpc(OWNER, 'admin_set_maintenance', [true, 'Back at noon', 'database work']);
    let l = await lastLog('site.maintenance');
    expect(l.reason).toBe('database work'); expect(l.before).toEqual({ on: false, message: '' }); expect(l.after).toEqual({ on: true, message: 'Back at noon' }); expect(l.actor_role).toBe('owner');
    await rpc(OWNER, 'admin_set_notice', [true, 'Race ends tonight', 'warn', 'heads up']);
    l = await lastLog('site.notice'); expect(l.after).toEqual({ on: true, text: 'Race ends tonight', kind: 'warn' });
    await rpc(OWNER, 'admin_set_game', ['plinko', true, 'bug']);
    l = await lastLog('site.game'); expect(l.target_id).toBe('plinko'); expect(l.before).toEqual({ off: false }); expect(l.after).toEqual({ off: true });
    await rpc(OWNER, 'admin_set_signups', [false, 'invite only']);
    l = await lastLog('site.signups'); expect(l.before).toEqual({ open: true }); expect(l.after).toEqual({ open: false });
    await rpc(OWNER, 'admin_set_countries', [['de'], 'licence']);
    l = await lastLog('site.countries'); expect(l.before).toEqual({ blocked: [] }); expect(l.after).toEqual({ blocked: ['DE'] });
  });
});

describe('maintenance mode', () => {
  it('shows in the status, with its message', async () => {
    await rpc(OWNER, 'admin_set_maintenance', [true, '  Back in ten minutes ', 'update']);
    const s = await status(null);
    expect(s.maintenance).toBe(true); expect(s.maintenance_message).toBe('Back in ten minutes');
    await rpc(OWNER, 'admin_set_maintenance', [false, '', 'done']);
    expect((await status(null)).maintenance).toBe(false);
  });
  it('refuses messages over 200 characters', async () => {
    await fails(rpc(OWNER, 'admin_set_maintenance', [true, 'x'.repeat(201), 'long']), 'text_too_long');
  });
  it('blocks new play for players but never for staff', async () => {
    await rpc(OWNER, 'admin_set_maintenance', [true, '', 'update']);
    await fails(rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1'), 'maintenance');
    await fails(rpc(PLAYER, 'claim_free', ['daily_case'], 'aal1'), 'maintenance');
    expect((await rpc(OWNER, 'create_live_coinflip', ['bolt', 5])).id).toBeGreaterThan(0);          // the Owner can still test the site
    expect((await status(OWNER)).staff).toBe(true);
  });
  it('never traps a stake: a player can still cancel a game they opened before maintenance', async () => {
    const flip = await rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1');
    await rpc(OWNER, 'admin_set_maintenance', [true, '', 'update']);
    const r = await rpc(PLAYER, 'cancel_live_coinflip', [flip.id], 'aal1');
    expect(r.status).toBe('cancelled');
  });
});

describe('game switches', () => {
  const CALLS: [string, string, unknown[]][] = [
    ['battles', 'create_live_battle', [['x'], '1v1', 'normal']], ['battles', 'join_live_battle', ['99999999-9999-4999-8999-999999999999', null]],
    ['battles', 'call_live_bot', ['99999999-9999-4999-8999-999999999999', 1, 'Bot']],
    ['coinflip', 'create_live_coinflip', ['bolt', 5]], ['coinflip', 'join_live_coinflip', [1]], ['coinflip', 'call_live_coinflip_bot', [1, 'Bot']],
    ['crash', 'crash_place_bet', [1, 5, null, false]], ['crash', 'place_bet', ['crash', 5, '{}', null]], ['double', 'double_place_bet', [1, 'purple', 5, false]],
  ];
  it('lists the games that can be switched', async () => {
    expect((await rpc(OWNER, 'admin_get_controls')).games).toEqual(['cases', 'battles', 'upgrade', 'crash', 'double', 'plinko', 'mines', 'coinflip']);
  });
  it('every guarded entry point refuses when its game is off, and when maintenance is on', async () => {
    for (const g of ['battles', 'coinflip', 'crash', 'double']) await rpc(OWNER, 'admin_set_game', [g, true, 'test']);
    for (const [, fn, args] of CALLS) await fails(rpc(PLAYER, fn, args, 'aal1'), 'game_off');
    await reset();
    await rpc(OWNER, 'admin_set_maintenance', [true, '', 'test']);
    for (const [, fn, args] of CALLS) await fails(rpc(PLAYER, fn, args, 'aal1'), 'maintenance');
    await fails(rpc(PLAYER, 'claim_free', ['daily_case'], 'aal1'), 'maintenance');
  });
  it('switching one game off leaves the others working', async () => {
    await rpc(OWNER, 'admin_set_game', ['coinflip', true, 'bug']);
    expect((await status()).games_off).toEqual(['coinflip']);
    await fails(rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1'), 'game_off');
    await fails(rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1'), 'game_off');
    const claim = await rpc(PLAYER, 'claim_free', ['daily_case'], 'aal1');                    // not a game: still works
    expect(claim).toBeTruthy();
    await rpc(OWNER, 'admin_set_game', ['coinflip', false, 'fixed']);
    expect((await status()).games_off).toEqual([]);
    expect((await rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1')).id).toBeGreaterThan(0);
  });
  it('keeps the list sorted, without duplicates, and refuses unknown games', async () => {
    await rpc(OWNER, 'admin_set_game', ['mines', true, 'aaa']); await rpc(OWNER, 'admin_set_game', ['crash', true, 'aaa']); await rpc(OWNER, 'admin_set_game', ['mines', true, 'again']);
    expect((await status()).games_off).toEqual(['crash', 'mines']);
    await fails(rpc(OWNER, 'admin_set_game', ['poker', true, 'nope']), 'unknown_game');
    await fails(rpc(OWNER, 'admin_set_game', [null, true, 'nope']), 'unknown_game');
  });
  it('a paused game can still be left: cancelling and cashing out stay open', async () => {
    const flip = await rpc(PLAYER, 'create_live_coinflip', ['star', 5], 'aal1');
    await rpc(OWNER, 'admin_set_game', ['coinflip', true, 'bug']);
    expect((await rpc(PLAYER, 'cancel_live_coinflip', [flip.id], 'aal1')).status).toBe('cancelled');
    const src = (await sql(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.proname in ('cancel_live_coinflip', 'leave_live_battle', 'crash_cashout', 'crash_cancel_bet')`)).map(r => r.d as string);
    expect(src).toHaveLength(4);
    for (const d of src) expect(d).not.toContain('site_guard');
  });
});

describe('sign-ups', () => {
  it('refuses a NEW profile when sign-ups are closed, but a returning player is not affected', async () => {
    await rpc(OWNER, 'admin_set_signups', [false, 'invite only']);
    await fails(rpc(NEWBIE, 'complete_signup', ['Fresh', TERMS, true], 'aal1'), 'signups_closed');
    const again = await rpc(PLAYER, 'complete_signup', ['Nova', TERMS, true], 'aal1');
    expect(again.created).toBe(false);
    expect(await sql(`select 1 from public.profiles where id = $1`, [NEWBIE])).toHaveLength(0);
    await rpc(OWNER, 'admin_set_signups', [true, 'open again']);
    expect((await rpc(NEWBIE, 'complete_signup', ['Fresh', TERMS, true], 'aal1')).created).toBe(true);
  });
  it('also refuses a new profile during maintenance', async () => {
    await rpc(OWNER, 'admin_set_maintenance', [true, '', 'update']);
    await fails(rpc(NEWBIE2, 'complete_signup', ['Fresh2', TERMS, true], 'aal1'), 'maintenance');
  });
});

describe('the site notice', () => {
  it('shows text and kind, and hides when turned off', async () => {
    await rpc(OWNER, 'admin_set_notice', [true, '  Double is paused for 10 minutes ', 'warn', 'heads up']);
    expect((await status(null)).notice).toEqual({ text: 'Double is paused for 10 minutes', kind: 'warn' });
    await rpc(OWNER, 'admin_set_notice', [false, '', 'info', 'over']);
    expect((await status(null)).notice).toBeNull();
  });
  it('needs text when on, a known kind, and at most 300 characters', async () => {
    await fails(rpc(OWNER, 'admin_set_notice', [true, '  ', 'info', 'because']), 'text_required');
    await fails(rpc(OWNER, 'admin_set_notice', [true, 'hi', 'loud', 'because']), 'invalid_value');
    await fails(rpc(OWNER, 'admin_set_notice', [true, 'x'.repeat(301), 'info', 'because']), 'text_too_long');
  });
  it('does not stop anyone from playing', async () => {
    await rpc(OWNER, 'admin_set_notice', [true, 'Hello', 'info', 'because']);
    expect((await rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1')).id).toBeGreaterThan(0);
  });
});

describe('country restrictions', () => {
  it('normalises the list: upper case, trimmed, sorted, without duplicates, and can be cleared', async () => {
    const r = await rpc(OWNER, 'admin_set_countries', [['us', ' gb', 'US', 'de'], 'licence']);
    expect(r.blocked_countries).toEqual(['DE', 'GB', 'US']);
    expect((await rpc(OWNER, 'admin_set_countries', [[], 'lifted'])).blocked_countries).toEqual([]);
  });
  it('refuses anything that is not a two-letter code', async () => {
    for (const bad of [['USA'], ['U'], ['1A'], [''], ['U$'], [null]]) await fails(rpc(OWNER, 'admin_set_countries', [bad, 'because']), 'invalid_country');
    await fails(rpc(OWNER, 'admin_set_countries', [Array.from({ length: 251 }, () => 'US'), 'because']), 'invalid_country');
  });
  it('blocks a player connecting from a listed country, and nobody else', async () => {
    await rpc(OWNER, 'admin_set_countries', [['US', 'GB'], 'licence']);
    country = 'US';
    const s = await status();
    expect(s.country).toBe('US'); expect(s.country_blocked).toBe(true);
    await fails(rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1'), 'country_blocked');
    await fails(rpc(PLAYER, 'claim_free', ['daily_case'], 'aal1'), 'country_blocked');
    await fails(rpc(NEWBIE2, 'complete_signup', ['Fresh2', TERMS, true], 'aal1'), 'country_blocked');
    country = 'DE';
    expect((await status()).country_blocked).toBe(false);
    expect((await rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1')).id).toBeGreaterThan(0);
  });
  it('lets staff in from a blocked country, and visitors with an unknown country', async () => {
    await rpc(OWNER, 'admin_set_countries', [['US'], 'licence']);
    country = 'US';
    expect((await status(OWNER)).country_blocked).toBe(true);                       // reported honestly...
    expect((await rpc(OWNER, 'create_live_coinflip', ['bolt', 5])).id).toBeGreaterThan(0);   // ...but staff are not held back
    country = 'XX'; expect((await status()).country).toBeNull();
    expect((await rpc(PLAYER, 'create_live_coinflip', ['bolt', 5], 'aal1')).id).toBeGreaterThan(0);
    country = null; expect((await status()).country).toBeNull();
  });
  it('never stores the country or an address anywhere', async () => {
    country = 'US'; await status();
    const cols = await sql(`select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name ~* '(^|_)(country|ip|ip_address)($|_)'`);
    expect(cols).toEqual([]);
  });
});
