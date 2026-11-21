// @vitest-environment node
// Migration 0018: every responsible-play limit is enforced by the database. Changing limits (tighter at once, looser after 24 hours), the wager, loss (day, week,
// month) and play-time limits, cool-off and self-exclusion, all checked through a real stake (a Plinko drop goes through the same gate as every other game).
// Past days are made by moving a bet's time back, because the database counts UTC calendar days.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const U = Array.from({ length: 24 }, (_, i) => `a0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
let taken = 0;
const fresh = (): string => U[taken++]!;                                                      // every test gets a player of its own, so nothing leaks between tests
const TERMS = '2026-11-21';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits'];
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

/** A Plinko stake. The payout and the time are then set by hand, so every test knows exactly what the player has lost and when. */
async function play(uid: string, amount: number, o: { payout?: number; ago?: string } = {}): Promise<void> {
  await rpc(uid, 'plinko_drop', 12, 'normal', amount);
  const ago = o.ago ?? '0 seconds';
  await sql(`update public.bets set payout = $2, created_at = now() - $3::interval where id = (select max(id) from public.bets where user_id = $1)`, [uid, o.payout ?? 0, ago]);
  await sql(`update public.ledger set created_at = now() - $2::interval where id = (select max(id) from public.ledger where user_id = $1 and kind = 'bet')`, [uid, ago]);
}
const stake = (uid: string, amount: number) => rpc(uid, 'plinko_drop', 12, 'normal', amount);          // a stake that is expected to be refused
const setLimit = (uid: string, col: string, v: number | null) => sql(`update public.account_controls set ${col} = $2 where user_id = $1`, [uid, v]);
const column = async (uid: string, col: string) => (await sql(`select ${col} as v from public.account_controls where user_id = $1`, [uid]))[0].v;
const mins = async (uid: string) => (await sql(`select public.rg_active_minutes($1) as v`, [uid]))[0].v as number;
const ms = (v: Date | string | number) => new Date(v).getTime();
// the time tests put bets up to nine minutes back; right after midnight UTC those would fall on the day before
const nearMidnight = (() => { const n = new Date(); return n.getUTCHours() === 0 && n.getUTCMinutes() < 15; })();

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [i, id] of U.entries()) {
    await rpc(id, 'complete_signup', `Player${i}`, TERMS, true);
    await sql(`update public.wallets set balance = 1000000 where user_id = $1`, [id]);
  }
}, 180_000);
afterAll(async () => { await db.close(); });

