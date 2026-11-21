// @vitest-environment node
// Migrations 0011 and 0012 in an in-process Postgres: Coinflip, Battles, Crash and Double take stakes and pay winners from the SERVER wallet, every battle
// mode is decided exactly like the browser's decide() (checked on real draws against src/battle-math.ts), leaving never traps coins, and the rewards
// (faucet, rakeback, calendar, promo codes, free crates, race prize) are the only ways free coins appear. The last test replays a ledger to the wallet.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASE, entryForTicket, ticketOf } from '../src/data.js';
import { decide, FORMATS, shareOf } from '../src/battle-math.js';
import { DOUBLE_PAY, doubleWins, floatsFor } from '../src/fair.js';
import type { DoubleLane } from '../src/types.js';

const A = '44444444-4444-4444-4444-444444444444';
const B = '55555555-5555-5555-5555-555555555555';
const C = '66666666-6666-6666-6666-666666666666';
const Z = '77777777-7777-7777-7777-777777777777';
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
  insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'), ('${C}', 'c@example.com'), ('${Z}', 'z@example.com');
`;
async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, ...args: unknown[]): Promise<any> => as(uid, async () => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  return ((await db.query(`select public.${fn}(${ph}) as v`, args)).rows[0] as { v: unknown }).v;
});
const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
const fails = async (p: Promise<unknown>, what: string) => { await expect(p).rejects.toThrow(what); };
const fund = (uid: string, n: number) => sql(`update public.wallets set balance = $2 where user_id = $1`, [uid, n]);
const bal = async (uid: string): Promise<number> => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);
const r2 = (n: number): number => Math.round(n * 100) / 100;
const betsOf = (uid: string, game: string) => sql(`select * from public.bets where user_id = $1 and game = $2 order by id`, [uid, game]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards'])
    await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[A, 'Alice'], [B, 'Bob'], [C, 'Cara'], [Z, 'Zed']] as const) await rpc(id, 'complete_signup', n, TERMS, true);
}, 120_000);
afterAll(async () => { await db.close(); });

describe('the switch', () => {
  it('is on once 0012 has run, for signed-in players only', async () => {
    expect(await rpc(A, 'wallet_ready')).toBe(true);
    await fails(rpc(null, 'wallet_ready'), 'permission denied');
  });
});

// ============================ coinflip =====================================================================================
describe('Coinflip', () => {
  it('takes the stake when it is created and gives it back when cancelled', async () => {
    await fund(A, 100);
    const f = await rpc(A, 'create_live_coinflip', 'bolt', 30);
    expect(f.balance).toBe(70); expect(await bal(A)).toBe(70);
    const c = await rpc(A, 'cancel_live_coinflip', f.id);
    expect(c.status).toBe('cancelled'); expect(await bal(A)).toBe(100);
    await fails(rpc(A, 'cancel_live_coinflip', f.id), 'flip_not_open');            // no second refund
    expect(await bal(A)).toBe(100);
  });
  it('refuses a stake the player cannot pay, and a cancel by somebody else', async () => {
    await fund(A, 10); await fund(B, 100);
    await fails(rpc(A, 'create_live_coinflip', 'star', 50), 'insufficient_funds');
    expect(await bal(A)).toBe(10);
    const f = await rpc(B, 'create_live_coinflip', 'star', 20);
    await fails(rpc(A, 'cancel_live_coinflip', f.id), 'not_creator');
    await rpc(B, 'cancel_live_coinflip', f.id);
  });
  it('pays the winner 1.94x when the second player joins; the result comes from the seed; both bets are written', async () => {
    for (let i = 0; i < 6; i++) {
      await fund(A, 100); await fund(B, 100);
      const f = await rpc(A, 'create_live_coinflip', 'bolt', 25);
      await fails(rpc(A, 'join_live_coinflip', f.id), 'own_flip');
      const d = await rpc(B, 'join_live_coinflip', f.id);
      expect(d.status).toBe('done'); expect(d.balance).toBe(await bal(B));
      const seed = (await sql(`select server_seed from public.live_coinflip_seeds where flip_id = $1`, [f.id]))[0].server_seed as string;
      const res = (await floatsFor(seed, String(f.id), 0, 1))[0]! < 0.5 ? 'bolt' : 'star';
      expect(d.result).toBe(res);
      const aWon = res === 'bolt', pay = r2(25 * 1.94);
      expect(await bal(A)).toBeCloseTo(75 + (aWon ? pay : 0), 2); expect(await bal(B)).toBeCloseTo(75 + (aWon ? 0 : pay), 2);
      expect(d.winner).toBe(aWon ? A : B);
    }
    const a = await betsOf(A, 'coinflip'), b = await betsOf(B, 'coinflip');
    expect(a.length).toBe(6); expect(b.length).toBe(6);
    expect(a.every((x: any) => Number(x.amount) === 25)).toBe(true);
    expect(a.map((x: any, i: number) => Number(x.payout) + Number(b[i].payout)).every((s: number) => s === r2(25 * 1.94))).toBe(true);     // exactly one winner each time
  });
  it('a stake that cannot be paid leaves the flip open for someone else', async () => {
    await fund(A, 100); await fund(C, 1);
    const f = await rpc(A, 'create_live_coinflip', 'star', 25);
    await fails(rpc(C, 'join_live_coinflip', f.id), 'insufficient_funds');
    expect((await sql(`select status from public.live_coinflips where id = $1`, [f.id]))[0].status).toBe('waiting');
    await rpc(A, 'cancel_live_coinflip', f.id);
  });
  it('a house bot: the creator wins 1.94x or the stake is gone (the house keeps it)', async () => {
    let won = 0, lost = 0;
    for (let i = 0; i < 14; i++) {
      await fund(A, 100);
      const f = await rpc(A, 'create_live_coinflip', 'bolt', 10);
      const d = await rpc(A, 'call_live_coinflip_bot', f.id, 'HouseBot');
      expect(d.joiner_bot).toBe(true);
      const iWon = d.winner === A;
      expect(await bal(A)).toBeCloseTo(90 + (iWon ? 19.4 : 0), 2); iWon ? won++ : lost++;
    }
    expect(won).toBeGreaterThan(0); expect(lost).toBeGreaterThan(0);
    await fails(rpc(B, 'call_live_coinflip_bot', 1, 'HouseBot'), 'not_creator');
  });
  it('closes a lobby left waiting for 30 minutes and refunds it', async () => {
    await fund(A, 100);
    const f = await rpc(A, 'create_live_coinflip', 'bolt', 40);
    await sql(`update public.live_coinflips set created_at = now() - interval '31 minutes' where id = $1`, [f.id]);
    await rpc(A, 'wallet_me');
    expect((await sql(`select status from public.live_coinflips where id = $1`, [f.id]))[0].status).toBe('cancelled');
    expect(await bal(A)).toBe(100);
    await rpc(A, 'wallet_me'); expect(await bal(A)).toBe(100);                                  // and only once
  });
  it('obeys maintenance and the game switch, and the responsible-gambling gate', async () => {
    await fund(A, 100);
    await sql(`update public.site_controls set games_off = '{coinflip}'`);
    await fails(rpc(A, 'create_live_coinflip', 'bolt', 5), 'game_off');
    await sql(`update public.site_controls set games_off = '{}', maintenance_on = true`);
    await fails(rpc(A, 'create_live_coinflip', 'bolt', 5), 'maintenance');
    await sql(`update public.site_controls set maintenance_on = false`);
    await sql(`update public.account_controls set max_bet = 2 where user_id = $1`, [A]);
    await fails(rpc(A, 'create_live_coinflip', 'bolt', 5), 'max_bet_exceeded');
    await sql(`update public.account_controls set max_bet = null where user_id = $1`, [A]);
    expect(await bal(A)).toBe(100);
  });
});

// ============================ battles ======================================================================================
const cost = (ids: string[]): number => r2(ids.reduce((s, id) => s + CASE[id]!.price, 0));
/** Recompute a finished battle with the browser's own maths from the revealed seed. */
async function reference(id: string): Promise<{ winners: number[]; totals: number[]; pot: number }> {
  const row = (await sql(`select * from public.live_battles where id = $1`, [id]))[0];
  const seed = (await sql(`select server_seed from public.live_battle_seeds where battle_id = $1`, [id]))[0].server_seed as string;
  const P = row.seats.length, R = row.case_ids.length, fl = await floatsFor(seed, row.client_seed, 0, P * R + 1);
  const results = Array.from({ length: P }, (_, p) => row.case_ids.map((cid: string, r: number) => entryForTicket(CASE[cid]!, ticketOf(fl[r * P + p]!)).item));
  const oc = decide(row.mode, row.format, results, fl[P * R]!);
  return { winners: [...oc.winners].sort(), totals: oc.totals, pot: r2(oc.totals.reduce((a: number, b: number) => a + b, 0)) };
}
async function botBattle(uid: string, ids: string[], format: string, mode: string): Promise<{ id: string; row: any }> {
  const b = await rpc(uid, 'create_live_battle', ids, format, mode);
  for (let seat = 1; seat < FORMATS[format]!.size; seat++) await rpc(uid, 'call_live_bot', b.id, seat, `Bot${seat}`);
  return { id: b.id, row: (await sql(`select * from public.live_battles where id = $1`, [b.id]))[0] };
}

describe('Battles', () => {
  const IDS = ['starter', 'flip', 'neon'];
  it('takes the cost of all the cases at create, refunds the creator who cancels', async () => {
    await fund(A, 500);
    const b = await rpc(A, 'create_live_battle', IDS, '1v1', 'normal');
    expect(b.balance).toBeCloseTo(500 - cost(IDS), 2); expect(await bal(A)).toBeCloseTo(500 - cost(IDS), 2);
    const l = await rpc(A, 'leave_live_battle', b.id);
    expect(l.status).toBe('cancelled'); expect(await bal(A)).toBe(500);
    await fails(rpc(A, 'leave_live_battle', b.id), 'already_started');
    expect(await bal(A)).toBe(500);
  });
  it('a battle with another real player: both pay, the last seat starts it, the winner is paid the pot, the bets are written', async () => {
    for (let i = 0; i < 4; i++) {
      await fund(A, 500); await fund(B, 500);
      const b = await rpc(A, 'create_live_battle', IDS, '1v1', 'normal');
      expect((await sql(`select status from public.live_battles where id = $1`, [b.id]))[0].status).toBe('waiting');
      const j = await rpc(B, 'join_live_battle', b.id, null);
      expect(j.status).toBe('running'); expect(j.balance).toBeCloseTo(await bal(B), 2);
      const ref = await reference(b.id), row = (await sql(`select outcome from public.live_battles where id = $1`, [b.id]))[0];
      expect(row.outcome.winners.slice().sort()).toEqual(ref.winners); expect(row.outcome.totals.map(Number)).toEqual(ref.totals); expect(Number(row.outcome.pot)).toBe(ref.pot);
      const aWon = ref.winners.includes(0), share = shareOf(ref.pot, ref.winners.length);
      expect(await bal(A)).toBeCloseTo(500 - cost(IDS) + (aWon ? share : 0), 2); expect(await bal(B)).toBeCloseTo(500 - cost(IDS) + (aWon ? 0 : share), 2);
    }
    const mine = await betsOf(A, 'battles');
    expect(mine.length).toBe(4); expect(Number(mine[0].amount)).toBeCloseTo(cost(IDS), 2);
  });
  it('every mode and format is decided exactly like the browser, and the winners are paid (checked on real draws)', async () => {
    const solo = ['1v1', '1v1v1', '1v1v1v1', '6way'], all = ['normal', 'crazy', 'terminal', 'jackpot', 'crazyjackpot', 'pointrush', 'group'];
    const combos: [string, string][] = [...solo.flatMap(f => all.map(m => [f, m] as [string, string])), ['2v2', 'normal'], ['2v2', 'crazy'], ['2v2', 'terminal'], ['3v3', 'normal'], ['3v3', 'crazy'], ['3v3', 'terminal']];
    const seenWinners = new Set<string>();
    for (let rep = 0; rep < 2; rep++) for (const [format, mode] of combos) {
      await fund(A, 1000);
      const { id, row } = await botBattle(A, IDS, format, mode);
      expect(row.status).toBe('running');
      const ref = await reference(id);
      expect(row.outcome.winners.slice().sort(), `${format} ${mode}`).toEqual(ref.winners);
      expect(row.outcome.totals.map(Number), `${format} ${mode}`).toEqual(ref.totals);
      expect(Number(row.outcome.pot)).toBe(ref.pot);
      const share = shareOf(ref.pot, ref.winners.length), aWon = ref.winners.includes(0);
      expect(await bal(A), `${format} ${mode}`).toBeCloseTo(1000 - cost(IDS) + (aWon ? share : 0), 2);
      seenWinners.add(`${mode}:${aWon}`);
    }
    expect(seenWinners.size).toBeGreaterThan(8);                                              // both outcomes occurred across the modes
  });
  it('bots play for the house: a bot seat costs nothing and when a bot wins the pot goes to nobody', async () => {
    for (let i = 0; i < 12; i++) {
      await fund(A, 1000);
      const { id } = await botBattle(A, IDS, '1v1', 'normal'), ref = await reference(id), aWon = ref.winners.includes(0);
      expect(await bal(A)).toBeCloseTo(1000 - cost(IDS) + (aWon ? ref.pot : 0), 2);          // exactly the stake, or the whole pot (both players' pulls)
      if (!aWon) expect((await betsOf(A, 'battles')).pop().payout).toBe('0.00');
    }
  });
  it('lets a joiner leave and get the cost back; the creator leaving refunds everyone', async () => {
    await fund(A, 500); await fund(B, 500); await fund(C, 500);
    const b = await rpc(A, 'create_live_battle', IDS, '6way', 'normal');
    await rpc(B, 'join_live_battle', b.id, null);
    expect(await bal(B)).toBeCloseTo(500 - cost(IDS), 2);
    const l = await rpc(B, 'leave_live_battle', b.id);
    expect(await bal(B)).toBe(500); expect(l.player_ids).not.toContain(B);
    await rpc(B, 'join_live_battle', b.id, null); await rpc(C, 'join_live_battle', b.id, null);
    await rpc(A, 'leave_live_battle', b.id);                                                  // the creator cancels it for everyone
    expect(await bal(A)).toBe(500); expect(await bal(B)).toBe(500); expect(await bal(C)).toBe(500);
  });
  it('refuses a join that cannot be paid (the seat stays free), a battle already started, and unknown or reward cases', async () => {
    await fund(A, 500); await fund(B, 1);
    const b = await rpc(A, 'create_live_battle', IDS, '1v1', 'normal');
    await fails(rpc(B, 'join_live_battle', b.id, null), 'insufficient_funds');
    expect((await sql(`select player_ids from public.live_battles where id = $1`, [b.id]))[0].player_ids).toEqual([A]);
    await rpc(A, 'leave_live_battle', b.id);
    await fails(rpc(A, 'create_live_battle', ['nope'], '1v1', 'normal'), 'invalid_cases');
    await fails(rpc(A, 'create_live_battle', ['daily'], '1v1', 'normal'), 'invalid_cases');
    const done = await botBattle(A, IDS, '1v1', 'normal');
    await fails(rpc(B, 'join_live_battle', done.id, null), 'battle_not_open');
    await fails(rpc(A, 'leave_live_battle', done.id), 'already_started');
  });
  it('obeys the site switch and closes an old waiting lobby with a refund', async () => {
    await fund(A, 500);
    await sql(`update public.site_controls set games_off = '{battles}'`);
    await fails(rpc(A, 'create_live_battle', IDS, '1v1', 'normal'), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
    const b = await rpc(A, 'create_live_battle', IDS, '1v1', 'normal');
    await sql(`update public.live_battles set created_at = now() - interval '40 minutes' where id = $1`, [b.id]);
    await rpc(A, 'wallet_me');
    expect((await sql(`select status from public.live_battles where id = $1`, [b.id]))[0].status).toBe('cancelled');
    expect(await bal(A)).toBe(500);
  });
});

// ============================ crash and double =============================================================================
const advance = async (uid: string, game: string): Promise<any> => (await rpc(uid, 'advance_round', game)).round;
const fresh = async (game: string): Promise<any> => { await sql(`update public.game_rounds set status = 'finished', finished_at = now() - interval '1 day' where game = $1`, [game]); return advance(A, game); };
const seedOf = async (id: number): Promise<string> => (await sql(`select server_seed from public.game_round_secrets where round_id = $1`, [id]))[0].server_seed;
const crashOf = async (id: number): Promise<number> => { const f = (await floatsFor(await seedOf(id), String(id), 0, 1))[0]!; return Math.min(10000, Math.max(1, Math.floor((100 * 0.97) / (1 - f)) / 100)); };
const crashRound = async (ok: (cp: number) => boolean): Promise<{ r: any; cp: number }> => {
  for (let i = 0; i < 80; i++) { const r = await fresh('crash'); const cp = await crashOf(r.id); if (ok(cp)) return { r, cp }; }
  throw new Error('no suitable round');
};
const startedAgo = (id: number, secs: number) => sql(`update public.game_rounds set betting_ends_at = now() - make_interval(secs => $2) where id = $1`, [id, secs]);
const crashSecs = (cp: number): number => Math.log(cp) / 0.00012 / 1000;

describe('Crash', () => {
  it('takes the stake at the bet, refunds a cancel, and writes the bet when the round ends', async () => {
    await fund(A, 100);
    const { r } = await crashRound(cp => cp > 3);
    const p = await rpc(A, 'crash_place_bet', r.id, 20, null, false);
    expect(p.balance).toBe(80); expect(await bal(A)).toBe(80);
    expect(Number(await rpc(A, 'crash_cancel_bet', r.id))).toBe(20); expect(await bal(A)).toBe(100);
    await fails(rpc(A, 'crash_cancel_bet', r.id), 'no_bet');
    await rpc(A, 'crash_place_bet', r.id, 20, null, false);
    await fails(rpc(A, 'crash_place_bet', r.id, 5, null, false), 'already_bet');
    expect(await bal(A)).toBe(80);
  });
  it('pays a manual cash-out at once at the server multiplier, and the rest is lost at the crash', async () => {
    await fund(B, 100);
    const { r, cp } = await crashRound(cp => cp > 3);
    await rpc(B, 'crash_place_bet', r.id, 10, null, false);
    await startedAgo(r.id, crashSecs(Math.min(cp, 2)) );                                       // the multiplier is now about 2 (or less)
    const c = await rpc(B, 'crash_cashout', r.id, 1);
    expect(c.got).toBeCloseTo(10 * c.mult, 2); expect(await bal(B)).toBeCloseTo(90 + c.got, 2); expect(c.balance).toBeCloseTo(await bal(B), 2);
    await startedAgo(r.id, crashSecs(cp) + 1); await advance(A, 'crash');
    expect(await bal(B)).toBeCloseTo(90 + c.got, 2);                                           // no second payment at the crash
    const bets = await betsOf(B, 'crash'); const last = bets[bets.length - 1];
    expect(Number(last.amount)).toBe(10); expect(Number(last.payout)).toBeCloseTo(c.got, 2);
  });
  it('pays an automatic cash-out below the crash point when the round ends; a bet that rides is lost', async () => {
    await fund(A, 100); await fund(C, 100);
    const { r, cp } = await crashRound(x => x > 2);
    await rpc(A, 'crash_place_bet', r.id, 10, 1.5, false); await rpc(C, 'crash_place_bet', r.id, 10, null, false);
    expect(await bal(A)).toBe(90);
    await startedAgo(r.id, crashSecs(cp) + 1); const fin = await advance(B, 'crash');
    expect(fin.status).toBe('finished');
    expect(await bal(A)).toBeCloseTo(90 + 15, 2); expect(await bal(C)).toBe(90);
    const a = (await betsOf(A, 'crash')).pop(), c = (await betsOf(C, 'crash')).pop();
    expect(Number(a.payout)).toBe(15); expect(Number(c.payout)).toBe(0);
    await advance(B, 'crash'); expect(await bal(A)).toBeCloseTo(105, 2);                      // settling is idempotent
  });
  it('an auto cash-out above the crash point loses', async () => {
    await fund(A, 100);
    const { r, cp } = await crashRound(x => x < 2);
    await rpc(A, 'crash_place_bet', r.id, 10, 5, false);
    await startedAgo(r.id, crashSecs(cp) + 1); await advance(B, 'crash');
    expect(await bal(A)).toBe(90);
  });
  it('refuses a bet that cannot be paid, and obeys the site switch', async () => {
    await fund(A, 5);
    const { r } = await crashRound(cp => cp > 1.2);
    await fails(rpc(A, 'crash_place_bet', r.id, 10, null, false), 'insufficient_funds');
    expect(await bal(A)).toBe(5);
    await sql(`update public.site_controls set games_off = '{crash}'`);
    await fails(rpc(A, 'crash_place_bet', r.id, 1, null, false), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
  });
});

describe('Double', () => {
  const settle = async (): Promise<{ r: any; n: number }> => {
    const r = await fresh('double');
    return { r, n: -1 };
  };
  it('takes stakes per lane, refuses both sides, and pays the winning lanes when the roll ends', async () => {
    await fund(A, 200); await fund(B, 200);
    const { r } = await settle();
    await rpc(A, 'double_place_bet', r.id, 'purple', 10, false);
    await rpc(A, 'double_place_bet', r.id, 'purple', 5, false);                                   // adds to the same lane
    await rpc(A, 'double_place_bet', r.id, 'green', 2, false);
    await fails(rpc(A, 'double_place_bet', r.id, 'gray', 5, false), 'both_sides');
    await rpc(B, 'double_place_bet', r.id, 'gray', 20, false); await rpc(B, 'double_place_bet', r.id, 'bait', 4, false);
    expect(await bal(A)).toBe(200 - 17); expect(await bal(B)).toBe(200 - 24);
    await startedAgo(r.id, 6); const fin = await advance(C, 'double');
    expect(fin.status).toBe('finished');
    const n = fin.result.n as number, win = (lane: DoubleLane, amt: number): number => (doubleWins(lane, n) ? r2(amt * DOUBLE_PAY[lane]) : 0);
    expect(await bal(A)).toBeCloseTo(183 + win('purple', 15) + win('green', 2), 2);
    expect(await bal(B)).toBeCloseTo(176 + win('gray', 20) + win('bait', 4), 2);
    const bets = await betsOf(A, 'double');
    expect(bets.map((b: any) => Number(b.amount)).sort((x, y) => x - y)).toEqual([2, 15]);
    await advance(C, 'double'); expect(await bal(A)).toBeCloseTo(183 + win('purple', 15) + win('green', 2), 2);   // paid once
  });
  it('refuses a stake that cannot be paid and obeys the site switch', async () => {
    await fund(C, 1);
    const { r } = await settle();
    await fails(rpc(C, 'double_place_bet', r.id, 'purple', 5, false), 'insufficient_funds');
    await sql(`update public.site_controls set games_off = '{double}'`);
    await fails(rpc(A, 'double_place_bet', r.id, 'purple', 1, false), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
  });
});

// ============================ rewards ======================================================================================
describe('Rewards', () => {
  it('the faucet gives 25 coins every 10 minutes', async () => {
    await fund(C, 0);
    const a = await rpc(C, 'claim_faucet');
    expect(a.claimed).toBe(true); expect(a.balance).toBe(25); expect(await bal(C)).toBe(25);
    const b = await rpc(C, 'claim_faucet');
    expect(b.claimed).toBe(false); expect(await bal(C)).toBe(25); expect(b.next_at).toBeGreaterThan(Date.now());
    await sql(`update public.player_rewards set faucet_at = now() - interval '11 minutes' where user_id = $1`, [C]);
    expect((await rpc(C, 'claim_faucet')).claimed).toBe(true); expect(await bal(C)).toBe(50);
  });
  it('rakeback is a share of every stake, claimed once and not before it is ready', async () => {
    await sql(`update public.player_rewards set rb_instant = 0, rb_daily = 0, rb_weekly = 0, last_daily = null, last_weekly = null where user_id = $1`, [B]);
    await fund(B, 1000);
    await fails(rpc(B, 'claim_rakeback', 'instant'), 'nothing_to_claim');
    const f = await rpc(B, 'create_live_coinflip', 'bolt', 1000); await rpc(B, 'cancel_live_coinflip', f.id);
    const me = await rpc(B, 'wallet_me');
    expect(me.rewards.rb_instant).toBe(4); expect(me.rewards.rb_daily).toBe(3); expect(me.rewards.rb_weekly).toBe(3);
    const c = await rpc(B, 'claim_rakeback', 'instant'); expect(c.amount).toBe(4); expect(await bal(B)).toBe(1004);
    await fails(rpc(B, 'claim_rakeback', 'instant'), 'nothing_to_claim');
    expect((await rpc(B, 'claim_rakeback', 'daily')).amount).toBe(3);
    const f2 = await rpc(B, 'create_live_coinflip', 'bolt', 1000); await rpc(B, 'cancel_live_coinflip', f2.id);
    await fails(rpc(B, 'claim_rakeback', 'daily'), 'not_ready');
    await sql(`update public.player_rewards set last_daily = now() - interval '25 hours' where user_id = $1`, [B]);
    expect((await rpc(B, 'claim_rakeback', 'daily')).amount).toBe(3);
    await fails(rpc(B, 'claim_rakeback', 'monthly'), 'invalid_claim');
  });
  it('the login calendar pays 1 2 3 5 8 12 25, once a day, and a missed day starts over', async () => {
    await fund(Z, 0);
    const days = [1, 2, 3, 5, 8, 12, 25, 1];
    for (let i = 0; i < days.length; i++) {
      const r = await rpc(Z, 'claim_calendar');
      expect(r.amount).toBe(days[i]); expect(r.day).toBe((i % 7) + 1);
      await fails(rpc(Z, 'claim_calendar'), 'already_claimed');
      await sql(`update public.player_rewards set calendar_last = calendar_last - 1 where user_id = $1`, [Z]);       // pretend a day went by
    }
    await sql(`update public.player_rewards set calendar_last = calendar_last - 3 where user_id = $1`, [Z]);          // miss three days
    expect((await rpc(Z, 'claim_calendar')).day).toBe(1);
  });
  it('promo codes work once per player, in any case, and not when invalid, used up or expired', async () => {
    await fund(Z, 0);
    expect((await rpc(Z, 'redeem_promo', ' vault10 ')).amount).toBe(10); expect(await bal(Z)).toBe(10);
    await fails(rpc(Z, 'redeem_promo', 'VAULT10'), 'code_used');
    await fails(rpc(Z, 'redeem_promo', 'NOPE'), 'invalid_code'); await fails(rpc(Z, 'redeem_promo', ''), 'invalid_code');
    expect((await rpc(Z, 'redeem_promo', 'RUSH5')).amount).toBe(5);
    await sql(`insert into public.promo_codes (code, amount, max_uses) values ('ONLY1', 50, 1), ('OLD', 50, null), ('OFF', 50, null)`);
    await sql(`update public.promo_codes set expires_at = now() - interval '1 day' where code = 'OLD'`); await sql(`update public.promo_codes set active = false where code = 'OFF'`);
    await rpc(A, 'redeem_promo', 'ONLY1'); await fails(rpc(B, 'redeem_promo', 'ONLY1'), 'code_used_up');
    await fails(rpc(Z, 'redeem_promo', 'OLD'), 'invalid_code'); await fails(rpc(Z, 'redeem_promo', 'OFF'), 'invalid_code');
    await expect((async () => { await db.exec(`set role authenticated`); try { await db.query(`select * from public.promo_codes`); } finally { await db.exec('reset role;'); } })()).rejects.toThrow('permission denied');
  });
  it('the welcome crate opens once per account, the daily crate once per 24 hours; the item is in the inventory and recomputable', async () => {
    const w = await rpc(Z, 'open_free_case', 'welcome');
    expect(w.claimed).toBe(true); expect(w.case).toBe('welcome');
    expect((await sql(`select item_id from public.inventory where id = $1 and user_id = $2`, [w.uid, Z]))[0].item_id).toBe(w.item);
    expect(entryForTicket(CASE['welcome']!, w.ticket).item.id).toBe(w.item);
    expect((await rpc(Z, 'open_free_case', 'welcome')).claimed).toBe(false);
    const d = await rpc(Z, 'open_free_case', 'daily_case'); expect(d.claimed).toBe(true); expect(d.next).toBeTruthy();
    expect((await rpc(Z, 'open_free_case', 'daily_case')).claimed).toBe(false);
    await sql(`update public.free_claims set claimed_at = now() - interval '25 hours' where user_id = $1 and kind = 'daily_case'`, [Z]);
    expect((await rpc(Z, 'open_free_case', 'daily_case')).claimed).toBe(true);
    await fails(rpc(Z, 'open_free_case', 'level_5'), 'invalid_claim'); await fails(rpc(Z, 'open_free_case', 'bogus'), 'invalid_claim');
    const me = await rpc(Z, 'wallet_me'); expect(me.rewards.welcome_at).toBeGreaterThan(0); expect(me.rewards.daily_case_at).toBeGreaterThan(0);
    expect(me.inventory.length).toBe(3);
  });
  it('level crates need the level and are opened once', async () => {
    await sql(`update public.wallets set wagered = 0 where user_id = $1`, [Z]);
    await fails(rpc(Z, 'open_free_case', 'level_10'), 'level_too_low');
    await sql(`update public.wallets set wagered = 1000 where user_id = $1`, [Z]);            // 10,000 XP = level 31
    const a = await rpc(Z, 'open_free_case', 'level_10'); expect(a.claimed).toBe(true); expect(a.case).toBe('starter'); expect(a.label).toBe('Level 10 key');
    expect((await rpc(Z, 'open_free_case', 'level_10')).claimed).toBe(false);
    expect((await rpc(Z, 'open_free_case', 'level_30')).case).toBe('charmed');
    await fails(rpc(Z, 'open_free_case', 'level_40'), 'level_too_low');
  });
  it('yesterday\'s race pays the top 10 by wagered coins, once', async () => {
    await sql(`delete from public.bets`);
    const ids = [A, B, C, Z];
    for (const [i, u] of ids.entries()) await sql(`insert into public.bets (user_id, game, amount, payout, created_at) values ($1, 'plinko', $2, 0, (date_trunc('day', now() at time zone 'utc') - interval '12 hours') at time zone 'utc')`, [u, 1000 - i * 100]);
    await sql(`insert into public.bets (user_id, game, amount, payout) values ($1, 'plinko', 99999, 0)`, [C]);               // today's bets do not count yesterday
    const prev = await sql('select display_name, wagered from public.daily_race_prev'), today = await sql('select display_name, wagered from public.daily_race');
    expect(prev.map((r: any) => [r.display_name, Number(r.wagered)])).toEqual([['Alice', 1000], ['Bob', 900], ['Cara', 800], ['Zed', 700]]);
    expect(today.map((r: any) => [r.display_name, Number(r.wagered)])).toEqual([['Cara', 99999]]);
    await fund(A, 0); await fund(Z, 0);
    const a = await rpc(A, 'claim_race_prize'); expect(a).toMatchObject({ paid: true, rank: 1, prize: 400 }); expect(await bal(A)).toBe(400);
    expect((await rpc(A, 'claim_race_prize')).paid).toBe(false); expect(await bal(A)).toBe(400);
    expect(await rpc(Z, 'claim_race_prize')).toMatchObject({ paid: true, rank: 4, prize: 80 });
    await sql(`update public.player_rewards set race_paid = null where user_id = $1`, [A]);
  });
});

// ============================ nothing is minted ============================================================================
describe('the ledger replays to the wallet', () => {
  it('every coin that moved is on the ledger, in order, and the balance is the sum', async () => {
    const U = '88888888-8888-4888-8888-888888888888';
    await db.exec(`insert into auth.users (id, email) values ('${U}', 'u@example.com')`);
    await rpc(U, 'complete_signup', 'Uma', TERMS, true);
    await rpc(U, 'claim_faucet'); await rpc(U, 'redeem_promo', 'LUCKY7'); await rpc(U, 'claim_calendar');
    for (let i = 0; i < 8; i++) { await rpc(U, 'plinko_drop', 12, 'normal', 1); }
    await rpc(U, 'open_cases', 'starter', 2);
    const inv = (await sql(`select id from public.inventory where user_id = $1`, [U])).map(r => r.id); if (inv.length) await rpc(U, 'sell_items', inv.slice(0, 1));
    const f = await rpc(U, 'create_live_coinflip', 'bolt', 2); await rpc(U, 'cancel_live_coinflip', f.id);
    const m = await rpc(U, 'mines_start', 3, 25, 3); await rpc(U, 'mines_cancel', m.game);
    const rows = await sql(`select amount, balance_after from public.ledger where user_id = $1 order by id`, [U]);
    expect(rows.length).toBeGreaterThan(15);
    let run = 0;
    for (const r of rows) { run = r2(run + Number(r.amount)); expect(Number(r.balance_after)).toBeCloseTo(run, 2); }
    expect(await bal(U)).toBeCloseTo(run, 2);
    expect(run).toBeGreaterThanOrEqual(0);
  });
});
