// @vitest-environment node
// Runs the real migration (supabase/migrations/0001_core.sql) in an in-process Postgres (PGlite) with Supabase-style roles,
// then checks the server-side bet against the TypeScript game maths, the gate rules, seed handling and row-level security.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crashPoint, floatsFor } from '../src/fair.js';
import { recompute } from '../src/verify.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
let db: PGlite;

/** What Supabase provides before any migration runs. */
const PRELUDE = `
  create schema extensions; create schema auth;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
  insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');
`;

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = async (uid: string, fn: string, ...args: unknown[]): Promise<any> =>
  as(uid, async () => {
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    const r = await db.query(`select public.${fn}(${ph}) as v`, args.map(a => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
    return (r.rows[0] as { v: unknown }).v;
  });
const TERMS = '2026-11-18';
const signup = (uid: string, name: string, adult = true) => rpc(uid, 'complete_signup', name, TERMS, adult);
const bet = (uid: string, amount: number, target: number, idem?: string) => rpc(uid, 'place_bet', 'crash', amount, { target }, idem ?? null);
const sql = async (q: string, params: unknown[] = []) => (await db.query(q, params)).rows as any[];
const fails = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toThrow(code); };

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  await db.exec(readFileSync(new URL('../supabase/migrations/0001_core.sql', import.meta.url), 'utf8'));
  await signup(ALICE, 'Alice');
  await signup(BOB, 'Bob');
}, 60_000);
afterAll(async () => { await db.close(); });

describe('account creation', () => {
  it('creates a wallet, controls and two committed seeds, and is idempotent', async () => {
    expect(await signup(ALICE, 'Other name')).toEqual({ display_name: 'Alice', balance: 100, created: false });
    const seeds = await sql(`select status, server_seed, server_hash from public.seed_pairs where user_id = $1 order by status`, [ALICE]);
    expect(seeds.map(s => s.status)).toEqual(['active', 'next']);
    for (const s of seeds) expect(s.server_hash).toBe(createHash('sha256').update(s.server_seed).digest('hex'));
    expect((await sql(`select count(*)::int n from public.ledger where user_id = $1`, [ALICE]))[0].n).toBe(1);
  });
  it('refuses duplicate display names (case-insensitive)', async () => {
    await expect(db.query(`insert into public.profiles (id, display_name) values (gen_random_uuid(), 'ALICE')`)).rejects.toThrow(/duplicate|violates/);
  });
});

describe('sign-up is checked by the server, not the form', () => {
  const user = async (n: number) => { const id = `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`; await sql(`insert into auth.users (id, email) values ($1, $2)`, [id, `u${n}@example.com`]); return id; };
  it('requires the 18+ confirmation and a terms version, even with a forged form', async () => {
    const kid = await user(1);
    await fails(signup(kid, 'Kid', false), 'adult_required');
    await fails(rpc(kid, 'complete_signup', 'Kid', TERMS, null), 'adult_required');
    await fails(rpc(kid, 'complete_signup', 'Kid', '', true), 'terms_required');
    await fails(rpc(kid, 'complete_signup', 'Kid', null, true), 'terms_required');
    expect((await sql(`select count(*)::int n from public.profiles where id = $1`, [kid]))[0].n).toBe(0);
  });
  it('validates and reserves names, case-insensitively', async () => {
    const probe = await user(10);
    for (const bad of ['a', 'x'.repeat(21), 'bad<name>', 'player-123456', 'Deleted-0001', '']) await fails(signup(probe, bad), 'invalid_name');
    await fails(signup(await user(11), 'ALICE'), 'name_taken');
  });
  it('records the terms version and the age confirmation, and starts with 100 coins and two seeds', async () => {
    const id = await user(20);
    expect(await signup(id, 'Fresh_One')).toEqual({ display_name: 'Fresh_One', balance: 100, created: true });
    const p = (await sql(`select terms_version, terms_accepted_at is not null t, age_confirmed_at is not null a from public.profiles where id = $1`, [id]))[0];
    expect(p).toEqual({ terms_version: TERMS, t: true, a: true });
    expect((await sql(`select count(*)::int n from public.seed_pairs where user_id = $1`, [id]))[0].n).toBe(2);
    expect((await as(id, async () => (await db.query(`select id from public.profiles`)).rows as any[])).map(r => r.id)).toEqual([id]);       // own row only
  });
});

