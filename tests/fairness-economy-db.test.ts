// @vitest-environment node
// Migration 0027: the fairness audit (seeds re-checked against their published hashes, results recomputed) and the economy monitor.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { realItemMigrations } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', ...realItemMigrations(), '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits',
  '0021_admin_control', '0022_catalogue_editor', '0023_rewards_admin', '0024_events', '0025_game_settings', '0026_compliance', '0027_fairness_economy'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, P1, P2].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
`;
async function as<T>(uid: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal })}', false), set_config('request.headers', '{}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, args: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<any> =>
  as(uid, aal, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const play = (uid: string, fn: string, args: unknown[] = []): Promise<any> => rpc(uid, fn, args, 'aal1');
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const fails = async (p: Promise<unknown>, msg: string) => { await expect(p).rejects.toThrow(msg); };
const unlock = async (uid: string): Promise<void> => {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
};
const finishRound = async (game: 'crash' | 'double'): Promise<number> => {
  const r = (await sql(`select (public.advance_round_internal($1)).id as id`, [game]))[0];
  await sql(`update public.game_rounds set created_at = now() - interval '2 hours', betting_ends_at = now() - interval '2 hours' where id = $1`, [r.id]);
  await sql(`select public.advance_round_internal($1)`, [game]); await sql(`select public.advance_round_internal($1)`, [game]);
  return r.id;
};

let crashId = 0, flipId = 0;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [P1, 'Nova'], [P2, 'Orion']] as const) await play(id, 'complete_signup', [n, '2026-11-21', true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1)`, [OWNER, MOD]);
  for (const id of [OWNER, MOD]) await unlock(id);
  for (const id of [P1, P2]) await sql(`select public.wallet_credit($1, 1000, 'bonus')`, [id]);
  crashId = await finishRound('crash'); await finishRound('double');
  const f = await play(P1, 'create_live_coinflip', ['bolt', 20]);
  await play(P1, 'call_live_coinflip_bot', [f.id, 'frostbyte']); flipId = f.id;
  const b = await play(P2, 'create_live_battle', [['starter'], '1v1', 'normal']);
  await play(P2, 'call_live_bot', [b.id, 1, 'kappa_kid']);
  for (let i = 0; i < 5; i++) await play(P1, 'plinko_drop', [12, 'normal', 10]);
  await play(P2, 'open_cases', ['starter', 2, 'e1']);
  await play(P1, 'rotate_seed');
  await play(P1, 'claim_faucet');
}, 300_000);
afterAll(async () => { await db.close(); });

describe('fairness audit', () => {
  it('only staff with fairness.run can run it; everything checks out on honest data and the run is stored', async () => {
    await fails(rpc(MOD, 'admin_fairness_run', [3]), 'admin_denied');
    const r = await rpc(OWNER, 'admin_fairness_run', [3]);
    expect(r.summary.all_ok).toBe(true);
    expect(r.summary.rounds.checked).toBeGreaterThanOrEqual(2);
    expect(r.summary.coinflips).toEqual({ checked: 1, bad: 0 });
    expect(r.summary.battles).toEqual({ checked: 1, bad: 0 });
    expect(r.summary.seeds.checked).toBeGreaterThanOrEqual(1);
    expect(r.mismatches).toEqual([]);
    expect((await rpc(OWNER, 'admin_fairness_runs'))[0]).toMatchObject({ id: r.id, by: 'Mirage', days: 3 });
  });
  it('catches a recorded result that the seed does not give, and a seed that does not match its hash', async () => {
    await sql(`update public.game_rounds set result = '{"point": 99.99}' where id = $1`, [crashId]);
    await sql(`update public.live_coinflips set result = case result when 'bolt' then 'star' else 'bolt' end where id = $1`, [flipId]);
    await sql(`update public.seed_pairs set server_hash = repeat('0', 64) where id = (select id from public.seed_pairs where status = 'revealed' limit 1)`);
    const r = await rpc(OWNER, 'admin_fairness_run', [3]);
    expect(r.summary.all_ok).toBe(false);
    expect(r.mismatches).toEqual(expect.arrayContaining([
      { kind: 'crash', id: String(crashId), hash_ok: true, result_ok: false },
      { kind: 'coinflip', id: String(flipId), hash_ok: true, result_ok: false },
      expect.objectContaining({ kind: 'seed', hash_ok: false }),
    ]));
  });
});

describe('economy monitor', () => {
  it('needs economy.view and shows coins, flows, games against their maths, and the day-by-day picture', async () => {
    await fails(rpc(MOD, 'admin_economy', [30]), 'admin_denied');
    const e = await rpc(OWNER, 'admin_economy', [7]);
    expect(e.days).toBe(7);
    expect(e.now.coins).toBeGreaterThan(0);
    expect(e.now.top[0].balance).toBeGreaterThanOrEqual(e.now.top[1].balance);
    const kinds = e.flows.map((f: any) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['bonus', 'bet', 'faucet']));
    const plinko = e.games.find((g: any) => g.game === 'plinko');
    expect(plinko).toMatchObject({ bets: 5, staked: 50, expected: 0.97 });
    expect(plinko.take).toBeCloseTo(plinko.staked - plinko.paid, 2);
    const cases = e.games.find((g: any) => g.game === 'cases');
    expect(cases.expected).toBeGreaterThan(0.85); expect(cases.expected).toBeLessThan(0.95);            // the generated cases return about 90%
    const coin = e.games.find((g: any) => g.game === 'coinflip');
    expect(coin.expected).toBe(0.97);
    expect(e.daily).toHaveLength(7);
    expect(e.daily[6].free).toBeGreaterThan(0);
  });
  it('can be run a second time without changing anything', async () => {
    const before = (await sql(`select count(*)::int as n from public.fairness_runs`))[0].n;
    await db.exec(readFileSync(new URL('../supabase/migrations/0027_fairness_economy.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.fairness_runs`))[0].n).toBe(before);
  });
});