describe('changing a limit', () => {
  it('a first limit applies at once, a lower one too, a higher or removed one waits 24 hours, asking for the current value cancels the wait', async () => {
    const u = fresh();
    expect(await rpc(u, 'request_limit_change', 'loss_weekly', 5000)).toBe('applied');
    expect(Number(await column(u, 'loss_weekly'))).toBe(5000);
    expect(await rpc(u, 'request_limit_change', 'loss_weekly', 3000)).toBe('applied');            // tighter
    expect(await rpc(u, 'request_limit_change', 'loss_weekly', 4000)).toBe('pending');            // looser: waits
    expect(Number(await column(u, 'loss_weekly'))).toBe(3000);
    let me = await rpc(u, 'my_limits');
    expect(me.pending).toHaveLength(1);
    expect(me.pending[0]).toMatchObject({ key: 'loss_weekly', value: 4000 });
    expect(me.pending[0].effective_at - me.now).toBeGreaterThan(23.9 * 3600_000);                  // about a day away
    expect(await rpc(u, 'request_limit_change', 'loss_weekly', null)).toBe('pending');            // removing waits too, and replaces the earlier request
    me = await rpc(u, 'my_limits');
    expect(me.pending).toHaveLength(1); expect(me.pending[0].value).toBeNull();
    expect(await rpc(u, 'request_limit_change', 'loss_weekly', 3000)).toBe('same');               // the current value: cancels the pending change
    expect((await rpc(u, 'my_limits')).pending).toHaveLength(0);
  });

  it('works for all six limits', async () => {
    const u = fresh();
    const want: Record<string, number> = { max_bet: 500, loss_daily: 1000, loss_weekly: 4000, loss_monthly: 9000, wager_daily: 2500, time_daily_min: 90 };
    for (const [k, v] of Object.entries(want)) expect(await rpc(u, 'request_limit_change', k, v)).toBe('applied');
    const me = await rpc(u, 'my_limits');
    for (const [k, v] of Object.entries(want)) expect(Number(me.limits[k]), k).toBe(v);
  });

  it('refuses unknown limits and values that make no sense', async () => {
    const u = fresh();
    await fails(rpc(u, 'request_limit_change', 'balance', 1), 'unknown_limit');
    await fails(rpc(u, 'request_limit_change', null, 1), 'unknown_limit');
    await fails(rpc(u, 'request_limit_change', 'loss_daily', -1), 'invalid_limit');
    await fails(rpc(u, 'request_limit_change', 'loss_daily', 12.345), 'invalid_limit');            // more than two decimals
    await fails(rpc(u, 'request_limit_change', 'time_daily_min', 1.5), 'invalid_limit');          // whole minutes only
    await fails(rpc(u, 'request_limit_change', 'time_daily_min', 1441), 'invalid_limit');          // more than a day
  });

  it('a change that has become due is applied the next time the player looks or plays', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'wager_daily', 100);
    await rpc(u, 'request_limit_change', 'wager_daily', 5000);                                     // pending
    await sql(`update public.limit_changes set effective_at = now() - interval '1 minute' where user_id = $1`, [u]);
    const me = await rpc(u, 'my_limits');
    expect(Number(me.limits.wager_daily)).toBe(5000); expect(me.pending).toHaveLength(0);

    const v = fresh();
    await rpc(v, 'request_limit_change', 'max_bet', 50);
    await rpc(v, 'request_limit_change', 'max_bet', 500);                                          // pending
    await fails(stake(v, 100), 'max_bet_exceeded');                                                // still 50
    await sql(`update public.limit_changes set effective_at = now() - interval '1 minute' where user_id = $1`, [v]);
    await play(v, 100);                                                                            // the gate applies it first, so the stake of 100 goes through
    expect(Number(await column(v, 'max_bet'))).toBe(500);
  });
});

