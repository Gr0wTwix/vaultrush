// @vitest-environment node
// Runs migrations 0001 to 0005 in an in-process Postgres (PGlite) and checks the shared Crash and Double rounds: the clock, the secret
// crash point, server-timed cash-outs, auto cash-outs, double payouts, and who may do what. Time is moved by editing round timestamps.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crashPoint, doubleRoll, doubleWins, DOUBLE_PAY, floatsFor } from '../src/fair.js';

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CARA = '33333333-3333-3333-3333-333333333333';
const NOBODY = '44444444-4444-4444-4444-444444444444';
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
  insert into auth.users (id, email) values ('${ALICE}', 'a@example.com'), ('${BOB}', 'b@example.com'), ('${CARA}', 'c@example.com'), ('${NOBODY}', 'n@example.com');
`;

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = async (uid: string | null, fn: string, ...args: unknown[]): Promise<any> =>
  as(uid, async () => {
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    const r = await db.query(`select public.${fn}(${ph}) as v`, args);
    return (r.rows[0] as { v: unknown }).v;
  });
const q = (uid: string | null, text: string, params: unknown[] = []) => as(uid, async () => (await db.query(text, params)).rows as any[]);
const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
const fails = async (p: Promise<unknown>, what: string) => { await expect(p).rejects.toThrow(what); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TERMS = '2026-11-21';

const advance = async (uid: string, game: string): Promise<any> => (await rpc(uid, 'advance_round', game)).round;
/** Make the current round of a game old and finished so that the next advance opens a brand new betting round. */
const fresh = async (game: string, uid = ALICE): Promise<any> => {
  await sql(`update public.game_rounds set status = 'finished', finished_at = now() - interval '1 day' where game = $1`, [game]);
  return advance(uid, game);
};
const seedOf = async (id: number): Promise<string> => (await sql(`select server_seed from public.game_round_secrets where round_id = $1`, [id]))[0].server_seed;
const crashOf = async (id: number): Promise<number> => crashPoint((await floatsFor(await seedOf(id), String(id), 0, 1))[0] as number);
/** A fresh crash round whose crash point satisfies the test (the point is random, so open rounds until one fits). */
const crashRound = async (ok: (cp: number) => boolean): Promise<{ r: any; cp: number }> => {
  for (let i = 0; i < 60; i++) { const r = await fresh('crash'); const cp = await crashOf(r.id); if (ok(cp)) return { r, cp }; }
  throw new Error('no suitable round found');
};
const startedAgo = (id: number, secs: number) => sql(`update public.game_rounds set betting_ends_at = now() - make_interval(secs => $2) where id = $1`, [id, secs]);
const crashSecs = (cp: number): number => Math.log(cp) / 0.00012 / 1000;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds']) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARA, 'Cara']] as const) await rpc(id, 'complete_signup', n, TERMS, true);
}, 90_000);
afterAll(async () => { await db.close(); });

describe('the clock', () => {
  it('opens one round per game and keeps returning it until its time is up', async () => {
    const a = await advance(ALICE, 'crash'), b = await advance(BOB, 'crash');
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('betting');
    expect(a.result).toBeNull();
    expect(a.server_hash).toMatch(/^[0-9a-f]{64}$/);
    const secs = (Date.parse(a.betting_ends_at) - Date.parse((await rpc(ALICE, 'advance_round', 'crash')).now)) / 1000;
    expect(secs).toBeGreaterThan(0); expect(secs).toBeLessThanOrEqual(7);
    const d = await advance(ALICE, 'double');
    expect(d.game).toBe('double'); expect(d.id).not.toBe(a.id);
  });
  it('needs a signed-in player with a profile, and a known game', async () => {
    await fails(rpc(null, 'advance_round', 'crash'), 'permission denied');
    await fails(rpc(NOBODY, 'advance_round', 'crash'), 'no_account');
    await fails(rpc(ALICE, 'advance_round', 'poker'), 'invalid_game');
  });
  it('keeps the seed secret until the round is finished, and shows no result early', async () => {
    const r = await fresh('crash');
    await fails(q(ALICE, `select * from public.game_round_secrets`), 'permission denied');
    expect(await q(ALICE, `select * from public.game_round_seeds where round_id = $1`, [r.id])).toEqual([]);
    await startedAgo(r.id, 0.5);
    const running = await advance(ALICE, 'crash');
    if (running.status === 'running') expect(running.result).toBeNull();      // the crash point is not published while the round runs
  });
});

describe('crash', () => {
  it('takes bets only while betting, once per player, with sane amounts', async () => {
    const { r } = await crashRound(cp => cp > 1.5);
    const bet = await rpc(ALICE, 'crash_place_bet', r.id, 10, null, false);
    expect(bet).toMatchObject({ display_name: 'Alice', riding: 10, locked: 0, done: false });
    await fails(rpc(ALICE, 'crash_place_bet', r.id, 5, null, false), 'already_bet');
    await fails(rpc(BOB, 'crash_place_bet', r.id, 0.05, null, false), 'invalid_amount');
    await fails(rpc(BOB, 'crash_place_bet', r.id, 1.005, null, false), 'invalid_amount');
    await fails(rpc(BOB, 'crash_place_bet', r.id, 5, 1.001, false), 'invalid_target');
    await fails(rpc(BOB, 'crash_place_bet', r.id, 5, 0.5, false), 'invalid_target');
    await fails(rpc(BOB, 'crash_place_bet', r.id + 999, 5, null, false), 'betting_closed');
    const cancelled = await rpc(ALICE, 'crash_cancel_bet', r.id);
    expect(Number(cancelled)).toBe(10);
    await fails(rpc(ALICE, 'crash_cancel_bet', r.id), 'no_bet');
    expect((await rpc(ALICE, 'crash_place_bet', r.id, 10, null, true)).display_name).toBe('Anonymous');
  });

  it('runs the round by the clock: cash-outs use the server multiplier, partial shares work, betting is closed', async () => {
    const { r, cp } = await crashRound(c => c >= 4);
    await rpc(ALICE, 'crash_place_bet', r.id, 10, null, false);
    await rpc(BOB, 'crash_place_bet', r.id, 8, null, false);
    await fails(rpc(ALICE, 'crash_cashout', r.id, 1), 'not_started');
    await startedAgo(r.id, 2);                                                           // two seconds into the round
    await fails(rpc(CARA, 'crash_place_bet', r.id, 1, null, false), 'betting_closed');
    const half = await rpc(ALICE, 'crash_cashout', r.id, 0.5);
    expect(half.mult).toBeGreaterThanOrEqual(Math.floor(Math.exp(0.00012 * 2000) * 100) / 100);
    expect(half.mult).toBeLessThan(Math.exp(0.00012 * 2300));
    expect(half).toMatchObject({ take: 5, riding: 5, done: false });
    expect(half.got).toBeCloseTo(5 * half.mult, 2);
    const rest = await rpc(ALICE, 'crash_cashout', r.id, 1);
    expect(rest).toMatchObject({ take: 5, riding: 0, done: true });
    expect(rest.locked).toBeCloseTo(half.got + rest.got, 2);
    await fails(rpc(ALICE, 'crash_cashout', r.id, 1), 'too_late');                       // already out
    await fails(rpc(CARA, 'crash_cashout', r.id, 1), 'no_bet');
    expect((await q(BOB, `select riding, done from public.round_bets where round_id = $1 and user_id = $2`, [r.id, BOB]))[0]).toMatchObject({ riding: '8.00', done: false });
    expect(cp).toBeGreaterThanOrEqual(4);
  });

  it('finishes at the crash instant, publishes the point, applies auto cash-outs below it, busts the rest and reveals the seed', async () => {
    const { r, cp } = await crashRound(c => c >= 3);
    await rpc(ALICE, 'crash_place_bet', r.id, 10, 1.5, false);       // auto cash-out below the crash point: paid by the server
    await rpc(BOB, 'crash_place_bet', r.id, 4, null, false);         // never cashes out: busts
    await rpc(CARA, 'crash_place_bet', r.id, 6, cp + 1, false);      // auto above the crash point: busts
    await startedAgo(r.id, crashSecs(cp) - 0.2);
    expect((await advance(ALICE, 'crash')).status).toBe('running');   // 0.2 s before the crash: still running
    await startedAgo(r.id, crashSecs(cp) + 0.5);
    const done = await advance(BOB, 'crash');
    expect(done).toMatchObject({ id: r.id, status: 'finished' });
    expect(done.result.point).toBe(cp);
    expect(Date.parse(done.finished_at) - Date.parse(done.betting_ends_at)).toBeCloseTo(crashSecs(cp) * 1000, -1);
    const rows = Object.fromEntries((await sql(`select user_id, locked, riding, done, cashouts from public.round_bets where round_id = $1`, [r.id])).map(x => [x.user_id, x]));
    expect(Number(rows[ALICE].locked)).toBe(15);                      // 10 x 1.5
    expect(rows[ALICE].cashouts).toEqual([1.5]);
    expect(Number(rows[ALICE].riding)).toBe(0);
    expect(Number(rows[BOB].locked)).toBe(0); expect(rows[BOB].done).toBe(true);
    expect(Number(rows[CARA].locked)).toBe(0);
    await fails(rpc(BOB, 'crash_cashout', r.id, 1), 'too_late');
    // fairness: the revealed seed matches the committed hash and reproduces the point
    const [seed] = await q(ALICE, `select server_seed from public.game_round_seeds where round_id = $1`, [r.id]);
    expect(sha(seed.server_seed)).toBe(r.server_hash);
    expect(crashPoint((await floatsFor(seed.server_seed, String(r.id), 0, 1))[0] as number)).toBe(cp);
  });

  it('opens the next round only after the pause', async () => {
    const { r, cp } = await crashRound(c => c >= 1.5);
    await startedAgo(r.id, crashSecs(cp) + 1);
    expect((await advance(ALICE, 'crash')).id).toBe(r.id);            // finished 1 s ago: still in the pause
    await sql(`update public.game_rounds set finished_at = now() - interval '4 seconds' where id = $1`, [r.id]);
    const next = await advance(ALICE, 'crash');
    expect(next.id).toBeGreaterThan(r.id); expect(next.status).toBe('betting');
  });

  it('a player who joins late and a player who leaves are handled by the same rules', async () => {
    const { r } = await crashRound(c => c >= 3);
    await rpc(ALICE, 'crash_place_bet', r.id, 3, null, false);
    await startedAgo(r.id, 1);
    expect((await q(BOB, `select display_name, amount from public.round_bets where round_id = $1`, [r.id])).map(x => x.display_name)).toEqual(['Alice']);   // everyone can see the bets
    await fails(rpc(BOB, 'crash_place_bet', r.id, 3, null, false), 'betting_closed');
  });
});

describe('double', () => {
  it('takes lane bets, accumulates a repeated lane, and refuses purple with gray', async () => {
    const r = await fresh('double');
    await rpc(ALICE, 'double_place_bet', r.id, 'purple', 5, false);
    const more = await rpc(ALICE, 'double_place_bet', r.id, 'purple', 2.5, false);
    expect(Number(more.amount)).toBe(7.5);
    await rpc(ALICE, 'double_place_bet', r.id, 'green', 1, false);
    await fails(rpc(ALICE, 'double_place_bet', r.id, 'gray', 1, false), 'both_sides');
    await rpc(BOB, 'double_place_bet', r.id, 'gray', 3, true);
    await fails(rpc(BOB, 'double_place_bet', r.id, 'purple', 3, false), 'both_sides');
    await fails(rpc(BOB, 'double_place_bet', r.id, 'pink', 3, false), 'invalid_lane');
    await fails(rpc(BOB, 'double_place_bet', r.id, 'bait', 0.01, false), 'invalid_amount');
    await fails(rpc(BOB, 'double_place_bet', r.id + 50, 'bait', 1, false), 'betting_closed');
    const lanes = await q(CARA, `select display_name, lane, amount from public.round_bets where round_id = $1 order by id`, [r.id]);
    expect(lanes.map(x => x.lane)).toEqual(['purple', 'green', 'gray']);
    expect(lanes[2].display_name).toBe('Anonymous');
  });

  it('reveals the tile when betting closes, rolls for 5.2 s, then pays every lane by the published rules (20 rounds)', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await fresh('double');
      await rpc(ALICE, 'double_place_bet', r.id, 'purple', 4, false);
      await rpc(ALICE, 'double_place_bet', r.id, 'bait', 2, false);
      await rpc(BOB, 'double_place_bet', r.id, 'gray', 3, false);
      await rpc(BOB, 'double_place_bet', r.id, 'green', 1, false);
      expect((await advance(ALICE, 'double')).result).toBeNull();                         // nothing is revealed while betting is open
      await startedAgo(r.id, 1);
      const rolling = await advance(ALICE, 'double');
      expect(rolling.status).toBe('running');
      const n = rolling.result.n;
      expect(n).toBe(doubleRoll((await floatsFor(await seedOf(r.id), String(r.id), 0, 1))[0] as number));
      await fails(rpc(CARA, 'double_place_bet', r.id, 'green', 1, false), 'betting_closed');
      expect((await sql(`select done from public.round_bets where round_id = $1`, [r.id])).every(x => !x.done)).toBe(true);   // not settled mid-roll
      await startedAgo(r.id, 5.5);
      expect((await advance(BOB, 'double')).status).toBe('finished');
      for (const row of await sql(`select lane, amount, locked, done from public.round_bets where round_id = $1`, [r.id])) {
        const expected = doubleWins(row.lane, n) ? Math.round(Number(row.amount) * DOUBLE_PAY[row.lane as keyof typeof DOUBLE_PAY] * 100) / 100 : 0;
        expect(Number(row.locked), `tile ${n} lane ${row.lane}`).toBe(expected);
        expect(row.done).toBe(true);
      }
    }
  });
});

describe('access and erasure', () => {
  it('lets signed-in players read everyone\'s bets, and nobody write them directly', async () => {
    expect((await q(CARA, `select count(*)::int as n from public.round_bets`))[0].n).toBeGreaterThan(0);
    await fails(q(null, `select * from public.round_bets`), 'permission denied');
    await fails(q(ALICE, `update public.round_bets set locked = 1000000`), 'permission denied');
    await fails(q(ALICE, `insert into public.round_bets (round_id, user_id, display_name, amount, riding) values (1, '${ALICE}', 'x', 1, 1)`), 'permission denied');
    await fails(q(ALICE, `update public.game_rounds set status = 'finished'`), 'permission denied');
  });
  it('keeps the helpers private', async () => {
    await fails(rpc(ALICE, 'advance_round_internal', 'crash'), 'permission denied');
    await fails(rpc(ALICE, 'round_float', 'x', 1), 'permission denied');
    await fails(rpc(null, 'rounds_ready'), 'permission denied');
    expect(await rpc(ALICE, 'rounds_ready')).toBe(true);
  });
  it('deleting an account replaces its name on round bets', async () => {
    const DAN = '55555555-5555-5555-5555-555555555555';
    await db.exec(`insert into auth.users (id, email) values ('${DAN}', 'd@example.com')`);
    await rpc(DAN, 'complete_signup', 'Dan', TERMS, true);
    const r = await fresh('double');
    await rpc(DAN, 'double_place_bet', r.id, 'green', 1, false);
    await rpc(DAN, 'delete_account');
    const rows = await sql(`select display_name from public.round_bets where user_id = $1`, [DAN]);
    expect(rows[0].display_name).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(JSON.stringify(await sql(`select display_name from public.round_bets`))).not.toContain('"Dan"');
  });
  it('is published to realtime', async () => {
    const t = (await sql(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).map(r => r.tablename);
    expect(t).toEqual(expect.arrayContaining(['game_rounds', 'round_bets']));
  });
});
