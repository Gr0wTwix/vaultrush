// @vitest-environment node
// Migration 0016 (alerts and the daily report for n8n) in an in-process Postgres. pg_net is not in PGlite, so a stand-in `net.http_post` records every request that
// would have gone out. Checked: nothing is sent until it is switched on; each event sends the right small message; the event list and the big-win threshold are
// obeyed; an alert can never break a bet, a sign-up or an admin action; browsers can neither read the secret nor send alerts; and the daily report is guarded by the
// secret and its numbers match what was inserted.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const A = '44444444-4444-4444-4444-444444444444';
const B = '55555555-5555-5555-5555-555555555555';
const TERMS = '2026-11-21', HOOK = 'https://n8n.example.com/webhook/vaultrush-events', SECRET = 'test-secret-0123456789abcdef';
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
  insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
  -- a stand-in for Supabase's pg_net: records the requests instead of sending them
  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
`;
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const calls = () => sql(`select url, body, headers from net.calls order by id`);
async function as<T>(role: 'anon' | 'authenticated', uid: string | null, headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '${JSON.stringify(headers)}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.headers', '', false);`); }
}
const rpcAs = (role: 'anon' | 'authenticated', uid: string | null, headers: Record<string, string>, fn: string, ...args: unknown[]) =>
  as(role, uid, headers, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const report = (secret: string | null, ...args: unknown[]) => rpcAs('anon', null, secret === null ? {} : { 'x-ops-secret': secret }, 'ops_daily_report', ...args);
const fails = async (p: Promise<unknown>, msg: string | RegExp) => { await expect(p).rejects.toThrow(msg); };
const on = (extra = '') => sql(`update public.ops_settings set enabled = true, webhook_url = '${HOOK}', webhook_secret = '${SECRET}' ${extra} where id = 1`);
const off = () => sql(`update public.ops_settings set enabled = false, webhook_url = '', webhook_secret = '', big_win_min = 1000, events = array['signup', 'big_win', 'adjustment', 'admin', 'maintenance'] where id = 1`);
const addBet = (uid: string, game: string, amount: number, payout: number, ago = '0 seconds') =>
  sql(`insert into public.bets (user_id, game, amount, payout, multiplier, created_at) values ($1, $2, $3, $4, $5, now() - $6::interval)`, [uid, game, amount, payout, amount > 0 ? Math.round((payout / amount) * 100) / 100 : 0, ago]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  const run = (m: string) => db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0016_ops_events']) await run(m);
  for (const [id, n] of [[A, 'Alice'], [B, 'Bob']] as const) await rpcAs('authenticated', id, {}, 'complete_signup', n, TERMS, true);     // before it is switched on: nothing is sent
}, 120_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await off(); await sql(`truncate net.calls`); });