describe('the gate', () => {
  it('the maximum bet and the verification cap still apply', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'max_bet', 100);
    await play(u, 100);
    await fails(stake(u, 100.01), 'max_bet_exceeded');
    const v = fresh();
    await play(v, 10_000);                                                                         // the level-0 cap, exactly
    await fails(stake(v, 10_000.01), 'tier_cap_exceeded');
  });

  it('daily wager: counts what was staked today, lets the limit be reached exactly, and does not count refunds or earlier days', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'wager_daily', 1000);
    await play(u, 600);
    await fails(stake(u, 500), 'wager_daily_limit');                                               // 600 + 500 > 1000
    await play(u, 400);                                                                            // exactly 1000: allowed
    await fails(stake(u, 1), 'wager_daily_limit');
    expect(Number((await rpc(u, 'my_limits')).usage.staked_today)).toBe(1000);
    await sql(`insert into public.ledger (user_id, kind, amount, balance_after) values ($1, 'refund', 400, 0)`, [u]);   // a refunded stake does not count
    expect(Number((await rpc(u, 'my_limits')).usage.staked_today)).toBe(600);
    await play(u, 400);

    const v = fresh();
    await rpc(v, 'request_limit_change', 'wager_daily', 1000);
    await play(v, 900, { ago: '2 days' });                                                         // an earlier day
    await play(v, 1000);                                                                           // today starts again at zero
    await fails(stake(v, 1), 'wager_daily_limit');
  });

  it('daily loss: stake plus the day\'s net loss must stay within the limit, winnings offset losses but never count as room above it', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'loss_daily', 1000);
    await play(u, 700);                                                                            // lost 700
    await fails(stake(u, 400), 'daily_loss_limit');                                                // 700 + 400 > 1000
    await play(u, 300);                                                                            // exactly 1000
    await fails(stake(u, 1), 'daily_loss_limit');

    const w = fresh();
    await rpc(w, 'request_limit_change', 'loss_daily', 1000);
    await play(w, 700, { payout: 1500 });                                                          // ahead by 800
    await fails(stake(w, 1000.01), 'daily_loss_limit');                                            // being ahead gives no room above the limit
    await play(w, 1000);                                                                           // the limit itself is fine

    const y = fresh();
    await rpc(y, 'request_limit_change', 'loss_daily', 1000);
    await play(y, 900, { ago: '1 day' });                                                          // yesterday's loss does not count today
    await play(y, 1000);
  });

  it('weekly loss counts today and the six days before, not the seventh', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'loss_weekly', 2000);
    await play(u, 1500, { ago: '3 days' });
    await fails(stake(u, 600), 'weekly_loss_limit');                                               // 1500 + 600 > 2000
    await play(u, 500);                                                                            // exactly 2000
    await fails(stake(u, 1), 'weekly_loss_limit');

    const edge = fresh();
    await play(edge, 1000, { ago: '6 days' });
    await play(edge, 1000, { ago: '7 days' });
    expect(Number((await sql(`select public.rg_net_loss($1, 7) as v`, [edge]))[0].v)).toBe(1000);    // the six-day-old bet counts, the seven-day-old one does not
    const old = fresh();
    await play(old, 5000, { ago: '8 days' });                                                      // placed before the limit exists
    await rpc(old, 'request_limit_change', 'loss_weekly', 2000);
    await play(old, 2000);                                                                         // the 8-day-old loss is outside the week
  });

  it('monthly loss counts today and the 29 days before, not the 30th', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'loss_monthly', 3000);
    await play(u, 2500, { ago: '20 days' });
    await fails(stake(u, 600), 'monthly_loss_limit');
    await play(u, 500);
    await fails(stake(u, 1), 'monthly_loss_limit');

    const edge = fresh();
    await play(edge, 1000, { ago: '29 days' });
    await play(edge, 1000, { ago: '30 days' });
    expect(Number((await sql(`select public.rg_net_loss($1, 30) as v`, [edge]))[0].v)).toBe(1000);
  });

  it.skipIf(nearMidnight)('play time: estimated from the gaps between stakes (a gap over 5 minutes does not count, each stake adds 20 seconds)', async () => {
    const a = fresh();
    await play(a, 10, { ago: '8 minutes' }); await play(a, 10, { ago: '7 minutes' }); await play(a, 10, { ago: '6 minutes' });
    expect(await mins(a)).toBe(3);                                                                 // two gaps of 60 s + 3 x 20 s = 180 s
    await setLimit(a, 'time_daily_min', 3);
    await fails(stake(a, 10), 'time_limit');
    await setLimit(a, 'time_daily_min', 4);
    await play(a, 10);

    const b = fresh();
    await play(b, 10, { ago: '9 minutes' }); await play(b, 10, { ago: '2 minutes' });
    expect(await mins(b)).toBe(0);                                                                 // a gap of 7 minutes is a break, only 2 x 20 s count
    await setLimit(b, 'time_daily_min', 1);
    await play(b, 10);
    expect((await rpc(b, 'my_limits')).usage.active_minutes).toBe(await mins(b));
  });

  it('a limit of zero minutes stops play today', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'time_daily_min', 0);
    await fails(stake(u, 10), 'time_limit');
  });

  it('cool-off: refuses stakes, can be extended but never shortened, has a sensible range', async () => {
    const u = fresh();
    const first = ms(await rpc(u, 'start_cool_off', 2));
    expect(first - Date.now()).toBeGreaterThan(1.9 * 3600_000);
    await fails(stake(u, 10), 'cool_off');
    expect(ms(await rpc(u, 'start_cool_off', 1))).toBe(first);                                     // a shorter one changes nothing
    expect(ms(await rpc(u, 'start_cool_off', 5))).toBeGreaterThan(first);                          // a longer one extends
    expect((await rpc(u, 'my_limits')).cool_off_until).toBeGreaterThan(Date.now() + 4.9 * 3600_000);
    await fails(rpc(u, 'start_cool_off', 0), 'invalid_duration');
    await fails(rpc(u, 'start_cool_off', 721), 'invalid_duration');
    await sql(`update public.account_controls set cool_off_until = now() - interval '1 second' where user_id = $1`, [u]);
    await play(u, 10);                                                                             // over: play again
  });

  it('self-exclusion: refuses stakes on the server and can never be shortened', async () => {
    const u = fresh();
    const first = ms(await rpc(u, 'self_exclude', 24));
    await fails(stake(u, 10), 'self_excluded');
    expect(ms(await rpc(u, 'self_exclude', 1))).toBe(first);
    expect((await rpc(u, 'my_limits')).excluded_until).toBe(first);
  });

  it('every kind of stake goes through the gate, not only Plinko', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'wager_daily', 100);
    await fails(rpc(u, 'create_live_coinflip', 'bolt', 150), 'wager_daily_limit');
    const round = (await rpc(u, 'advance_round', 'crash')).round;
    await fails(rpc(u, 'crash_place_bet', round.id, 150, null, false), 'wager_daily_limit');
    const double = (await rpc(u, 'advance_round', 'double')).round;
    await fails(rpc(u, 'double_place_bet', double.id, 'green', 150, false), 'wager_daily_limit');
    expect((await rpc(u, 'create_live_coinflip', 'bolt', 100)).id).toBeTruthy();                   // within the limit
  });
});

