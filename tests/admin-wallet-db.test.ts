// @vitest-environment node
// Migration 0019: the admin wallet tools. Who may look (ledger.view) and who may change coins (wallet.adjust, the Owner only by default), what the viewers
// report, and the adjustment itself: audited with a reason and the balances, a real ledger row, never below zero, never a wager or a win, and safe to repeat.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const MOD = '33333333-3333-3333-3333-333333333333';
const READER = '44444444-4444-4444-4444-444444444444';
const P1 = '55555555-5555-5555-5555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const GONE = '77777777-7777-4777-8777-777777777777';
const PW = 'Correct-Horse-Battery-9';
const TERMS = '2026-11-21';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet'];
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
  insert into auth.users (id, email) values ${[OWNER, ADMIN, MOD, READER, P1, P2, GONE].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
`;
async function as<T>(uid: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal })}', false), set_config('request.headers', '{}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, args: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<any> =>
  as(uid, aal, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const fails = async (p: Promise<unknown>, msg: string) => { await expect(p).rejects.toThrow(msg); };
const unlock = async (uid: string): Promise<void> => {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
};
const balance = async (uid: string): Promise<number> => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);
const auditCount = async (): Promise<number> => Number((await sql(`select count(*) as n from public.admin_audit_log where action = 'wallet.adjust'`))[0].n);
const ledgerCount = async (uid: string): Promise<number> => Number((await sql(`select count(*) as n from public.ledger where user_id = $1`, [uid]))[0].n);
const key = (): string => crypto.randomUUID();
const adjust = (uid: string, user: string, amount: number | null, reason = 'test adjustment', k: string = key()): Promise<any> => rpc(uid, 'admin_wallet_adjust', [user, amount, reason, k]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [ADMIN, 'Kai'], [MOD, 'Vexx'], [READER, 'Reed'], [P1, 'Nova'], [P2, 'Orion'], [GONE, 'Ghost']] as const) await rpc(id, 'complete_signup', [n, TERMS, true], 'aal1');
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'admin', $1), ($3, 'moderator', $1), ($4, 'readonly', $1)`, [OWNER, ADMIN, MOD, READER]);
  for (const id of [OWNER, ADMIN, MOD, READER]) await unlock(id);
  // two players with real money history: a bonus, then Plinko bets (every coin goes through the ledger)
  await sql(`select public.wallet_credit($1, 1000, 'bonus')`, [P1]);
  await sql(`select public.wallet_credit($1, 300, 'bonus')`, [P2]);
  for (const amt of [50, 100, 25]) await rpc(P1, 'plinko_drop', [12, 'normal', amt], 'aal1');
  await sql(`insert into public.inventory (user_id, item_id, source) select $1, id, 'test' from public.catalog_items order by value desc limit 2`, [P1]);
  await rpc(GONE, 'delete_account', [], 'aal1');
}, 180_000);
afterAll(async () => { await db.close(); });

describe('who may look and who may change coins', () => {
  const LOOK: [string, unknown[]][] = [['admin_wallet_totals', []], ['admin_wallet_search', ['no']], ['admin_wallet_overview', [P1]], ['admin_wallet_ledger', [P1]], ['admin_wallet_bets', [P1]]];

  it('players and staff without ledger.view see nothing', async () => {
    for (const [fn, args] of LOOK) { await fails(rpc(P1, fn, args), 'admin_denied'); await fails(rpc(MOD, fn, args), 'admin_denied'); }
    await fails(rpc(P1, 'admin_wallet_adjust', [P2, 5, 'free coins', key()]), 'admin_denied');
  });
  it('the three-step sign-in is needed: no two-factor session and no unlocked session are both refused, and signed-out callers cannot even call', async () => {
    await fails(rpc(ADMIN, 'admin_wallet_totals', [], 'aal1'), 'admin_mfa_required');
    await fails(rpc(ADMIN, 'admin_wallet_adjust', [P2, 5, 'free coins', key()], 'aal1'), 'admin_mfa_required');
    await rpc(READER, 'admin_lock');
    await fails(rpc(READER, 'admin_wallet_totals'), 'admin_session_required');
    await unlock(READER);
    await fails(rpc(null, 'admin_wallet_totals'), 'permission denied');
  });
  it('an admin and a read-only staff member can look, but only the Owner can adjust, until the Owner switches it on for the admin role', async () => {
    for (const who of [ADMIN, READER]) for (const [fn, args] of LOOK) await rpc(who, fn, args);
    await fails(adjust(ADMIN, P2, 5), 'admin_denied');
    await fails(adjust(READER, P2, 5), 'admin_denied');
    await rpc(OWNER, 'admin_set_permission', ['admin', 'wallet.adjust', true, 'trusted admin']);
    expect((await adjust(ADMIN, P2, 5, 'admin may now')).balance_after).toBe(305);
    await rpc(OWNER, 'admin_set_permission', ['admin', 'wallet.adjust', false, 'back to owner only']);
    await fails(adjust(ADMIN, P2, 5), 'admin_denied');
    await adjust(OWNER, P2, -5, 'undo the test credit');
    expect(await balance(P2)).toBe(300);
  });
});

