// @vitest-environment node
// A database where 0007 (site controls) was run LAST, after 0008 to 0012, must end up working exactly like one where it ran in order: 0007 adds the
// site_guard function the wallet games call, and puts the guard into the older entry points that do not have it yet (sign-up, free crates, the Crash demo).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { realItemMigrations } from './helpers.js';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const P = '44444444-4444-4444-4444-444444444444';
const NEW = '55555555-5555-5555-5555-555555555555';
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
  insert into auth.users (id, email) values ('${P}', 'p@example.com'), ('${NEW}', 'n@example.com');
`;
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string, fn: string, ...args: unknown[]): Promise<any> => as(uid, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: unknown }).v);
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const def = async (fn: string): Promise<string> => (await sql(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.proname = $1`, [fn]))[0].d as string;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  const run = async (m: string) => db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin']) await run(m);
  await rpc(P, 'complete_signup', 'Nova', '2026-11-21', true);                                // an account that already exists
  for (const m of ['0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', ...realItemMigrations()]) await run(m);
  await run('0007_site_controls');                                                            // run last, as it happened on the real database
}, 120_000);
afterAll(async () => { await db.close(); });

describe('0007 run after 0008 to 0012', () => {
  it('adds site_guard and puts the guard into the older entry points that lacked it', async () => {
    for (const fn of ['complete_signup', 'claim_free', 'place_bet', 'create_live_coinflip', 'crash_place_bet', 'create_live_battle']) expect(await def(fn), fn).toContain('site_guard');
    expect(await sql(`select 1 from public.site_controls`)).toHaveLength(1);
  });
  it('the wallet games and rewards work, and the switches reach them', async () => {
    await sql(`update public.wallets set balance = 100 where user_id = $1`, [P]);
    expect((await rpc(P, 'claim_faucet')).claimed).toBe(true);
    expect((await rpc(P, 'open_cases', 'starter', 1)).opened).toHaveLength(1);
    expect((await rpc(P, 'create_live_coinflip', 'bolt', 5)).id).toBeGreaterThan(0);
    expect((await rpc(P, 'open_free_case', 'welcome')).claimed).toBe(true);
    expect((await rpc(P, 'site_status')).maintenance).toBe(false);
    await sql(`update public.site_controls set games_off = '{cases}'`);
    await expect(rpc(P, 'open_cases', 'starter', 1)).rejects.toThrow('game_off');
    await sql(`update public.site_controls set games_off = '{}', signups_open = false`);
    await expect(rpc(NEW, 'complete_signup', 'Fresh', '2026-11-21', true)).rejects.toThrow('signups_closed');
    expect((await rpc(P, 'complete_signup', 'Nova', '2026-11-21', true)).created).toBe(false);        // a returning player is not affected
  });
});