describe('what the page is told', () => {
  it('my_limits has the limits, what is used, the break dates and the clock', async () => {
    const u = fresh();
    await rpc(u, 'request_limit_change', 'loss_daily', 5000);
    await rpc(u, 'request_limit_change', 'wager_daily', 9000);
    await play(u, 800, { payout: 300 });
    await play(u, 200);
    await play(u, 1000, { ago: '3 days' });
    const me = await rpc(u, 'my_limits');
    expect(Number(me.limits.loss_daily)).toBe(5000); expect(me.limits.max_bet).toBeNull();
    expect(Number(me.usage.staked_today)).toBe(1000);
    expect(Number(me.usage.loss_1)).toBe(700);                                                     // 800 - 300 + 200
    expect(Number(me.usage.loss_7)).toBe(1700);
    expect(Number(me.usage.loss_30)).toBe(1700);
    expect(me.excluded_until).toBeNull(); expect(me.cool_off_until).toBeNull();
    expect(me.kyc_tier).toBe(0);
    expect(Math.abs(me.now - Date.now())).toBeLessThan(60_000);
  });
});

describe('what players cannot do', () => {
  it('cannot call the counting helpers directly', async () => {
    const u = fresh();
    await fails(rpc(u, 'rg_staked', u), 'permission denied');
    await fails(rpc(u, 'rg_net_loss', u, 7), 'permission denied');
    await fails(rpc(u, 'rg_active_minutes', u), 'permission denied');
    await fails(rpc(u, 'rg_day_start', 0), 'permission denied');
  });
});

describe('the migration', () => {
  it('can be run a second time without changing anything, and only the six limit names are allowed', async () => {
    const def = async () => (await sql(`select pg_get_functiondef('public.wallet_gate(uuid, numeric)'::regprocedure) as d`))[0].d as string;
    const before = await def();
    await db.exec(readFileSync(new URL('../supabase/migrations/0018_server_limits.sql', import.meta.url), 'utf8'));
    expect(await def()).toBe(before);
    for (const code of ['wager_daily_limit', 'daily_loss_limit', 'weekly_loss_limit', 'monthly_loss_limit', 'time_limit', 'cool_off', 'self_excluded']) expect(before, code).toContain(code);
    expect(before).toContain('50000');                                                             // the verification caps of 0017 survived the rewrite
    await expect(sql(`insert into public.limit_changes (user_id, key, value, effective_at) values ($1, 'bogus', 1, now())`, [U[0]])).rejects.toThrow();
  });
});
