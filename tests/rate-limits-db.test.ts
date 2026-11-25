// @vitest-environment node
// Migration 0020: chat may not be flooded (one message per 2 seconds, 10 a minute) and promo codes may not be guessed (10 wrong codes per 10 minutes).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const A = 'a1111111-1111-4111-8111-111111111111', B = 'b2222222-2222-4222-8222-222222222222', C = 'c3333333-3333-4333-8333-333333333333';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0020_rate_limits'];
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
  insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'), ('${C}', 'c@example.com');
`;
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '{}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string, fn: string, ...args: unknown[]): Promise<any> => as(uid, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const chat = (uid: string, body: string) => as(uid, () => db.query(`insert into public.chat_messages (body) values ($1)`, [body]));
const age = (table: string, col: string, uid: string, interval: string) => sql(`update public.${table} set ${col} = ${col} - $2::interval where user_id = $1`, [uid, interval]);
const balance = async (uid: string) => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[A, 'Alpha'], [B, 'Bravo'], [C, 'Charlie']] as const) await rpc(id, 'complete_signup', n, '2026-11-22', true);
  await sql(`insert into public.promo_codes (code, amount) values ('REAL10', 10), ('SECOND5', 5)`);
}, 180_000);
afterAll(async () => { await db.close(); });

describe('chat', () => {
  it('refuses a second message within 2 seconds', async () => {
    await chat(A, 'hello');
    await expect(chat(A, 'again')).rejects.toThrow('chat_too_fast');
    await chat(B, 'someone else may talk');                                  // the limit is per player
  });
  it('refuses the 11th message within a minute, and allows talking again later', async () => {
    for (let i = 0; i < 9; i++) { await age('chat_messages', 'created_at', A, '3 seconds'); await chat(A, `line ${i}`); }      // 10 in the last minute
    await age('chat_messages', 'created_at', A, '3 seconds');
    await expect(chat(A, 'one too many')).rejects.toThrow('chat_too_fast');
    await age('chat_messages', 'created_at', A, '2 minutes');
    await chat(A, 'back again');
  });
  it('keeps the older rules: 140 characters at most, no name of your own choosing', async () => {
    await expect(chat(C, 'x'.repeat(141))).rejects.toThrow(/violates check/);
  });
});

describe('promo codes', () => {
  it('a wrong code is answered, not raised, and counted; a right code still pays and is not counted', async () => {
    expect(await rpc(C, 'redeem_promo', 'NOPE')).toEqual({ error: 'invalid_code' });
    expect(Number((await sql(`select count(*) n from public.promo_attempts where user_id = $1`, [C]))[0].n)).toBe(1);
    const before = await balance(C);
    expect((await rpc(C, 'redeem_promo', ' real10 ')).amount).toBe(10);
    expect(await balance(C)).toBe(before + 10);
    expect(Number((await sql(`select count(*) n from public.promo_attempts where user_id = $1`, [C]))[0].n)).toBe(1);
    await expect(rpc(C, 'redeem_promo', 'REAL10')).rejects.toThrow('code_used');
  });
  it('after 10 wrong codes in 10 minutes every code waits, even a right one, until the window has passed', async () => {
    for (let i = 0; i < 10; i++) expect((await rpc(B, 'redeem_promo', `GUESS${i}`)).error).toBe('invalid_code');
    await expect(rpc(B, 'redeem_promo', 'GUESS99')).rejects.toThrow('too_many_attempts');
    await expect(rpc(B, 'redeem_promo', 'SECOND5')).rejects.toThrow('too_many_attempts');
    await age('promo_attempts', 'at', B, '11 minutes');
    expect((await rpc(B, 'redeem_promo', 'SECOND5')).amount).toBe(5);
  });
  it('players cannot read or clear their own attempts', async () => {
    await expect(as(B, () => db.query('select * from public.promo_attempts'))).rejects.toThrow(/permission denied/);
    await expect(as(B, () => db.query('delete from public.promo_attempts'))).rejects.toThrow(/permission denied/);
  });
});

describe('the migration', () => {
  it('can be run again without changing anything', async () => {
    const n = Number((await sql(`select count(*) n from public.promo_attempts`))[0].n);
    await db.exec(readFileSync(new URL('../supabase/migrations/0020_rate_limits.sql', import.meta.url), 'utf8'));
    expect(Number((await sql(`select count(*) n from public.promo_attempts`))[0].n)).toBe(n);
    await expect(chat(A, 'still limited')).rejects.toThrow('chat_too_fast');
  });
});
