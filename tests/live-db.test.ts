// @vitest-environment node
// Runs 0001 + 0002_live.sql in an in-process Postgres (PGlite) with Supabase-style roles and checks the live lobbies:
// seating, the secret seed, the server-drawn coinflip result, who may do what, and row-level security.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { floatsFor } from '../src/fair.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CARA = '33333333-3333-3333-3333-333333333333';
let db: PGlite;

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
  insert into auth.users (id, email) values ('${ALICE}', 'a@example.com'), ('${BOB}', 'b@example.com'), ('${CARA}', 'c@example.com');
`;

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = async (uid: string | null, fn: string, ...args: unknown[]): Promise<any> =>
  as(uid, async () => {
    const ph = args.map((_, i) => `$${i + 1}${Array.isArray(args[i]) ? '::text[]' : ''}`).join(', ');
    const r = await db.query(`select public.${fn}(${ph}) as v`, args.map(a => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a)));
    return (r.rows[0] as { v: unknown }).v;
  });
const q = (uid: string | null, text: string, params: unknown[] = []) => as(uid, async () => (await db.query(text, params)).rows as any[]);
const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
const fails = async (p: Promise<unknown>, what: string) => { await expect(p).rejects.toThrow(what); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TERMS = '2026-11-18';
const CASES = ['starter', 'blade-vault'];
const open = (uid: string, format = '1v1', mode = 'normal') => rpc(uid, 'create_live_battle', CASES, format, mode);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  await db.exec(readFileSync(new URL('../supabase/migrations/0001_core.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/0002_live.sql', import.meta.url), 'utf8'));
  for (const [id, n] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARA, 'Cara']] as const) await rpc(id, 'complete_signup', n, TERMS, true);
}, 60_000);
afterAll(async () => { await db.close(); });

describe('who may call the live API', () => {
  it('needs a signed-in player with a finished profile', async () => {
    await fails(rpc(null, 'create_live_battle', CASES, '1v1', 'normal'), 'permission denied');
    await fails(rpc(null, 'create_live_coinflip', 'bolt', 1), 'permission denied');
    expect(await rpc(ALICE, 'live_ready')).toBe(true);
    await db.exec(`insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'd@example.com')`);
    await fails(rpc('44444444-4444-4444-4444-444444444444', 'create_live_coinflip', 'bolt', 1), 'no_account');
  });
  it('keeps the private helpers private and refuses direct table writes', async () => {
    await fails(rpc(ALICE, 'live_player', ALICE), 'permission denied');
    await fails(q(ALICE, `insert into public.live_coinflips (creator, creator_name, side, amount, server_hash) values ('${ALICE}', 'Alice', 'bolt', 1, 'x')`), 'permission denied');
    await fails(q(ALICE, `update public.live_battles set status = 'running'`), 'permission denied');
    await fails(q(ALICE, `select * from public.live_battle_secrets`), 'permission denied');
    await fails(q(ALICE, `select * from public.live_coinflip_secrets`), 'permission denied');
    await fails(q(null, `select * from public.live_battles`), 'permission denied');
  });
});

describe('case battles', () => {
  it('creates a lobby with the creator seated, a public hash and a secret seed', async () => {
    const b = await open(ALICE, '1v1v1');
    expect(b.status).toBe('waiting');
    expect(b.seats).toHaveLength(3);
    expect(b.seats[0]).toMatchObject({ uid: ALICE, name: 'Alice', bot: false });
    expect(b.seats[1]).toBeNull();
    expect(b.player_ids).toEqual([ALICE]);
    expect(b.server_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(b)).not.toContain('server_seed');
    expect(await q(BOB, `select * from public.live_battle_seeds where battle_id = $1`, [b.id])).toEqual([]);   // not revealed yet
    expect((await q(BOB, `select id from public.live_battles where id = $1`, [b.id])).length).toBe(1);          // but everyone can see the lobby
    await rpc(ALICE, 'leave_live_battle', b.id);
  });

  it('starts when the last seat is taken and then reveals a seed that matches the committed hash', async () => {
    const b = await open(ALICE, '1v1v1');
    const mid = await rpc(BOB, 'join_live_battle', b.id);
    expect(mid.status).toBe('waiting');
    expect(await q(CARA, `select * from public.live_battle_seeds where battle_id = $1`, [b.id])).toEqual([]);
    const full = await rpc(CARA, 'join_live_battle', b.id);
    expect(full.status).toBe('running');
    expect(full.started_at).not.toBeNull();
    expect(full.seats.map((s: any) => s.name)).toEqual(['Alice', 'Bob', 'Cara']);
    const seeds = await q(ALICE, `select server_seed from public.live_battle_seeds where battle_id = $1`, [b.id]);
    expect(seeds).toHaveLength(1);
    expect(sha(seeds[0].server_seed)).toBe(b.server_hash);
    // every browser derives the same numbers from the revealed seed
    const a = await floatsFor(seeds[0].server_seed, b.client_seed, 0, 7), c = await floatsFor(seeds[0].server_seed, b.client_seed, 0, 7);
    expect(a).toEqual(c);
  });

  it('rejects bad requests', async () => {
    await fails(open(ALICE, '5v5'), 'invalid_format');
    await fails(open(ALICE, '1v1', 'nonsense'), 'invalid_mode');
    await fails(open(ALICE, '2v2', 'jackpot'), 'invalid_mode');           // team battles allow only normal, crazy, terminal
    await fails(rpc(ALICE, 'create_live_battle', [], '1v1', 'normal'), 'invalid_cases');
    await fails(rpc(ALICE, 'create_live_battle', ['bad id!'], '1v1', 'normal'), 'invalid_cases');
    await fails(rpc(ALICE, 'create_live_battle', Array(21).fill('a'), '1v1', 'normal'), 'invalid_cases');
  });

  it('refuses double seating, joining a full or started battle, and unknown ids', async () => {
    const b = await open(ALICE, '1v1v1');
    await fails(rpc(ALICE, 'join_live_battle', b.id), 'already_seated');
    await rpc(BOB, 'join_live_battle', b.id, 2);
    await fails(rpc(CARA, 'join_live_battle', b.id, 2), 'seat_taken');
    await fails(rpc(CARA, 'join_live_battle', b.id, 9), 'invalid_seat');
    await rpc(CARA, 'join_live_battle', b.id);
    const started = await open(ALICE);
    await rpc(BOB, 'join_live_battle', started.id);
    await fails(rpc(CARA, 'join_live_battle', started.id), 'battle_not_open');
    await fails(rpc(CARA, 'join_live_battle', '99999999-9999-9999-9999-999999999999'), 'battle_not_found');
  });

  it('lets only the creator add bots, fills a seat, and starts when bots complete the lineup', async () => {
    const b = await open(ALICE, '1v1v1');
    await fails(rpc(BOB, 'call_live_bot', b.id, 1, 'frostbyte'), 'not_creator');
    await fails(rpc(ALICE, 'call_live_bot', b.id, 0, 'frostbyte'), 'invalid_seat');           // the creator's own seat
    await fails(rpc(ALICE, 'call_live_bot', b.id, 1, 'bad name!'), 'invalid_name');
    const one = await rpc(ALICE, 'call_live_bot', b.id, 1, 'frostbyte');
    expect(one.seats[1]).toMatchObject({ name: 'frostbyte', bot: true, uid: null });
    expect(one.player_ids).toEqual([ALICE]);                                                  // bots are not players
    await fails(rpc(ALICE, 'call_live_bot', b.id, 1, 'Vexx'), 'seat_taken');
    const full = await rpc(ALICE, 'call_live_bot', b.id, 2, 'Vexx');
    expect(full.status).toBe('running');
  });

  it('lets a joiner leave, cancels the battle when the creator leaves, and refuses leaving after the start', async () => {
    const b = await open(ALICE, '1v1v1');
    await rpc(BOB, 'join_live_battle', b.id);
    const left = await rpc(BOB, 'leave_live_battle', b.id);
    expect(left.seats[1]).toBeNull();
    expect(left.player_ids).toEqual([ALICE]);
    await fails(rpc(CARA, 'leave_live_battle', b.id), 'not_in_battle');
    await rpc(BOB, 'join_live_battle', b.id);
    const gone = await rpc(ALICE, 'leave_live_battle', b.id);
    expect(gone.status).toBe('cancelled');
    await fails(rpc(CARA, 'join_live_battle', b.id), 'battle_not_open');
    const g = await open(ALICE); await rpc(BOB, 'join_live_battle', g.id);
    await fails(rpc(BOB, 'leave_live_battle', g.id), 'already_started');
  });

  it('limits how many open lobbies one player can hold, and lets players find their own battles', async () => {
    await sql(`update public.live_battles set status = 'cancelled' where status = 'waiting'`);
    for (let i = 0; i < 3; i++) await open(CARA);
    await fails(open(CARA), 'too_many_open');
    const mine = await q(CARA, `select id from public.live_battles where player_ids @> array[$1]::uuid[]`, [CARA]);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    await sql(`update public.live_battles set status = 'cancelled' where status = 'waiting'`);
  });

  it('refuses a stale lobby', async () => {
    const b = await open(ALICE);
    await sql(`update public.live_battles set created_at = now() - interval '31 minutes' where id = $1`, [b.id]);
    await fails(rpc(BOB, 'join_live_battle', b.id), 'battle_expired');
  });
});

describe('coinflip', () => {
  it('creates an open game with a committed hash and no seed', async () => {
    const f = await rpc(ALICE, 'create_live_coinflip', 'bolt', 2.5);
    expect(f).toMatchObject({ creator_name: 'Alice', side: 'bolt', status: 'waiting', result: null, winner: null });
    expect(Number(f.amount)).toBe(2.5);
    expect(await q(BOB, `select * from public.live_coinflip_seeds where flip_id = $1`, [f.id])).toEqual([]);
    await rpc(ALICE, 'cancel_live_coinflip', f.id);
  });

  it('draws the result on the server when someone joins, and the revealed seed reproduces it', async () => {
    for (let i = 0; i < 6; i++) {
      const f = await rpc(ALICE, 'create_live_coinflip', i % 2 ? 'bolt' : 'star', 1 + i);
      const done = await rpc(BOB, 'join_live_coinflip', f.id);
      expect(done.status).toBe('done');
      expect(done.joiner_name).toBe('Bob');
      const [{ server_seed }] = await q(CARA, `select server_seed from public.live_coinflip_seeds where flip_id = $1`, [f.id]);
      expect(sha(server_seed)).toBe(f.server_hash);
      const fl = (await floatsFor(server_seed, String(f.id), 0, 1))[0] as number;
      expect(done.result).toBe(fl < 0.5 ? 'bolt' : 'star');
      expect(done.winner).toBe(done.result === f.side ? ALICE : BOB);
    }
  });

  it('refuses your own game, a taken game, bad amounts and bad sides', async () => {
    const f = await rpc(ALICE, 'create_live_coinflip', 'bolt', 1);
    await fails(rpc(ALICE, 'join_live_coinflip', f.id), 'own_flip');
    await rpc(BOB, 'join_live_coinflip', f.id);
    await fails(rpc(CARA, 'join_live_coinflip', f.id), 'flip_not_open');
    await fails(rpc(ALICE, 'create_live_coinflip', 'heads', 1), 'invalid_side');
    await fails(rpc(ALICE, 'create_live_coinflip', 'bolt', 0.05), 'invalid_amount');
    await fails(rpc(ALICE, 'create_live_coinflip', 'bolt', 1.005), 'invalid_amount');
    await fails(rpc(ALICE, 'create_live_coinflip', 'bolt', 6000), 'invalid_amount');
    await fails(rpc(CARA, 'join_live_coinflip', 987654), 'flip_not_found');
  });

  it('lets only the creator cancel, and only while nobody has joined', async () => {
    const f = await rpc(ALICE, 'create_live_coinflip', 'star', 3);
    await fails(rpc(BOB, 'cancel_live_coinflip', f.id), 'not_creator');
    expect((await rpc(ALICE, 'cancel_live_coinflip', f.id)).status).toBe('cancelled');
    await fails(rpc(BOB, 'join_live_coinflip', f.id), 'flip_not_open');
    const g = await rpc(ALICE, 'create_live_coinflip', 'star', 3);
    await rpc(BOB, 'join_live_coinflip', g.id);
    await fails(rpc(ALICE, 'cancel_live_coinflip', g.id), 'flip_not_open');
  });

  it('limits open games per player and refuses stale ones', async () => {
    await sql(`update public.live_coinflips set status = 'cancelled' where status = 'waiting'`);
    for (let i = 0; i < 5; i++) await rpc(CARA, 'create_live_coinflip', 'bolt', 1);
    await fails(rpc(CARA, 'create_live_coinflip', 'bolt', 1), 'too_many_open');
    const [{ id }] = await sql(`select id from public.live_coinflips where status = 'waiting' limit 1`);
    await sql(`update public.live_coinflips set created_at = now() - interval '31 minutes' where id = $1`, [id]);
    await fails(rpc(BOB, 'join_live_coinflip', id), 'flip_expired');
  });

  it('is published to realtime', async () => {
    const t = (await sql(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).map(r => r.tablename);
    expect(t).toEqual(expect.arrayContaining(['live_battles', 'live_coinflips']));
  });
});
