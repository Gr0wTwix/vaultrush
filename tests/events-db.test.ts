// @vitest-environment node
// Migration 0024: staff races, coin rain and giveaways. Who may do what, how standings and payouts are counted, and that a giveaway draw can be
// checked by anyone from the revealed seed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const P = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'] as const;
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits', '0021_admin_control',
  '0023_rewards_admin', '0024_events'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, ...P].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
`;
async function as<T>(uid: string | null, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false), set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, aal })}', false), set_config('request.headers', '{}', false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const rpc = (uid: string | null, fn: string, args: unknown[] = [], aal: 'aal1' | 'aal2' = 'aal2'): Promise<any> =>
  as(uid, aal, async () => ((await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args)).rows[0] as { v: any }).v);
const play = (uid: string, fn: string, args: unknown[] = []): Promise<any> => rpc(uid, fn, args, 'aal1');
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const fails = async (p: Promise<unknown>, msg: string) => { await expect(p).rejects.toThrow(msg); };
const unlock = async (uid: string): Promise<void> => {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
};
const balance = async (uid: string): Promise<number> => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);
const iso = (ms: number): string => new Date(Date.now() + ms).toISOString();
const H = 3_600_000;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [P[0], 'Nova'], [P[1], 'Orion'], [P[2], 'Lyra'], [P[3], 'Pax']] as const) await play(id, 'complete_signup', [n, '2026-11-21', true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1)`, [OWNER, MOD]);
  for (const id of [OWNER, MOD]) await unlock(id);
  for (const id of P) await sql(`select public.wallet_credit($1, 1000, 'bonus')`, [id]);
}, 180_000);
afterAll(async () => { await db.close(); });

describe('races', () => {
  let raceId = 0;
  it('only race managers create races; the window, prizes and games are checked', async () => {
    await fails(rpc(MOD, 'admin_race_save', [null, 'Weekend race', iso(-H), iso(H), [100, 50], [], 'event']), 'admin_denied');
    await fails(rpc(OWNER, 'admin_race_save', [null, 'Weekend race', iso(H), iso(-H), [100], [], 'event']), 'invalid_dates');
    await fails(rpc(OWNER, 'admin_race_save', [null, 'Weekend race', iso(-H), iso(H), [], [], 'event']), 'invalid_value');
    await fails(rpc(OWNER, 'admin_race_save', [null, 'Weekend race', iso(-H), iso(H), [100], ['poker'], 'event']), 'unknown_game');
    const r = await rpc(OWNER, 'admin_race_save', [null, 'Plinko sprint', iso(-H), iso(H), [100, 50], ['plinko'], 'event']);
    expect(r).toMatchObject({ name: 'Plinko sprint', state: 'running', pool: 150 });
    raceId = r.id;
  });
  it('ranks players by what they wagered on the counted games inside the window', async () => {
    await play(P[0], 'plinko_drop', [12, 'normal', 30]);
    await play(P[1], 'plinko_drop', [12, 'normal', 50]);
    await play(P[2], 'plinko_drop', [12, 'normal', 10]);
    await play(P[2], 'open_cases', ['starter', 3, 'x1']).catch(() => null);           // another game does not count (if the case exists here)
    const pub = (await play(P[0], 'races_public')).find((x: any) => x.id === raceId);
    expect(pub.top.map((t: any) => [t.name, t.wagered, t.prize])).toEqual([['Orion', 50, 100], ['Nova', 30, 50], ['Lyra', 10, 0]]);
    expect(pub.me).toEqual({ rank: 2, wagered: 30 });
    await fails(rpc(OWNER, 'admin_race_pay', [raceId, 'too early']), 'race_not_ended');
  });
  it('pays an ended race once, to the ranked players with a prize', async () => {
    await sql(`update public.bets set created_at = created_at - interval '1 minute'`);                         // the bets were placed during the race
    await sql(`update public.races set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 second' where id = $1`, [raceId]);
    const before = [await balance(P[0]), await balance(P[1]), await balance(P[2])];
    expect(await rpc(OWNER, 'admin_race_pay', [raceId, 'well played'])).toEqual({ winners: 2, paid: 150 });
    expect([await balance(P[0]), await balance(P[1]), await balance(P[2])]).toEqual([before[0]! + 50, before[1]! + 100, before[2]]);
    await fails(rpc(OWNER, 'admin_race_pay', [raceId, 'again']), 'race_not_ended');
    await fails(rpc(OWNER, 'admin_race_cancel', [raceId, 'too late']), 'race_closed');
    const row = (await rpc(OWNER, 'admin_races')).find((x: any) => x.id === raceId);
    expect(row.state).toBe('paid'); expect(row.payouts.map((p: any) => p.name)).toEqual(['Orion', 'Nova']);
  });
  it('a cancelled race disappears from the site', async () => {
    const r = await rpc(OWNER, 'admin_race_save', [null, 'Cancelled one', iso(H), iso(2 * H), [10], [], 'event']);
    await rpc(OWNER, 'admin_race_cancel', [r.id, 'mistake']);
    expect((await rpc(null, 'races_public', [], 'aal1')).map((x: any) => x.id)).not.toContain(r.id);
  });
});