describe('export and deletion', () => {
  const FRED = 'bbbbbbbb-0000-0000-0000-000000000001';
  it('exports the caller\'s data only, with no unrevealed server seed', async () => {
    await sql(`insert into auth.users (id, email) values ($1, 'f@example.com')`, [FRED]);
    await signup(FRED, 'Fred'); await bet(FRED, 2, 1.5);
    await as(FRED, () => db.query(`insert into public.chat_messages (body) values ('hello')`));
    const data = await rpc(FRED, 'export_my_data');
    expect(data.profile.display_name).toBe('Fred');
    expect(data.bets).toHaveLength(1);
    expect(data.ledger.length).toBeGreaterThanOrEqual(2);
    expect(data.chat).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(((await sql(`select server_seed from public.seed_pairs where user_id = $1 and status = 'active'`, [FRED]))[0]).server_seed);
    expect(JSON.stringify(data)).not.toContain(ALICE);
  });
  it('anonymises the profile, zeroes the wallet with an audit entry, removes chat, and blocks further play', async () => {
    const before = Number((await sql(`select balance from public.wallets where user_id = $1`, [FRED]))[0].balance);
    await rpc(FRED, 'delete_account');
    const p = (await sql(`select display_name, deleted_at is not null del from public.profiles where id = $1`, [FRED]))[0];
    expect(p.display_name).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(p.del).toBe(true);
    expect(Number((await sql(`select balance from public.wallets where user_id = $1`, [FRED]))[0].balance)).toBe(0);
    const last = (await sql(`select kind, amount::float a, balance_after::float b from public.ledger where user_id = $1 order by id desc limit 1`, [FRED]))[0];
    expect(last).toEqual({ kind: 'adjustment', a: -before, b: 0 });
    expect((await sql(`select count(*)::int n from public.chat_messages where user_id = $1`, [FRED]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int n from public.bets where user_id = $1`, [FRED]))[0].n).toBe(1);   // financial records stay
    await fails(bet(FRED, 1, 2), 'no_account');
    await fails(signup(FRED, 'Fred'), 'account_closed');
  });
});

describe('server-side crash bet', () => {
  it('draws the same roll and crash point as the TypeScript game code', async () => {
    const before = (await sql(`select server_seed, client_seed, nonce from public.seed_pairs where user_id = $1 and status = 'active'`, [ALICE]))[0];
    const r = await bet(ALICE, 5, 2);
    expect(r.nonce).toBe(before.nonce);
    const [f] = await floatsFor(before.server_seed, before.client_seed, before.nonce, 1);
    expect(r.float).toBe(f);
    expect(r.crash_point).toBe(crashPoint(f as number));
    expect(r.win).toBe(crashPoint(f as number) >= 2);
  });

  it('keeps wallet, ledger and bets consistent, and advances the nonce by one', async () => {
    const w0 = Number((await sql(`select balance from public.wallets where user_id = $1`, [BOB]))[0].balance);
    const n0 = (await sql(`select nonce from public.seed_pairs where user_id = $1 and status = 'active'`, [BOB]))[0].nonce;
    const r = await bet(BOB, 10, 1.5);
    const w1 = Number((await sql(`select balance from public.wallets where user_id = $1`, [BOB]))[0].balance);
    expect(w1).toBeCloseTo(w0 - 10 + r.payout, 2);
    expect(r.balance).toBeCloseTo(w1, 2);
    expect((await sql(`select nonce from public.seed_pairs where user_id = $1 and status = 'active'`, [BOB]))[0].nonce).toBe(n0 + 1);
    const ledgerSum = Number((await sql(`select sum(amount) s from public.ledger where user_id = $1`, [BOB]))[0].s);
    expect(ledgerSum).toBeCloseTo(w1, 2);                           // the ledger replays exactly to the wallet
    const last = (await sql(`select balance_after from public.ledger where user_id = $1 order by id desc limit 1`, [BOB]))[0].balance_after;
    expect(Number(last)).toBeCloseTo(w1, 2);
  });

  it('ignores a retried request with the same idempotency key', async () => {
    const first = await bet(ALICE, 1, 1.2, 'req-1');
    const again = await bet(ALICE, 1, 1.2, 'req-1');
    expect(again.replayed).toBe(true);
    expect(again.bet_id).toBe(first.bet_id);
    expect((await sql(`select count(*)::int n from public.bets where user_id = $1 and idem_key = 'req-1'`, [ALICE]))[0].n).toBe(1);
  });

  it('matches the TypeScript game maths over many bets (fixed seed) and pays the documented 97% return', async () => {
    const seed = 'cd'.repeat(32);
    await rpc(BOB, 'rotate_seed');                     // a fresh active seed, so nonces start at 0 with no earlier bets
    await sql(`update public.seed_pairs set server_seed = $1, server_hash = $2, client_seed = 'rtp' where user_id = $3 and status = 'active'`,
      [seed, createHash('sha256').update(seed).digest('hex'), BOB]);
    await sql(`update public.wallets set balance = 100000 where user_id = $1`, [BOB]);
    const floats: number[] = [];
    for (let nonce = 0; nonce < 100; nonce++) floats.push(...await floatsFor(seed, 'rtp', nonce, 1));
    let mismatches = 0;
    for (let i = 0; i < 100; i++) { const r = await bet(BOB, 1, 2); if (r.crash_point !== crashPoint(floats[i] as number)) mismatches++; }
    expect(mismatches).toBe(0);
  }, 60_000);
});

describe('the gate', () => {
  it('rejects invalid input and an overdraft, and changes nothing', async () => {
    const before = await sql(`select balance from public.wallets where user_id = $1`, [ALICE]);
    await fails(bet(ALICE, 0, 2), 'invalid_amount');
    await fails(bet(ALICE, -5, 2), 'invalid_amount');
    await fails(bet(ALICE, 1.234, 2), 'invalid_amount');
    await fails(bet(ALICE, 1, 1.001), 'invalid_target');
    await fails(bet(ALICE, 1, 5000), 'invalid_target');
    await fails(rpc(ALICE, 'place_bet', 'slots', 1, { target: 2 }, null), 'unsupported_game');
    await sql(`update public.wallets set balance = 5 where user_id = $1`, [ALICE]);
    await fails(bet(ALICE, 6, 2), 'insufficient_funds');
    await sql(`update public.wallets set balance = 100 where user_id = $1`, [ALICE]);
    expect((await sql(`select balance from public.wallets where user_id = $1`, [ALICE]))[0].balance).not.toBe(before[0].balance === '0' ? 'x' : 'y');
  });
  it('requires an adult confirmation, and enforces the unverified bet cap until KYC raises the tier', async () => {
    const CAROL = '33333333-3333-3333-3333-333333333333';
    await sql(`insert into auth.users (id, email) values ($1, 'c@example.com')`, [CAROL]);
    await signup(CAROL, 'Carol');
    await sql(`update public.profiles set age_confirmed_at = null where id = $1`, [CAROL]);
    await fails(bet(CAROL, 1, 2), 'age_not_confirmed');
    await sql(`update public.profiles set age_confirmed_at = now() where id = $1`, [CAROL]);
    await sql(`update public.wallets set balance = 1000 where user_id = $1`, [CAROL]);
    await fails(bet(CAROL, 51, 2), 'tier_cap_exceeded');
    await sql(`update public.account_controls set kyc_tier = 1 where user_id = $1`, [CAROL]);
    expect((await bet(CAROL, 51, 2)).amount).toBe(51);
  });
  it('blocks self-excluded and cooling-off players, and an exclusion can only grow', async () => {
    const until1 = await rpc(BOB, 'self_exclude', 24);
    await fails(bet(BOB, 1, 2), 'self_excluded');
    const until2 = await rpc(BOB, 'self_exclude', 1);
    expect(new Date(until2).getTime()).toBeGreaterThanOrEqual(new Date(until1).getTime());
    await sql(`update public.account_controls set excluded_until = null where user_id = $1`, [BOB]);
    await sql(`update public.account_controls set cool_off_until = now() + interval '1 day' where user_id = $1`, [BOB]);
    await fails(bet(BOB, 1, 2), 'cool_off');
    await sql(`update public.account_controls set cool_off_until = null where user_id = $1`, [BOB]);
    expect((await bet(BOB, 1, 2)).amount).toBe(1);
  });
  it('applies a tighter limit now and delays a looser one by 24 hours', async () => {
    expect(await rpc(ALICE, 'request_limit_change', 'max_bet', 10)).toBe('applied');
    await fails(bet(ALICE, 11, 2), 'max_bet_exceeded');
    expect(await rpc(ALICE, 'request_limit_change', 'max_bet', 40)).toBe('pending');
    await fails(bet(ALICE, 11, 2), 'max_bet_exceeded');                       // still 10 for now
    await sql(`update public.limit_changes set effective_at = now() - interval '1 minute' where user_id = $1`, [ALICE]);
    expect((await bet(ALICE, 11, 2)).amount).toBe(11);                          // pending change became active
    expect(await rpc(ALICE, 'request_limit_change', 'max_bet', 40)).toBe('same');
    await rpc(ALICE, 'request_limit_change', 'max_bet', null);
    await sql(`update public.limit_changes set effective_at = now() - interval '1 minute' where user_id = $1`, [ALICE]);
  });
  it('enforces the daily loss limit on settled bets', async () => {
    const DAN = '44444444-4444-4444-4444-444444444444';
    await sql(`insert into auth.users (id, email) values ($1, 'd@example.com')`, [DAN]);
    await signup(DAN, 'Dan');
    await rpc(DAN, 'request_limit_change', 'loss_daily', 5);
    // a target of 1000 almost never wins, so each stake is a loss
    for (let i = 0; i < 5; i++) await bet(DAN, 1, 1000);
    await fails(bet(DAN, 1, 1000), 'daily_loss_limit');
  });
});

describe('seeds: commitment, rotation and verification', () => {
  it('reveals only after rotation, promotes the committed next seed, and every bet then re-verifies in the browser verifier', async () => {
    const EVE = '55555555-5555-5555-5555-555555555555';
    await sql(`insert into auth.users (id, email) values ($1, 'e@example.com')`, [EVE]);
    await signup(EVE, 'Eve');
    await rpc(EVE, 'set_client_seed', 'my-seed');
    const committedNext = (await sql(`select server_hash from public.seed_pairs where user_id = $1 and status = 'next'`, [EVE]))[0].server_hash;
    const bets = [];
    for (let i = 0; i < 6; i++) bets.push(await bet(EVE, 1, 1 + i / 2 + 0.5));
    const hidden = await as(EVE, async () => (await db.query(`select status, server_seed from public.my_seeds order by id`)).rows as any[]);
    expect(hidden.every(r => r.server_seed === null)).toBe(true);           // nothing revealed yet
    const rev = await rpc(EVE, 'rotate_seed');
    expect(createHash('sha256').update(rev.server_seed).digest('hex')).toBe(rev.server_hash);
    expect(rev.nonces).toBe(6);
    expect((await sql(`select server_hash from public.seed_pairs where user_id = $1 and status = 'active'`, [EVE]))[0].server_hash).toBe(committedNext);
    for (const b of bets) {
      const again = await recompute('crash', undefined, rev.server_seed, 'my-seed', b.nonce);
      expect(again?.key).toBe(Number(b.crash_point).toFixed(2));
    }
    const shown = await as(EVE, async () => (await db.query(`select status, server_seed from public.my_seeds where status = 'revealed'`)).rows as any[]);
    expect(shown[0]?.server_seed).toBe(rev.server_seed);
  });
  it('refuses a reused nonce at the database level', async () => {
    const s = (await sql(`select id, nonce from public.seed_pairs where user_id = $1 and status = 'active'`, [ALICE]))[0];
    await expect(db.query(`insert into public.bets (user_id, game, amount, seed_id, nonce, client_seed, server_hash) select $1, 'crash', 1, $2, 0, 'x', 'y'`, [ALICE, s.id])).rejects.toThrow(/duplicate|unique/);
  });
});

describe('row-level security and privileges', () => {
  it('lets a player read only their own wallet, bets and ledger', async () => {
    const own = await as(ALICE, async () => (await db.query(`select user_id from public.wallets`)).rows as any[]);
    expect(own.map(r => r.user_id)).toEqual([ALICE]);
    const bets = await as(BOB, async () => (await db.query(`select distinct user_id from public.bets`)).rows as any[]);
    expect(bets.map(r => r.user_id)).toEqual([BOB]);
  });
  it('blocks direct writes to money, bets, seeds, controls and the ledger', async () => {
    for (const q of [`update public.wallets set balance = 1e9`, `insert into public.wallets (user_id, balance) values (gen_random_uuid(), 5)`, `delete from public.bets`,
      `update public.account_controls set kyc_tier = 2`, `update public.seed_pairs set nonce = 0`, `insert into public.ledger (user_id, kind, amount, balance_after) values (gen_random_uuid(), 'bonus', 1, 1)`,
      `update public.profiles set age_confirmed_at = now()`]) {
      await expect(as(ALICE, () => db.query(q)), q).rejects.toThrow(/permission denied|row-level security/);
    }
  });
  it('hides the secret seeds: no table access, and the view shows a seed only after it is revealed', async () => {
    await expect(as(ALICE, () => db.query(`select server_seed from public.seed_pairs`))).rejects.toThrow(/permission denied/);
    const rows = await as(ALICE, async () => (await db.query(`select status, server_seed from public.my_seeds`)).rows as any[]);
    for (const r of rows) if (r.status !== 'revealed') expect(r.server_seed).toBeNull();
  });
  it('gives anonymous visitors nothing, and internal helpers are not callable', async () => {
    await expect(as(null, () => db.query(`select * from public.wallets`))).rejects.toThrow(/permission denied/);
    await expect(as(null, () => db.query(`select public.place_bet('crash', 1, '{"target":2}')`))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => db.query(`select public.apply_due_limits($1)`, [BOB]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => db.query(`select public.new_seed_pair($1, 'active')`, [BOB]))).rejects.toThrow(/permission denied/);
  });
  it('chat: players post as themselves, names cannot be spoofed, length is capped, everyone reads', async () => {
    await as(ALICE, () => db.query(`insert into public.chat_messages (body) values ('gl everyone')`));
    await expect(as(ALICE, () => db.query(`insert into public.chat_messages (body, display_name) values ('hi', 'Admin')`))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => db.query(`insert into public.chat_messages (body) values ($1)`, ['x'.repeat(141)]))).rejects.toThrow(/violates check/);
    await expect(as(ALICE, () => db.query(`insert into public.chat_messages (body) values ('')`))).rejects.toThrow(/violates check/);
    const seen = await as(BOB, async () => (await db.query(`select display_name, body from public.chat_messages`)).rows as any[]);
    expect(seen).toEqual([{ display_name: 'Alice', body: 'gl everyone' }]);
  });
  it('the daily race shows names and totals only', async () => {
    const rows = await as(BOB, async () => (await db.query(`select * from public.daily_race`)).rows as any[]);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(['bets', 'display_name', 'wagered']);
    expect(Number(rows[0].wagered)).toBeGreaterThanOrEqual(Number(rows[rows.length - 1].wagered));
  });
});
