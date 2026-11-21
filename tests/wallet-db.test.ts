// @vitest-environment node
// The server wallet and the four solo games (migrations 0008 to 0010) in an in-process Postgres: new accounts start at 0, the catalogue equals src/data.ts,
// Cases / Upgrade / Plinko / Mines move coins and items only inside the database, every result can be recomputed from the revealed seed with the browser's
// own maths, and the responsible-gambling gate, the site switches and the row-level security all hold.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES, REWARD_CASES, ITEMS, ITEM, entryForTicket, ticketOf } from '../src/data.js';
import { floatsFor, minePositions, minesMultiplier, plinkoTable, upgradeChance } from '../src/fair.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const P1 = '44444444-4444-4444-4444-444444444444';
const P2 = '55555555-5555-5555-5555-555555555555';
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
  insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${P1}', 'p1@example.com'), ('${P2}', 'p2@example.com');
`;
async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal: 'aal1' })}', false), set_config('request.headers', '', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, args: unknown[] = []): Promise<any> => as(uid, async () => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  return ((await db.query(`select public.${fn}(${ph}) as v`, args)).rows[0] as { v: unknown }).v;
});
const q = (uid: string | null, text: string, params: unknown[] = []) => as(uid, async () => (await db.query(text, params)).rows as any[]);
const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows as any[];
const fails = async (p: Promise<unknown>, what: string) => { await expect(p).rejects.toThrow(what); };
const fund = (uid: string, n: number) => sql(`update public.wallets set balance = $2 where user_id = $1`, [uid, n]);
const balance = async (uid: string): Promise<number> => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);
const inv = async (uid: string) => sql(`select id, item_id from public.inventory where user_id = $1 order by created_at, id`, [uid]);
const nonceOf = async (uid: string): Promise<number> => Number((await sql(`select nonce from public.seed_pairs where user_id = $1 and status = 'active'`, [uid]))[0].nonce);
/** Reveal the active seed (the player's own right) so a bet can be recomputed with the browser's maths. */
const rotate = async (uid: string) => { await rpc(uid, 'rotate_seed'); };
const reveal = async (uid: string) => { const r = await rpc(uid, 'rotate_seed'); return r as { server_seed: string; client_seed: string }; };
const lastBet = async (uid: string, game: string) => (await sql(`select * from public.bets where user_id = $1 and game = $2 order by id desc limit 1`, [uid, game]))[0];

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games'])
    await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [P1, 'Nova'], [P2, 'Quill']] as const) await rpc(id, 'complete_signup', [n, TERMS, true]);
}, 120_000);
afterAll(async () => { await db.close(); });

describe('new accounts and the wallet snapshot', () => {
  it('start with 0 coins, no items and a rewards row', async () => {
    const me = await rpc(P1, 'wallet_me');
    expect(me.balance).toBe(0); expect(me.inventory).toEqual([]); expect(me.xp).toBe(0);
    expect(me.rewards.rb_instant).toBe(0); expect(me.rewards.promos).toEqual([]);
    expect(await sql(`select 1 from public.player_rewards where user_id = $1`, [P1])).toHaveLength(1);
    expect(await sql(`select 1 from public.ledger where user_id = $1`, [P1])).toHaveLength(0);       // no starting bonus
  });
  it('nobody can touch money or items directly', async () => {
    await fails(q(P1, `update public.wallets set balance = 999999 where user_id = '${P1}'`), 'permission denied');
    await fails(q(P1, `insert into public.inventory (user_id, item_id) values ('${P1}', 'p1')`), 'permission denied');
    await fails(q(P1, `delete from public.inventory`), 'permission denied');
    await fails(q(P1, `insert into public.ledger (user_id, kind, amount, balance_after) values ('${P1}', 'win', 1, 1)`), 'permission denied');
    await fails(q(P1, `update public.player_rewards set rb_instant = 1000`), 'permission denied');
    for (const fn of ['wallet_debit', 'wallet_credit', 'inventory_add', 'fair_draw', 'wallet_gate', 'bet_record']) {
      const r = await sql(`select has_function_privilege('authenticated', p.oid, 'execute') as ok from pg_proc p where p.proname = $1`, [fn]);
      expect(r.every(x => x.ok === false), fn).toBe(true);
    }
  });
  it('shows a player only their own rows', async () => {
    await fund(P1, 50); await fund(P2, 50);
    await rpc(P1, 'open_cases', ['starter', 1]);
    expect((await q(P2, `select * from public.inventory`)).length).toBe(0);
    expect((await q(P1, `select * from public.inventory`)).length).toBe(1);
    expect((await q(P2, `select * from public.mines_games`)).length).toBe(0);
  });
});

describe('the catalogue equals src/data.ts', () => {
  it('has every item with the same value', async () => {
    const rows = await sql(`select id, value, rarity, weapon, skin from public.catalog_items`);
    expect(rows).toHaveLength(ITEMS.length);
    for (const r of rows) { const it = ITEM[r.id]!; expect(Number(r.value), r.id).toBe(it.value); expect(r.rarity).toBe(it.rarity); expect(r.weapon).toBe(it.weapon); expect(r.skin).toBe(it.skin); }
  });
  it('has every case with the same price and exactly the same ticket ranges, covering all 100,000 tickets', async () => {
    const all = [...CASES, ...REWARD_CASES];
    const cases = await sql(`select id, price, reward from public.catalog_cases`);
    expect(cases).toHaveLength(all.length);
    for (const c of all) {
      const row = cases.find(r => r.id === c.id)!;
      expect(Number(row.price), c.id).toBe(c.price); expect(row.reward).toBe(!!c.reward);
      const es = await sql(`select item_id, ticket_from, ticket_to from public.catalog_case_entries where case_id = $1 order by ticket_from`, [c.id]);
      expect(es.map(e => [e.item_id, e.ticket_from, e.ticket_to])).toEqual([...c.entries].sort((a, b) => a.from - b.from).map(e => [e.item.id, e.from, e.to]));
      expect(es[0]!.ticket_from).toBe(0); expect(es[es.length - 1]!.ticket_to).toBe(99999);
      for (let i = 1; i < es.length; i++) expect(es[i]!.ticket_from, `${c.id} gap`).toBe(es[i - 1]!.ticket_to + 1);
    }
  });
});

describe('provably fair floats', () => {
  it('fair_floats equals floatsFor in the browser, for several lengths and nonces', async () => {
    for (const [seed, cs, nonce, n] of [['ab'.repeat(32), 'client', 0, 1], ['cd'.repeat(32), 'c2', 7, 8], ['12'.repeat(32), 'xyz', 41, 9], ['ef'.repeat(32), 'q', 3, 24]] as const) {
      const got = (await sql(`select public.fair_floats($1, $2, $3, $4) as f`, [seed, cs, nonce, n]))[0].f as number[];
      expect(got).toEqual(await floatsFor(seed, cs, nonce, n));
    }
  });
});

describe('Cases', () => {
  it('opens cases: takes the price, gives the items, writes one bet per case, and every result matches the browser', async () => {
    await fund(P1, 500);
    const c = CASES.find(x => x.id === 'neon')!, n0 = await nonceOf(P1), items0 = (await inv(P1)).length;
    const r = await rpc(P1, 'open_cases', ['neon', 3]);
    expect(r.opened).toHaveLength(3);
    expect(Number(r.cost)).toBeCloseTo(c.price * 3, 2); expect(r.balance).toBeCloseTo(500 - c.price * 3, 2); expect(await balance(P1)).toBeCloseTo(500 - c.price * 3, 2);
    expect((await inv(P1)).length).toBe(items0 + 3);
    expect(await nonceOf(P1)).toBe(n0 + 3);
    expect(r.opened.map((o: any) => o.nonce)).toEqual([n0, n0 + 1, n0 + 2]);
    const seed = await reveal(P1);
    for (const o of r.opened) {
      const f = (await floatsFor(seed.server_seed, seed.client_seed, o.nonce, 1))[0]!;
      expect(o.ticket).toBe(ticketOf(f)); expect(o.item).toBe(entryForTicket(c, ticketOf(f)).item.id);
    }
    const bets = await sql(`select amount, payout, game from public.bets where user_id = $1 and game = 'cases' order by id desc limit 3`, [P1]);
    expect(bets.every(b => Number(b.amount) === c.price)).toBe(true);
    const led = await sql(`select kind, amount, balance_after from public.ledger where user_id = $1 order by id desc limit 1`, [P1]);
    expect(led[0]!.kind).toBe('bet'); expect(Number(led[0]!.amount)).toBeCloseTo(-c.price * 3, 2); expect(Number(led[0]!.balance_after)).toBeCloseTo(500 - c.price * 3, 2);
  });
  it('counts the wager for XP and rakeback', async () => {
    await fund(P1, 500);
    const before = await rpc(P1, 'wallet_me');
    await rpc(P1, 'open_cases', ['starter', 2]);
    const after = await rpc(P1, 'wallet_me'), c = CASES.find(x => x.id === 'starter')!;
    expect(after.wagered - before.wagered).toBeCloseTo(c.price * 2, 2);
    expect(after.rewards.rb_instant - before.rewards.rb_instant).toBeCloseTo(c.price * 2 * 0.004, 1);
  });
  it('refuses and changes nothing when the player cannot pay', async () => {
    await fund(P2, 1); const n0 = await nonceOf(P2), items0 = (await inv(P2)).length;
    await fails(rpc(P2, 'open_cases', ['high', 1]), 'insufficient_funds');
    expect(await balance(P2)).toBe(1); expect(await nonceOf(P2)).toBe(n0); expect((await inv(P2)).length).toBe(items0);
  });
  it('validates the request: reward crates are not for sale, count 1 to 10, unknown cases, repeated request keys', async () => {
    await fund(P1, 5000);
    await fails(rpc(P1, 'open_cases', ['daily', 1]), 'case_not_found');
    await fails(rpc(P1, 'open_cases', ['nope', 1]), 'case_not_found');
    await fails(rpc(P1, 'open_cases', ['starter', 0]), 'invalid_count');
    await fails(rpc(P1, 'open_cases', ['starter', 11]), 'invalid_count');
    await rpc(P1, 'open_cases', ['starter', 1, 'req-1']);
    await fails(rpc(P1, 'open_cases', ['starter', 1, 'req-1']), 'duplicate_request');
  });
  it('obeys the site switch and the responsible-gambling gate', async () => {
    await fund(P1, 5000);
    await sql(`update public.site_controls set games_off = '{cases}'`);
    await fails(rpc(P1, 'open_cases', ['starter', 1]), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
    await sql(`update public.account_controls set max_bet = 0.5 where user_id = $1`, [P1]);
    await fails(rpc(P1, 'open_cases', ['high', 1]), 'max_bet_exceeded');
    await sql(`update public.account_controls set max_bet = null, excluded_until = now() + interval '1 hour' where user_id = $1`, [P1]);
    await fails(rpc(P1, 'open_cases', ['starter', 1]), 'self_excluded');
    await sql(`update public.account_controls set excluded_until = null where user_id = $1`, [P1]);
    const big = CASES.find(c => c.price * 10 > 1000)!;
    await fails(rpc(P1, 'open_cases', [big.id, 10]), 'tier_cap_exceeded');
  });
});

describe('selling', () => {
  it('sells chosen items at their catalogue value, and everything with null', async () => {
    await fund(P2, 1000);
    await rpc(P2, 'open_cases', ['neon', 4]);
    const mine = await inv(P2), b0 = await balance(P2), first = mine[0]!;
    const r = await rpc(P2, 'sell_items', [[first.id]]);
    expect(r.sold).toBe(1); expect(Number(r.total)).toBe(ITEM[first.item_id]!.value); expect(await balance(P2)).toBeCloseTo(b0 + ITEM[first.item_id]!.value, 2);
    expect((await inv(P2)).length).toBe(mine.length - 1);
    const rest = (await inv(P2)).reduce((s, x) => s + ITEM[x.item_id]!.value, 0), b1 = await balance(P2);
    const all = await rpc(P2, 'sell_items', [null]);
    expect(Number(all.total)).toBeCloseTo(rest, 2); expect(await balance(P2)).toBeCloseTo(b1 + rest, 2); expect(await inv(P2)).toEqual([]);
    expect((await sql(`select kind from public.ledger where user_id = $1 order by id desc limit 1`, [P2]))[0]!.kind).toBe('sell');
  });
  it('refuses items that are not yours, already sold, or unknown, and changes nothing', async () => {
    await fund(P1, 1000); await rpc(P1, 'open_cases', ['neon', 1]);
    const theirs = (await inv(P1))[0]!, b0 = await balance(P2);
    await fails(rpc(P2, 'sell_items', [[theirs.id]]), 'item_not_found');
    await fails(rpc(P2, 'sell_items', [['99999999-9999-4999-8999-999999999999']]), 'item_not_found');
    await fails(rpc(P2, 'sell_items', [null]), 'item_not_found');                       // nothing to sell
    expect(await balance(P2)).toBe(b0); expect((await inv(P1)).length).toBeGreaterThan(0);
    const one = (await inv(P1))[0]!;
    await rpc(P1, 'sell_items', [[one.id]]);
    await fails(rpc(P1, 'sell_items', [[one.id]]), 'item_not_found');                   // cannot be sold twice
  });
  it('does not count a sale as a wager or as winnings', async () => {
    await fund(P1, 1000); await rpc(P1, 'open_cases', ['neon', 1]);
    const a = await rpc(P1, 'wallet_me'); await rpc(P1, 'sell_items', [null]); const b = await rpc(P1, 'wallet_me');
    expect(b.wagered).toBe(a.wagered); expect(b.won).toBe(a.won);
  });
});

describe('Upgrade', () => {
  const cheap = ITEMS.find(i => i.id === 'p1')!;     // 0.08
  it('uses the same chance as the browser and decides by the roll', async () => {
    await fund(P1, 1000);
    for (const [coins, target] of [[10, 'k1'], [3, 'r3'], [50, 'n4']] as const) {
      const r = await rpc(P1, 'upgrade_item', [[], coins, target, false]);
      expect(r.chance).toBeCloseTo(upgradeChance(coins, ITEM[target]!.value), 12);
      expect(r.win).toBe(r.roll < r.chance);
      expect(r.stake).toBe(coins);
    }
  });
  it('"over" wins above 1 - chance', async () => {
    await fund(P1, 1000);
    for (let i = 0; i < 6; i++) { const r = await rpc(P1, 'upgrade_item', [[], 40, 'k2', true]); expect(r.win).toBe(r.roll > 1 - r.chance); }
  });
  it('is recomputable from the revealed seed', async () => {
    await fund(P1, 1000);
    const r = await rpc(P1, 'upgrade_item', [[], 20, 'n4', false]);
    const seed = await reveal(P1);
    expect((await floatsFor(seed.server_seed, seed.client_seed, r.nonce, 1))[0]).toBe(r.roll);
  });
  it('consumes the staked items and coins, and gives the target on a win', async () => {
    await fund(P2, 1000); await sql(`delete from public.inventory where user_id = $1`, [P2]);
    for (let i = 0; i < 3; i++) await sql(`insert into public.inventory (user_id, item_id) values ($1, 'x44')`, [P2]);
    const ids = (await inv(P2)).map(x => x.id), stakeItems = ids.slice(0, 2);
    const b0 = await balance(P2), v = ITEM['x44']!.value;
    const r = await rpc(P2, 'upgrade_item', [stakeItems, 5, 'x29', false]);
    expect(r.stake).toBeCloseTo(v * 2 + 5, 2);
    expect(await balance(P2)).toBeCloseTo(b0 - 5, 2);
    const left = await inv(P2);
    expect(left.some(x => stakeItems.includes(x.id))).toBe(false);
    if (r.win) { expect(left.map(x => x.item_id).sort()).toEqual(['x29', 'x44']); expect(r.uid).toBeTruthy(); } else expect(left.map(x => x.item_id)).toEqual(['x44']);
    expect(r.from_item).toBe('x44');
    const bet = await lastBet(P2, 'upgrade'); expect(Number(bet.amount)).toBeCloseTo(v * 2 + 5, 2); expect(Number(bet.payout)).toBe(r.win ? ITEM['x29']!.value : 0);
  });
  it('stakes items alone (no coins, no gate, no wallet movement)', async () => {
    await fund(P2, 77); await sql(`delete from public.inventory where user_id = $1`, [P2]); await sql(`insert into public.inventory (user_id, item_id) values ($1, 'c2')`, [P2]);
    const id = (await inv(P2))[0]!.id;
    const r = await rpc(P2, 'upgrade_item', [[id], 0, 'k1', false]);
    expect(await balance(P2)).toBe(77); expect(r.balance).toBe(77);
  });
  it('refuses what is not allowed, changing nothing', async () => {
    await fund(P2, 100); await sql(`delete from public.inventory where user_id = $1`, [P2]);
    for (let i = 0; i < 5; i++) await sql(`insert into public.inventory (user_id, item_id) values ($1, 'p1')`, [P2]);
    const ids = (await inv(P2)).map(x => x.id), n0 = await nonceOf(P2);
    await fails(rpc(P2, 'upgrade_item', [ids, 0, 'k1', false]), 'too_many_items');            // 5 items
    await fails(rpc(P2, 'upgrade_item', [[], 0, 'k1', false]), 'invalid_amount');             // nothing staked
    await fails(rpc(P2, 'upgrade_item', [[], 10, 'nope', false]), 'unknown_item');
    await fails(rpc(P2, 'upgrade_item', [[], 10, 'p1', false]), 'target_too_low');            // target not worth more than the stake
    await fails(rpc(P2, 'upgrade_item', [[], 1000, 'x18', false]), 'insufficient_funds');
    await fails(rpc(P2, 'upgrade_item', [[], -1, 'k1', false]), 'invalid_amount');
    const theirs = (await inv(P1))[0] ?? (await (async () => { await sql(`insert into public.inventory (user_id, item_id) values ($1, 'p1')`, [P1]); return (await inv(P1))[0]!; })());
    await fails(rpc(P2, 'upgrade_item', [[theirs.id], 0, 'k1', false]), 'item_not_found');    // somebody else's item
    expect(await nonceOf(P2)).toBe(n0); expect(await balance(P2)).toBe(100); expect((await inv(P2)).length).toBe(5);
    void cheap;
  });
  it('respects the site switch', async () => {
    await sql(`update public.site_controls set games_off = '{upgrade}'`);
    await fails(rpc(P2, 'upgrade_item', [[], 5, 'k1', false]), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
  });
});

describe('Plinko', () => {
  it('has the same multiplier tables as the browser, for every rows and risk', async () => {
    for (const rows of [8, 10, 12, 14, 16]) for (const risk of ['low', 'normal', 'high'] as const) {
      const t = (await sql(`select public.plinko_table($1, $2) as t`, [rows, risk]))[0].t.map(Number) as number[];
      expect(t, `${rows} ${risk}`).toEqual(plinkoTable(rows, risk));
    }
  });
  it('drops a ball: path and bucket come from the seed, the payout is stake x multiplier', async () => {
    await fund(P1, 1000);
    const r = await rpc(P1, 'plinko_drop', [12, 'normal', 10]);
    expect(r.path).toHaveLength(12); expect(r.bucket).toBe(r.path.reduce((a: number, b: number) => a + b, 0));
    expect(r.mult).toBe(plinkoTable(12, 'normal')[r.bucket]);
    expect(Number(r.payout)).toBeCloseTo(10 * r.mult, 2);
    expect(await balance(P1)).toBeCloseTo(1000 - 10 + r.payout, 2); expect(r.balance).toBeCloseTo(await balance(P1), 2);
    const seed = await reveal(P1), fl = await floatsFor(seed.server_seed, seed.client_seed, r.nonce, 12);
    expect(r.path).toEqual(fl.map(f => (f >= 0.5 ? 1 : 0)));
    const bet = await lastBet(P1, 'plinko'); expect(Number(bet.amount)).toBe(10); expect(Number(bet.payout)).toBeCloseTo(r.payout, 2);
  });
  it('writes the stake and the win as separate ledger lines', async () => {
    await fund(P1, 1000);
    let r = await rpc(P1, 'plinko_drop', [8, 'high', 5]);
    for (let i = 0; i < 20 && Number(r.payout) === 0; i++) r = await rpc(P1, 'plinko_drop', [8, 'high', 5]);
    const led = await sql(`select kind, amount from public.ledger where user_id = $1 order by id desc limit 2`, [P1]);
    expect(led.map(x => x.kind)).toEqual(Number(r.payout) > 0 ? ['win', 'bet'] : ['bet', 'bet']);
  });
  it('validates rows, risk and amount, and obeys the site switch', async () => {
    await fund(P1, 1000);
    await fails(rpc(P1, 'plinko_drop', [11, 'normal', 1]), 'invalid_game');
    await fails(rpc(P1, 'plinko_drop', [12, 'wild', 1]), 'invalid_game');
    await fails(rpc(P1, 'plinko_drop', [12, 'normal', 0.05]), 'invalid_amount');
    await fails(rpc(P1, 'plinko_drop', [12, 'normal', 5000]), 'tier_cap_exceeded');
    await fund(P2, 1); await fails(rpc(P2, 'plinko_drop', [12, 'normal', 5]), 'insufficient_funds');
    await sql(`update public.site_controls set games_off = '{plinko}'`);
    await fails(rpc(P1, 'plinko_drop', [12, 'normal', 1]), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
  });
});

describe('Mines', () => {
  const bombsOf = async (game: number): Promise<number[]> => (await sql(`select bombs from public.mines_secrets where game_id = $1`, [game]))[0].bombs as number[];
  const reset = async (uid: string) => { await sql(`update public.mines_games set status = 'cancelled' where user_id = $1 and status = 'active'`, [uid]); };

  it('has the same multiplier and mine placement as the browser', async () => {
    for (const [n, mines, picks] of [[25, 3, 1], [25, 3, 5], [25, 10, 4], [16, 1, 8], [36, 5, 12], [64, 20, 6], [49, 7, 3]] as const) {
      const m = Number((await sql(`select public.mines_multiplier($1, $2, $3) as m`, [mines, picks, n]))[0].m);
      expect(m, `${n}/${mines}/${picks}`).toBe(minesMultiplier(mines, picks, n));
    }
    const floats = await floatsFor('ab'.repeat(32), 'cs', 4, 24);
    expect((await sql(`select public.mine_positions($1::float8[], 5, 25) as p`, [floats]))[0].p).toEqual(minePositions(floats, 5, 25));
  });
  it('plays a game: start, pick safe tiles, cash out', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [20, 25, 3]);
    expect(await balance(P1)).toBe(980); expect(s.balance).toBe(980);
    const bombs = await bombsOf(s.game), safe = [...Array(25).keys()].filter(i => !bombs.includes(i));
    const a = await rpc(P1, 'mines_pick', [s.game, safe[0]]);
    expect(a.bomb).toBe(false); expect(a.mult).toBe(minesMultiplier(3, 1, 25)); expect(a.next).toBe(minesMultiplier(3, 2, 25)); expect(a.picks).toEqual([safe[0]]);
    const b = await rpc(P1, 'mines_pick', [s.game, safe[1]]);
    expect(b.mult).toBe(minesMultiplier(3, 2, 25));
    const out = await rpc(P1, 'mines_cashout', [s.game]);
    expect(out.status).toBe('won'); expect(Number(out.payout)).toBeCloseTo(20 * minesMultiplier(3, 2, 25), 2);
    expect(out.bombs).toEqual([...bombs].sort((x, y) => x - y)); expect(await balance(P1)).toBeCloseTo(980 + out.payout, 2);
    const bet = await lastBet(P1, 'mines'); expect(Number(bet.amount)).toBe(20); expect(Number(bet.payout)).toBeCloseTo(out.payout, 2); expect(bet.result.outcome).toBe('won');
    await fails(rpc(P1, 'mines_cashout', [s.game]), 'game_over'); await fails(rpc(P1, 'mines_pick', [s.game, safe[2]]), 'game_over');
  });
  it('a bomb ends the game, reveals every bomb and pays nothing', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [10, 16, 4]), bombs = await bombsOf(s.game);
    const r = await rpc(P1, 'mines_pick', [s.game, bombs[0]]);
    expect(r.bomb).toBe(true); expect(r.status).toBe('lost'); expect(Number(r.payout)).toBe(0); expect(r.bombs.slice().sort((x: number, y: number) => x - y)).toEqual([...bombs].sort((x, y) => x - y));
    expect(await balance(P1)).toBe(990);
    expect((await lastBet(P1, 'mines')).result.outcome).toBe('lost');
  });
  it('cashes out by itself when every safe tile has been revealed', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [10, 16, 15]), bombs = await bombsOf(s.game);       // 16 tiles, 15 mines: one safe tile
    const safe = [...Array(16).keys()].find(i => !bombs.includes(i))!;
    const r = await rpc(P1, 'mines_pick', [s.game, safe]);
    expect(r.done).toBe(true); expect(r.status).toBe('won'); expect(Number(r.payout)).toBeCloseTo(10 * minesMultiplier(15, 1, 16), 2);
  });
  it('is recomputable: the bombs come from the seed', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [5, 25, 6]), bombs = await bombsOf(s.game);
    await rpc(P1, 'mines_cancel', [s.game]);
    const seed = await reveal(P1), fl = await floatsFor(seed.server_seed, seed.client_seed, s.nonce, 24);
    expect(bombs).toEqual(minePositions(fl, 6, 25));
  });
  it('refunds when cancelled before any tile, and refuses to cancel after one', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [10, 25, 3]);
    const c = await rpc(P1, 'mines_cancel', [s.game]);
    expect(c.status).toBe('cancelled'); expect(await balance(P1)).toBe(1000);
    const t = await rpc(P1, 'mines_start', [10, 25, 3]), bombs = await bombsOf(t.game), safe = [...Array(25).keys()].find(i => !bombs.includes(i))!;
    await rpc(P1, 'mines_pick', [t.game, safe]);
    await fails(rpc(P1, 'mines_cancel', [t.game]), 'has_picks');
    await rpc(P1, 'mines_cashout', [t.game]);
  });
  it('allows one game at a time, lets a reload resume it, and never shows the bombs', async () => {
    await fund(P1, 1000); await reset(P1);
    expect(await rpc(P1, 'mines_active')).toBeNull();
    const s = await rpc(P1, 'mines_start', [10, 25, 3]);
    await fails(rpc(P1, 'mines_start', [10, 25, 3]), 'game_in_progress');
    const bombs = await bombsOf(s.game), safe = [...Array(25).keys()].find(i => !bombs.includes(i))!;
    await rpc(P1, 'mines_pick', [s.game, safe]);
    const act = await rpc(P1, 'mines_active');
    expect(act.game).toBe(s.game); expect(act.picks).toEqual([safe]); expect(act.mult).toBe(minesMultiplier(3, 1, 25)); expect(JSON.stringify(act)).not.toContain('bombs');
    await rpc(P1, 'mines_cashout', [s.game]);
  });
  it('cannot be played by someone else, or with an invalid tile', async () => {
    await fund(P1, 1000); await fund(P2, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [10, 25, 3]);
    await fails(rpc(P2, 'mines_pick', [s.game, 0]), 'game_not_found'); await fails(rpc(P2, 'mines_cashout', [s.game]), 'game_not_found'); await fails(rpc(P2, 'mines_cancel', [s.game]), 'game_not_found');
    await fails(rpc(P1, 'mines_pick', [s.game, 25]), 'invalid_tile'); await fails(rpc(P1, 'mines_pick', [s.game, -1]), 'invalid_tile');
    await fails(rpc(P1, 'mines_cashout', [s.game]), 'no_picks');
    const bombs = await bombsOf(s.game), safe = [...Array(25).keys()].find(i => !bombs.includes(i))!;
    await rpc(P1, 'mines_pick', [s.game, safe]); await fails(rpc(P1, 'mines_pick', [s.game, safe]), 'invalid_tile');
    await rpc(P1, 'mines_cashout', [s.game]);
    await expect(q(P2, `select * from public.mines_secrets`)).rejects.toThrow('permission denied');
  });
  it('settles a game left open for a day: cashed out with picks, refunded without', async () => {
    await fund(P1, 1000); await reset(P1);
    const s = await rpc(P1, 'mines_start', [10, 25, 3]);
    await sql(`update public.mines_games set created_at = now() - interval '2 days' where id = $1`, [s.game]);
    expect(await rpc(P1, 'mines_active')).toBeNull(); expect(await balance(P1)).toBe(1000);
    const t = await rpc(P1, 'mines_start', [10, 25, 3]), bombs = await bombsOf(t.game), safe = [...Array(25).keys()].find(i => !bombs.includes(i))!;
    await rpc(P1, 'mines_pick', [t.game, safe]);
    await sql(`update public.mines_games set created_at = now() - interval '2 days' where id = $1`, [t.game]);
    await rpc(P1, 'mines_start', [1, 25, 3]);                                                    // starting again settles the stale one first
    expect(await balance(P1)).toBeCloseTo(1000 - 10 + 10 * minesMultiplier(3, 1, 25) - 1, 2);
    await reset(P1);
  });
  it('validates the setup and obeys the site switch', async () => {
    await fund(P1, 1000); await reset(P1);
    await fails(rpc(P1, 'mines_start', [10, 30, 3]), 'invalid_game'); await fails(rpc(P1, 'mines_start', [10, 25, 25]), 'invalid_game'); await fails(rpc(P1, 'mines_start', [10, 25, 0]), 'invalid_game');
    await fails(rpc(P1, 'mines_start', [0.05, 25, 3]), 'invalid_amount');
    await sql(`update public.site_controls set games_off = '{mines}'`);
    await fails(rpc(P1, 'mines_start', [10, 25, 3]), 'game_off');
    await sql(`update public.site_controls set games_off = '{}'`);
  });
});

describe('every bet the database makes can be re-checked in the browser', () => {
  it('Cases, Upgrade, Plinko and Mines recompute from the revealed seed with the verifier and the page\'s own result mapping', async () => {
    const { checkable } = await import('../src/server-bets.js');
    const { recompute } = await import('../src/verify.js');
    await fund(P1, 5000); await sql(`update public.mines_games set status = 'cancelled' where user_id = $1 and status = 'active'`, [P1]);
    await rotate(P1); const firstNew = Number((await sql('select coalesce(max(id), 0) as m from public.bets'))[0].m);                              // start a fresh seed so all bets below share it
    await rpc(P1, 'open_cases', ['neon', 2]);
    await rpc(P1, 'upgrade_item', [[], 30, 'k1', false]); await rpc(P1, 'upgrade_item', [[], 30, 'k1', true]);
    await rpc(P1, 'plinko_drop', [12, 'normal', 5]); await rpc(P1, 'plinko_drop', [8, 'high', 5]);
    const s = await rpc(P1, 'mines_start', [5, 25, 4]), bombs = (await sql(`select bombs from public.mines_secrets where game_id = $1`, [s.game]))[0].bombs as number[];
    await rpc(P1, 'mines_pick', [s.game, bombs[0]]);                                                         // lose on purpose: the bombs are then in the bet
    const seed = await reveal(P1);
    const rows = (await sql(`select id, game, amount, payout, multiplier, nonce, client_seed, server_hash, params, result, created_at from public.bets where user_id = $1 and id > $2 order by id`, [P1, firstNew]))
      .map(r => ({ ...r, amount: Number(r.amount), payout: Number(r.payout), multiplier: Number(r.multiplier) }));
    expect(rows.map(r => r.game)).toEqual(['cases', 'cases', 'upgrade', 'upgrade', 'plinko', 'plinko', 'mines']);
    for (const b of rows) {
      const chk = checkable(b)!;
      expect(chk, b.game).not.toBeNull();
      const again = await recompute(chk.game, chk.params, seed.server_seed, b.client_seed, b.nonce);
      expect(again?.key, `${b.game} #${b.id}`).toBe(chk.key);
    }
  });
  it('live games have no personal seed and are left to their own page', async () => {
    const { checkable } = await import('../src/server-bets.js');
    expect(checkable({ id: 1, game: 'coinflip', amount: 1, payout: 0, multiplier: 0, nonce: null, client_seed: null, server_hash: null, params: {}, result: {}, created_at: '' })).toBeNull();
  });
});