describe('switched off (the default)', () => {
  it('has the settings row, switched off, with the default events, and sends nothing', async () => {
    const s = (await sql(`select * from public.ops_settings`))[0];
    expect(s.enabled).toBe(false); expect(s.webhook_url).toBe(''); expect(s.events).toEqual(['signup', 'big_win', 'adjustment', 'admin', 'maintenance']);
    await addBet(A, 'plinko', 10, 5000);
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'adjustment', 50, 50)`, [A]);
    expect(await calls()).toEqual([]);
  });
  it('sends nothing when it is on but the address is missing or not https', async () => {
    await sql(`update public.ops_settings set enabled = true, webhook_url = '', webhook_secret = '${SECRET}' where id = 1`);
    await addBet(A, 'plinko', 10, 5000);
    await sql(`update public.ops_settings set webhook_url = 'http://insecure.example.com/hook' where id = 1`);
    await addBet(A, 'plinko', 10, 5000);
    expect(await calls()).toEqual([]);
  });
});

describe('the events', () => {
  it('a new player: the name only', async () => {
    await on();
    await sql(`insert into auth.users (id, email) values ('99999999-9999-4999-8999-999999999999', 'new@example.com')`);
    await rpcAs('authenticated', '99999999-9999-4999-8999-999999999999', {}, 'complete_signup', 'Nova', TERMS, true);
    const c = await calls();
    expect(c).toHaveLength(1);
    expect(c[0].url).toBe(HOOK);
    expect(c[0].body.event).toBe('signup'); expect(c[0].body.data).toEqual({ name: 'Nova' }); expect(typeof c[0].body.at).toBe('string');
    expect(c[0].headers['X-Vaultrush-Secret']).toBe(SECRET); expect(c[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.stringify(c[0])).not.toMatch(/new@example\.com/);                    // no e-mail address ever leaves
  });
  it('a big win: from the threshold up, only when the player won more than the stake', async () => {
    await on(`, big_win_min = 500`);
    await addBet(A, 'crash', 100, 499);                 // under the threshold
    await addBet(A, 'coinflip', 600, 600);              // a push: not more than the stake
    await addBet(A, 'coinflip', 600, 0);                // a loss
    expect(await calls()).toEqual([]);
    await addBet(A, 'plinko', 50, 900);
    const c = await calls();
    expect(c).toHaveLength(1);
    expect(c[0].body).toMatchObject({ event: 'big_win', data: { name: 'Alice', game: 'plinko', amount: 50, payout: 900, multiplier: 18 } });
  });
  it('coins added by hand are reported; the zeroing that closes an account and other ledger lines are not', async () => {
    await on();
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'adjustment', 250, 250)`, [A]);
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'adjustment', -250, 0)`, [A]);
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'faucet', 25, 25)`, [A]);
    const c = await calls();
    expect(c).toHaveLength(1);
    expect(c[0].body).toMatchObject({ event: 'adjustment', data: { name: 'Alice', amount: 250, balance_after: 250 } });
  });
  it('an admin action: what and who and why, never the before/after values', async () => {
    await on();
    await sql(`insert into public.admin_audit_log (actor_name, actor_role, action, target_type, target_id, before, after, reason) values ('Owner', 'owner', 'site.maintenance', 'site', 'controls', '{"secret":"x"}', '{"secret":"y"}', 'updating the catalogue')`);
    const c = await calls();
    expect(c).toHaveLength(1);
    expect(c[0].body.data).toEqual({ action: 'site.maintenance', actor: 'Owner', role: 'owner', target_type: 'site', target_id: 'controls', reason: 'updating the catalogue' });
  });
  it('maintenance switched on or off, but not other changes to the settings row', async () => {
    await on();
    await sql(`update public.site_controls set notice_on = true where id = 1`);
    expect(await calls()).toEqual([]);
    await sql(`update public.site_controls set maintenance_on = true, maintenance_message = 'back soon' where id = 1`);
    await sql(`update public.site_controls set maintenance_on = false where id = 1`);
    const c = await calls();
    expect(c.map(x => [x.body.event, x.body.data.on])).toEqual([['maintenance', true], ['maintenance', false]]);
    expect(c[0].body.data.message).toBe('back soon');
    await sql(`update public.site_controls set notice_on = false where id = 1`);
  });
  it('only the events in the list are sent, and a test message always goes (when switched on)', async () => {
    await on(`, events = array['big_win']`);
    await sql(`insert into auth.users (id, email) values ('88888888-8888-4888-8888-888888888888', 'x@example.com')`);
    await rpcAs('authenticated', '88888888-8888-4888-8888-888888888888', {}, 'complete_signup', 'Quill', TERMS, true);
    expect(await calls()).toEqual([]);
    await sql(`select public.ops_notify('test', '{"hello": "world"}')`);
    const c = await calls();
    expect(c).toHaveLength(1); expect(c[0].body).toMatchObject({ event: 'test', data: { hello: 'world' } });
    await off(); await sql(`truncate net.calls`);
    await sql(`select public.ops_notify('test', '{}')`);
    expect(await calls()).toEqual([]);                                               // switched off: not even a test
  });
});

describe('an alert can never break anything', () => {
  it('a bet, a hand adjustment and an admin action still go through when sending fails', async () => {
    await on();
    await db.exec(`create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$ begin raise exception 'the network is down'; end $$`);
    try {
      await addBet(A, 'plinko', 10, 5000);
      await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'adjustment', 5, 5)`, [A]);
      await sql(`insert into public.admin_audit_log (action) values ('test.action')`);
      expect((await sql(`select count(*)::int as n from public.bets where payout = 5000`))[0].n).toBeGreaterThan(0);
    } finally {
      await db.exec(`drop function net.http_post(text, jsonb, jsonb, jsonb, integer)`);
      await db.exec(`create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$`);
    }
  });
  it('is harmless when the pg_net extension is missing altogether', async () => {
    await on();
    await db.exec(`alter schema net rename to net_gone`);
    try { await addBet(A, 'plinko', 10, 5000); await sql(`select public.ops_notify('test', '{}')`); } finally { await db.exec(`alter schema net_gone rename to net`); }
    expect(await calls()).toEqual([]);
  });
  it('can be run a second time (it is how the file is updated)', async () => {
    await db.exec(readFileSync(new URL('../supabase/migrations/0016_ops_events.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.ops_settings`))[0].n).toBe(1);
    expect((await sql(`select count(*)::int as n from pg_trigger where tgname like 'ops\\_%'`))[0].n).toBe(5);
  });
});

