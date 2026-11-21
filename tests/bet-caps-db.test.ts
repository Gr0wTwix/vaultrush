// @vitest-environment node
// Migration 0017: verification is only needed above 10,000 coins. The most one stake may cost is 10,000 for a new account, 25,000 at level 1 and 50,000 at level 2,
// the same numbers as TIER_MAX_BET in src/kyc.ts. Checked on every kind of stake: a plain bet, a coinflip, Crash, Double and a case battle.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TIER_MAX_BET } from '../src/kyc.js';

vi.setConfig({ testTimeout: 60_000 });

const U = ['44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', '66666666-6666-4666-8666-666666666666'] as const;   // levels 0, 1 and 2
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
  insert into auth.users (id, email) values ${U.map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
`;
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '{}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string, fn: string, ...args: unknown[]): Promise<any> => as(uid, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const fails = async (p: Promise<unknown>, msg: string) => { await expect(p).rejects.toThrow(msg); };
const fund = (uid: string, amount = 500_000) => sql(`update public.wallets set balance = $2 where user_id = $1`, [uid, amount]);
const CAP = [TIER_MAX_BET[0], TIER_MAX_BET[1], TIER_MAX_BET[2]] as const;
const cents = (n: number) => Math.round((n + 0.01) * 100) / 100;                          // the smallest amount above n

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps'])
    await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [i, id] of U.entries()) {
    await rpc(id, 'complete_signup', `Player${i}`, TERMS, true);
    await sql(`update public.account_controls set kyc_tier = $2 where user_id = $1`, [id, i]);
  }
}, 120_000);
afterAll(async () => { await db.close(); });

describe('the caps', () => {
  it('are 10,000, 25,000 and 50,000, and the page uses the same numbers', () => {
    expect(CAP).toEqual([10_000, 25_000, 50_000]);
  });

  it('let a plain bet up to the level\'s cap through, and refuse one cent more as needing verification', async () => {
    for (const [i, id] of U.entries()) {
      await fund(id);
      await rpc(id, 'plinko_drop', 12, 'normal', CAP[i]!);                                                  // exactly the cap: allowed
      await fund(id);
      await fails(rpc(id, 'plinko_drop', 12, 'normal', cents(CAP[i]!)), 'tier_cap_exceeded');               // one cent more: needs a higher level
    }
  });

  it('a new account can stake 10,000 without verifying, where it could only stake 1,000 before', async () => {
    await fund(U[0]);
    await rpc(U[0], 'plinko_drop', 12, 'normal', 5000);                                                     // used to be refused (cap 1,000)
    await rpc(U[0], 'plinko_drop', 12, 'normal', 10_000);
  });
});

describe('every kind of stake obeys them', () => {
  it('coinflip: up to the cap, the cap is the only limit up to 50,000, and above that the stake itself is refused', async () => {
    for (const [i, id] of U.entries()) {
      await fund(id);
      expect((await rpc(id, 'create_live_coinflip', 'bolt', CAP[i]!)).id).toBeTruthy();
      await fails(rpc(id, 'create_live_coinflip', 'bolt', cents(CAP[i]!)), i === 2 ? 'invalid_amount' : 'tier_cap_exceeded');
    }
  });

  it('Crash: up to the cap, one cent more needs a higher level (above the top level the stake is invalid)', async () => {
    for (const [i, id] of U.entries()) {
      await fund(id);
      const round = (await rpc(id, 'advance_round', 'crash')).round;
      await fails(rpc(id, 'crash_place_bet', round.id, cents(CAP[i]!), null, false), i === 2 ? 'invalid_amount' : 'tier_cap_exceeded');
      expect(await rpc(id, 'crash_place_bet', round.id, CAP[i]!, null, false)).toBeTruthy();
    }
  });

  it('Double: up to the cap, one cent more needs a higher level (above the top level the stake is invalid)', async () => {
    for (const [i, id] of U.entries()) {
      await fund(id);
      const round = (await rpc(id, 'advance_round', 'double')).round;
      await fails(rpc(id, 'double_place_bet', round.id, 'green', cents(CAP[i]!), false), i === 2 ? 'invalid_amount' : 'tier_cap_exceeded');
      expect(await rpc(id, 'double_place_bet', round.id, 'green', CAP[i]!, false)).toBeTruthy();
    }
  });

  it('a case battle: its whole cost counts as one stake', async () => {
    await sql(`update public.catalog_cases set price = 600 where id = 'starter'`);                          // 16 cases = 9,600; 17 = 10,200; 20 = 12,000
    const cases = (n: number) => Array.from({ length: n }, () => 'starter');
    await fund(U[0]); await fund(U[1]);
    expect((await rpc(U[0], 'create_live_battle', cases(16), '1v1', 'normal')).id).toBeTruthy();            // 9,600: no verification needed
    await fails(rpc(U[0], 'create_live_battle', cases(17), '1v1', 'normal'), 'tier_cap_exceeded');          // 10,200: needs verification
    expect((await rpc(U[1], 'create_live_battle', cases(20), '1v1', 'normal')).id).toBeTruthy();            // 12,000: fine at level 1
    await fund(U[2]);
    expect((await rpc(U[2], 'create_live_battle', cases(20), '1v1', 'normal')).id).toBeTruthy();
  });
});

describe('the migration', () => {
  it('can be run a second time without changing anything, and no 5,000 limit is left in the live games', async () => {
    const before = (await sql(`select pg_get_functiondef('public.wallet_gate(uuid, numeric)'::regprocedure) as d`))[0].d;
    await db.exec(readFileSync(new URL('../supabase/migrations/0017_bet_caps.sql', import.meta.url), 'utf8'));
    expect((await sql(`select pg_get_functiondef('public.wallet_gate(uuid, numeric)'::regprocedure) as d`))[0].d).toBe(before);
    expect(before).toContain('10000'); expect(before).not.toContain('then 1000 when');
    for (const fn of ['create_live_coinflip', 'crash_place_bet', 'double_place_bet']) {
      const d = (await sql(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.proname = $1`, [fn]))[0].d as string;
      expect(d, fn).toContain('p_amount > 50000'); expect(d, fn).not.toMatch(/p_amount > 5000\b/);
    }
  });
});