describe('coin rain', () => {
  let rainId = 0;
  it('only rain managers start a rain, one at a time, announced in the chat', async () => {
    await fails(rpc(MOD, 'admin_rain_start', [30, 60, 0, 'party']), 'admin_denied');
    await fails(rpc(OWNER, 'admin_rain_start', [30, 5, 0, 'party']), 'invalid_value');
    rainId = (await rpc(OWNER, 'admin_rain_start', [30, 60, 0, 'party'])).id;
    await fails(rpc(OWNER, 'admin_rain_start', [10, 60, 0, 'another']), 'rain_active');
    const line = (await sql(`select body, is_staff from public.chat_messages order by id desc limit 1`))[0];
    expect(line.is_staff).toBe(true); expect(line.body).toMatch(/Coin rain: 30 coins! .* 60 seconds/);
  });
  it('players join once; the minimum level is enforced', async () => {
    for (const p of [P[0], P[1], P[3]]) expect((await play(p, 'join_rain', [rainId])).joined).toBe(true);
    expect((await play(P[0], 'join_rain', [rainId])).joiners).toBe(3);                  // joining twice changes nothing
    const now = await play(P[0], 'rain_now');
    expect(now.open).toMatchObject({ id: rainId, pot: 30, joiners: 3, joined: true });
    expect((await play(P[2], 'rain_now')).open.joined).toBe(false);
  });
  it('when time is up, the pot is split equally and paid; late joiners are refused', async () => {
    const before = await balance(P[0]);
    await sql(`update public.rains set starts_at = now() - interval '2 minutes', ends_at = now() - interval '1 second' where id = $1`, [rainId]);
    await fails(play(P[2], 'join_rain', [rainId]), 'rain_closed');
    const now = await play(P[0], 'rain_now');
    expect(now.open).toBeNull();
    expect(now.last).toMatchObject({ id: rainId, joiners: 3, share: 10, mine: true });
    expect(await balance(P[0])).toBe(before + 10);
    expect((await play(P[2], 'rain_now')).last.mine).toBe(false);
    expect((await sql(`select count(*)::int as n from public.ledger where kind = 'rain'`))[0].n).toBe(3);
  });
  it('a level requirement keeps low-level players out; a cancelled rain pays nobody', async () => {
    const r = (await rpc(OWNER, 'admin_rain_start', [100, 60, 50, 'high rollers'])).id;
    await fails(play(P[3], 'join_rain', [r]), 'level_too_low');
    await rpc(OWNER, 'admin_rain_cancel', [r, 'oops']);
    await fails(play(P[0], 'join_rain', [r]), 'rain_closed');
    expect((await play(P[0], 'rain_now')).open).toBeNull();
  });
});