describe('the viewers', () => {
  it('totals add up the whole economy', async () => {
    const t = await rpc(OWNER, 'admin_wallet_totals');
    const sum = Number((await sql(`select sum(balance) as s from public.wallets`))[0].s);
    expect(t.coins_in_wallets).toBe(sum);
    expect(t.wallets).toBe(7); expect(t.wallets_with_coins).toBeGreaterThanOrEqual(2);
    expect(t.bets_today.count).toBe(3); expect(t.bets_today.staked).toBe(175);
    expect(t.bets_7d.count).toBe(3);
    expect(Math.abs(t.now - Date.now())).toBeLessThan(60_000);
  });

  it('search finds players by part of the name, richest first, never closed accounts, and ignores wildcards', async () => {
    expect((await rpc(OWNER, 'admin_wallet_search', ['o'])) as any[]).toEqual([]);                  // too short
    const nova = await rpc(OWNER, 'admin_wallet_search', ['nov']);
    expect(nova.map((p: any) => p.name)).toEqual(['Nova']);
    expect(nova[0].balance).toBe(await balance(P1));
    const both = await rpc(OWNER, 'admin_wallet_search', ['or']);                                  // Orion, Mirage and others contain "or"
    expect(both.map((p: any) => p.name)).toContain('Orion');
    const balances = both.map((p: any) => p.balance);
    expect([...balances].sort((a, b) => b - a)).toEqual(balances);
    expect(await rpc(OWNER, 'admin_wallet_search', ['Ghost'])).toEqual([]);                        // closed
    expect(await rpc(OWNER, 'admin_wallet_search', ['%%'])).toEqual([]);                           // wildcards are stripped, so nothing is left to search for
  });

  it('a player\'s wallet: balance, what the ledger adds up to, coins by kind, bets, inventory, and the limits for those who may see them', async () => {
    const o = await rpc(OWNER, 'admin_wallet_overview', [P1]);
    expect(o.player).toMatchObject({ id: P1, name: 'Nova', closed: false, staff_role: null });
    expect(o.wallet.balance).toBe(await balance(P1)); expect(o.wallet.wagered).toBe(175);
    expect(o.ledger.difference).toBe(0);                                                           // every coin of this account went through the ledger
    expect(o.ledger.sum).toBe(o.wallet.balance);
    const kinds = Object.fromEntries(o.ledger.by_kind.map((k: any) => [k.kind, k]));
    expect(kinds.bonus).toMatchObject({ count: 1, sum: 1000 }); expect(kinds.bet).toMatchObject({ count: 3, sum: -175 });
    expect(o.bets).toMatchObject({ count: 3, staked: 175 });
    expect(o.inventory.items).toBe(2); expect(o.inventory.value).toBeGreaterThan(0);
    expect(o.responsible.limits).toEqual({ max_bet: null, loss_daily: null, loss_weekly: null, loss_monthly: null, wager_daily: null, time_daily_min: null });
    expect(o.responsible.usage.staked_today).toBe(175); expect(o.responsible.kyc_tier).toBe(0);
    // a staff member who may see wallets but not responsible-play data does not get the limits
    await rpc(OWNER, 'admin_set_permission', ['readonly', 'rg.view', false, 'test']);
    expect((await rpc(READER, 'admin_wallet_overview', [P1])).responsible).toBeNull();
    await rpc(OWNER, 'admin_set_permission', ['readonly', 'rg.view', true, 'test over']);
    expect((await rpc(READER, 'admin_wallet_overview', [P1])).responsible).not.toBeNull();
    expect((await rpc(OWNER, 'admin_wallet_overview', [OWNER])).player.staff_role).toBe('owner');
  });

  it('shows a balance that the ledger does not explain (older balances) as a difference', async () => {
    await sql(`update public.wallets set balance = balance + 5 where user_id = $1`, [P2]);
    expect((await rpc(OWNER, 'admin_wallet_overview', [P2])).ledger.difference).toBe(5);
    await sql(`update public.wallets set balance = balance - 5 where user_id = $1`, [P2]);
  });

  it('refuses an unknown player and a closed account has no wallet to show', async () => {
    await fails(rpc(OWNER, 'admin_wallet_overview', ['99999999-9999-4999-8999-999999999999']), 'player_not_found');
  });

  it('the ledger and the bets come newest first, in pages', async () => {
    const all = await rpc(OWNER, 'admin_wallet_ledger', [P1, null, 50]);
    expect(all.length).toBeGreaterThanOrEqual(7);                                                  // a bonus, three stakes and the wins that came back
    expect(all.map((r: any) => r.id)).toEqual([...all.map((r: any) => r.id)].sort((a: number, b: number) => b - a));
    const page1 = await rpc(OWNER, 'admin_wallet_ledger', [P1, null, 3]);
    const page2 = await rpc(OWNER, 'admin_wallet_ledger', [P1, page1[2].id, 3]);
    expect(page1).toHaveLength(3);
    expect([...page1, ...page2].map((r: any) => r.id)).toEqual(all.slice(0, 6).map((r: any) => r.id));
    expect(all.at(-1)).toMatchObject({ kind: 'bonus', amount: 1000 });
    expect(await rpc(OWNER, 'admin_wallet_ledger', [P1, null, 100000])).toHaveLength(all.length);   // a huge limit is clamped, not an error
    const bets = await rpc(OWNER, 'admin_wallet_bets', [P1, null, 2]);
    expect(bets).toHaveLength(2); expect(bets[0].id).toBeGreaterThan(bets[1].id);
    expect(bets.map((b: any) => b.game)).toEqual(['plinko', 'plinko']);
    const rest = await rpc(OWNER, 'admin_wallet_bets', [P1, bets[1].id, 50]);
    expect(rest).toHaveLength(1); expect(rest[0].amount).toBe(50);
    expect(await rpc(OWNER, 'admin_wallet_bets', [P2])).toEqual([]);
  });
});