describe('browsers cannot see or use any of it', () => {
  it('cannot read or change the settings (the secret lives there), and cannot send alerts', async () => {
    await on();
    for (const role of ['anon', 'authenticated'] as const) {
      await as(role, role === 'anon' ? null : A, {}, async () => {
        await fails(db.query(`select webhook_secret from public.ops_settings`), 'permission denied');
        await fails(db.query(`update public.ops_settings set enabled = false`), 'permission denied');
        await fails(db.query(`select public.ops_notify('test', '{}')`), 'permission denied');
      });
    }
  });
});

describe('the daily report', () => {
  it('refuses without the secret, with a wrong one, and when no secret is set', async () => {
    await on();
    await fails(report(null), 'forbidden'); await fails(report('wrong'), 'forbidden'); await fails(report(''), 'forbidden');
    await fails(rpcAs('authenticated', A, { 'x-ops-secret': SECRET.toUpperCase() }, 'ops_daily_report'), 'forbidden');
    await off();
    await fails(report(''), 'forbidden'); await fails(report(null), 'forbidden');       // an empty secret never matches an empty setting
  });
  it('is callable with only the public key and the secret, and its numbers match the data', async () => {
    await on();
    await sql(`truncate public.bets cascade`);
    await sql(`truncate public.ledger`);
    await addBet(A, 'plinko', 10, 0); await addBet(A, 'plinko', 20, 50); await addBet(B, 'crash', 100, 0); await addBet(B, 'cases', 5, 4);
    await addBet(A, 'plinko', 1000, 9999, '3 days');           // older than the window: not counted
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'faucet', 25, 25), ($1, 'promo', 10, 35), ($1, 'adjustment', 40, 75), ($1, 'adjustment', -75, 0), ($2, 'bet', -10, 0)`, [A, B]);
    await sql(`update public.wallets set balance = 120 where user_id = $1`, [A]); await sql(`update public.wallets set balance = 30 where user_id = $1`, [B]);
    await sql(`truncate net.calls`);
    const r = await report(SECRET);
    expect(r.hours).toBe(24);
    const players = (await sql(`select count(*)::int as n from public.profiles where deleted_at is null`))[0].n;      // earlier tests signed up more players in this database
    expect(players).toBeGreaterThanOrEqual(2);
    expect(r.players_total).toBe(players); expect(r.new_players).toBe(players); expect(r.active_players).toBe(2);
    expect(r.bets).toBe(4); expect(Number(r.wagered)).toBe(135); expect(Number(r.paid_out)).toBe(54); expect(Number(r.house_result)).toBe(81);
    expect(r.by_game.map((g: any) => [g.game, g.bets, Number(g.wagered), Number(g.paid_out)])).toEqual([['crash', 1, 100, 0], ['plinko', 2, 30, 50], ['cases', 1, 5, 4]]);
    expect(r.biggest_win).toEqual({ name: 'Alice', game: 'plinko', amount: 20, payout: 50 });
    expect(Number(r.coins_in_wallets)).toBe(150);
    expect(Number(r.free_coins_issued)).toBe(35); expect(Number(r.coins_adjusted)).toBe(40); expect(r.adjustments).toBe(1);
    expect(typeof r.items_held).toBe('number'); expect(Number(r.items_value)).toBeGreaterThanOrEqual(0);
    expect(r.maintenance_on).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/@example\.com|SECRET|webhook/i);           // no e-mail address and no setting leaks out
    expect(await calls()).toEqual([]);                                                // reading the report sends nothing
  });
  it('widens the window on request (and clamps it to 1 hour .. 7 days)', async () => {
    await on();
    await sql(`truncate public.bets cascade`);
    await addBet(A, 'plinko', 10, 20, '3 days'); await addBet(A, 'plinko', 10, 20, '30 minutes');
    expect((await report(SECRET)).bets).toBe(1);
    expect((await report(SECRET, 96)).bets).toBe(2);
    expect((await report(SECRET, 100000)).hours).toBe(168);
    expect((await report(SECRET, 0)).hours).toBe(1);
  });
  it('an empty day gives zeros, not errors', async () => {
    await on();
    await sql(`truncate public.bets cascade`); await sql(`truncate public.ledger`);
    const r = await report(SECRET);
    expect(r.bets).toBe(0); expect(r.by_game).toEqual([]); expect(r.biggest_win).toBeNull(); expect(Number(r.wagered)).toBe(0); expect(Number(r.house_result)).toBe(0);
  });
});