describe('giveaways', () => {
  let gid = 0, hash = '';
  it('creating one publishes only the hash of its secret seed', async () => {
    await fails(rpc(MOD, 'admin_giveaway_create', ['Big giveaway', 100, 2, 0, null, iso(H), 'event']), 'admin_denied');
    gid = (await rpc(OWNER, 'admin_giveaway_create', ['Big giveaway', 100, 2, 0, null, iso(H), 'event'])).id;
    const pub = (await rpc(null, 'giveaways_public', [], 'aal1')).find((g: any) => g.id === gid);
    expect(pub).toMatchObject({ state: 'open', winners: 2, entries: 0, seed: null, drawn: null });
    expect(pub.server_hash).toMatch(/^[0-9a-f]{64}$/);
    hash = pub.server_hash;
  });
  it('players enter once each, in order; it cannot be drawn before it ends', async () => {
    for (const p of P) await play(p, 'enter_giveaway', [gid]);
    await play(P[0], 'enter_giveaway', [gid]);
    const mine = (await play(P[0], 'giveaways_public')).find((g: any) => g.id === gid);
    expect(mine).toMatchObject({ entries: 4, entered: true });
    expect(await rpc(null, 'giveaway_entries_public', [gid], 'aal1')).toEqual([]);      // the list is shown only after the draw
    await fails(rpc(OWNER, 'admin_giveaway_draw', [gid, 'too early']), 'giveaway_not_ended');
  });
  it('the draw pays the winners and reveals a seed that anyone can check', async () => {
    await sql(`update public.giveaways set ends_at = now() - interval '1 second', starts_at = now() - interval '1 hour' where id = $1`, [gid]);
    await fails(play(P[0], 'enter_giveaway', [gid]), 'giveaway_closed');
    const before = await Promise.all(P.map(balance));
    const d = await rpc(OWNER, 'admin_giveaway_draw', [gid, 'draw time']);
    expect(d.winners).toBe(2);
    const pub = (await rpc(null, 'giveaways_public', [], 'aal1')).find((g: any) => g.id === gid);
    expect(createHash('sha256').update(pub.seed).digest('hex')).toBe(hash);               // the revealed seed is the one committed to
    const entries = await rpc(null, 'giveaway_entries_public', [gid], 'aal1');
    const expected = [...entries].sort((a: any, b: any) => { const ha = createHash('sha256').update(`${pub.seed}:${a.entry_no}`).digest('hex'), hb = createHash('sha256').update(`${pub.seed}:${b.entry_no}`).digest('hex'); return ha < hb ? -1 : ha > hb ? 1 : a.entry_no - b.entry_no; }).slice(0, 2);
    expect(pub.drawn.map((w: any) => w.entry_no)).toEqual(expected.map((e: any) => e.entry_no));
    const after = await Promise.all(P.map(balance));
    expect(after.reduce((s, v, i) => s + v - before[i]!, 0)).toBe(200);
    await fails(rpc(OWNER, 'admin_giveaway_draw', [gid, 'again']), 'giveaway_not_ended');
    await fails(rpc(OWNER, 'admin_giveaway_cancel', [gid, 'late']), 'giveaway_closed');
  });
  it('the minimum level applies to entries; stats count rain and giveaway coins', async () => {
    const g = (await rpc(OWNER, 'admin_giveaway_create', ['VIP giveaway', 50, 1, 60, null, iso(H), 'vip'])).id;
    await fails(play(P[3], 'enter_giveaway', [g]), 'level_too_low');
    const kinds = (await rpc(OWNER, 'admin_reward_stats')).kinds.map((k: any) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(['rain', 'giveaway', 'race']));
  });
  it('can be run a second time without changing anything', async () => {
    const before = (await sql(`select count(*)::int as n from public.giveaways`))[0].n;
    await db.exec(readFileSync(new URL('../supabase/migrations/0024_events.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.giveaways`))[0].n).toBe(before);
  });
});