describe('adjusting coins', () => {
  it('a credit changes the balance, writes an adjustment row the player can see, and is not a wager or a win', async () => {
    const before = await balance(P2), wallet = (await sql(`select wagered, won from public.wallets where user_id = $1`, [P2]))[0], rows = await ledgerCount(P2);
    const logs = await auditCount();
    const r = await adjust(OWNER, P2, 250.5, 'compensation for the lost game');
    expect(r).toMatchObject({ user_id: P2, amount: 250.5, balance_before: before, balance_after: before + 250.5, replayed: false });
    expect(await balance(P2)).toBe(before + 250.5);
    expect(await ledgerCount(P2)).toBe(rows + 1);
    const led = (await sql(`select * from public.ledger where id = $1`, [r.ledger_id]))[0];
    expect(led).toMatchObject({ user_id: P2, kind: 'adjustment' }); expect(Number(led.amount)).toBe(250.5); expect(Number(led.balance_after)).toBe(before + 250.5);
    const after = (await sql(`select wagered, won from public.wallets where user_id = $1`, [P2]))[0];
    expect(after).toEqual(wallet);                                                                 // not a wager, not a win
    expect(await auditCount()).toBe(logs + 1);
    const log = (await sql(`select * from public.admin_audit_log where action = 'wallet.adjust' order by id desc limit 1`))[0];
    expect(log).toMatchObject({ actor: OWNER, actor_role: 'owner', target_type: 'player', target_id: P2, reason: 'compensation for the lost game' });
    expect(log.before).toEqual({ balance: before }); expect(log.after).toEqual({ balance: before + 250.5 });
    expect(log.meta).toMatchObject({ amount: 250.5, balance_before: before, balance_after: before + 250.5, ledger_id: r.ledger_id });
    // the player sees it in their own account data
    const mine = await rpc(P2, 'wallet_me', [false], 'aal1');
    expect(mine.balance).toBe(before + 250.5);
    expect((await rpc(P2, 'my_limits', [], 'aal1')).usage.staked_today).toBe(0);                    // and it is not counted as a stake
    await adjust(OWNER, P2, -250.5, 'put it back');
  });

  it('a debit lowers the balance but can never take it below zero, and a refused debit changes nothing', async () => {
    const start = await balance(P2);
    expect((await adjust(OWNER, P2, -start / 2, 'wrongly credited bonus')).balance_after).toBe(start / 2);
    const rows = await ledgerCount(P2), logs = await auditCount(), bal = await balance(P2);
    await fails(adjust(OWNER, P2, -(bal + 0.01), 'too much'), 'debit_exceeds_balance');
    expect(await balance(P2)).toBe(bal); expect(await ledgerCount(P2)).toBe(rows); expect(await auditCount()).toBe(logs);
    expect((await adjust(OWNER, P2, -bal, 'take the rest')).balance_after).toBe(0);               // exactly to zero is fine
    await adjust(OWNER, P2, start, 'restore');
    expect(await balance(P2)).toBe(start);
  });

  it('needs a reason, a sensible amount, an open account and a key', async () => {
    const bal = await balance(P1), logs = await auditCount();
    await fails(adjust(OWNER, P1, 10, 'no'), 'reason_required');
    await fails(adjust(OWNER, P1, 10, '   '), 'reason_required');
    for (const bad of [0, 0.001, 12.345, 10_000_000.01, -10_000_000.01, null]) await fails(adjust(OWNER, P1, bad), 'adjust_amount_invalid');
    await fails(rpc(OWNER, 'admin_wallet_adjust', [P1, 10, 'test adjustment', null]), 'invalid_value');
    await fails(adjust(OWNER, GONE, 10), 'player_not_found');
    await fails(adjust(OWNER, '99999999-9999-4999-8999-999999999999', 10), 'player_not_found');
    expect(await balance(P1)).toBe(bal); expect(await auditCount()).toBe(logs);
    expect((await adjust(OWNER, P1, 10_000_000, 'a very large gift')).balance_after).toBe(bal + 10_000_000);        // the largest allowed
    await adjust(OWNER, P1, -10_000_000, 'take it back');
    expect(await balance(P1)).toBe(bal);
  });

  it('the same key twice pays once and returns the first answer; the same key for something else is refused', async () => {
    const k = key(), bal = await balance(P1), logs = await auditCount(), rows = await ledgerCount(P1);
    const first = await adjust(OWNER, P1, 40, 'double click', k);
    const again = await adjust(OWNER, P1, 40, 'double click', k);
    expect(again).toMatchObject({ amount: 40, balance_before: bal, balance_after: bal + 40, replayed: true });
    expect(first.replayed).toBe(false);
    expect(await balance(P1)).toBe(bal + 40); expect(await auditCount()).toBe(logs + 1); expect(await ledgerCount(P1)).toBe(rows + 1);
    await fails(adjust(OWNER, P1, 41, 'double click', k), 'key_reused');
    await fails(adjust(OWNER, P2, 40, 'double click', k), 'key_reused');
    expect(await balance(P1)).toBe(bal + 40);
    await adjust(OWNER, P1, -40, 'undo');
  });

  it('the wallet viewer shows the adjustment straight away', async () => {
    await adjust(OWNER, P2, 7, 'visible in the viewer');
    const top = (await rpc(OWNER, 'admin_wallet_ledger', [P2, null, 1]))[0];
    expect(top).toMatchObject({ kind: 'adjustment', amount: 7 });
    expect((await rpc(OWNER, 'admin_wallet_totals')).adjustments_30d.count).toBeGreaterThanOrEqual(1);
    await adjust(OWNER, P2, -7, 'undo');
  });
});

describe('the migration', () => {
  it('can be run a second time without changing anything', async () => {
    const before = await balance(P1), logs = await auditCount();
    await db.exec(readFileSync(new URL('../supabase/migrations/0019_admin_wallet.sql', import.meta.url), 'utf8'));
    expect(await balance(P1)).toBe(before); expect(await auditCount()).toBe(logs);
    await rpc(OWNER, 'admin_wallet_totals');
  });
});
