// @vitest-environment node
// Migration 0023: reward settings (faucet, rakeback, calendar, race prizes) read by the reward functions, promo codes managed by staff, and announcements.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const READER = '44444444-4444-4444-4444-444444444444';
const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits', '0021_admin_control', '0023_rewards_admin'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, READER, P1, P2].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
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
const DEFAULTS = [25, 10, 0.004, 0.003, 0.003, [1, 2, 3, 5, 8, 12, 25], [400, 200, 120, 80, 60, 50, 35, 25, 20, 10]];
const saveSettings = (uid: string, over: Partial<Record<number, unknown>> = {}, reason = 'tuning the rewards') =>
  rpc(uid, 'admin_reward_settings_save', [...DEFAULTS.map((v, i) => (i in over ? over[i] : v)), reason]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [READER, 'Reed'], [P1, 'Nova'], [P2, 'Orion']] as const) await play(id, 'complete_signup', [n, '2026-11-21', true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1), ($3, 'readonly', $1)`, [OWNER, MOD, READER]);
  for (const id of [OWNER, MOD, READER]) await unlock(id);
}, 180_000);
afterAll(async () => { await db.close(); });

describe('reward settings', () => {
  it('start with the numbers the game always used, and anyone can read them', async () => {
    const s = await rpc(null, 'reward_settings_public', [], 'aal1');
    expect(s).toMatchObject({ faucet_amount: 25, faucet_minutes: 10, rakeback: { instant: 0.004, daily: 0.003, weekly: 0.003 }, calendar: [1, 2, 3, 5, 8, 12, 25] });
    expect(s.race_prizes).toHaveLength(10);
  });
  it('only staff with rewards.edit may change them, with a reason, inside safe limits', async () => {
    await fails(saveSettings(MOD), 'admin_denied');
    await fails(saveSettings(OWNER, {}, ''), 'reason_required');
    await fails(saveSettings(OWNER, { 0: 0 }), 'invalid_value');
    await fails(saveSettings(OWNER, { 1: 0 }), 'invalid_value');
    await fails(saveSettings(OWNER, { 2: 0.03, 3: 0.02, 4: 0.01 }), 'rakeback_too_high');
    await fails(saveSettings(OWNER, { 5: [1, 2, 3] }), 'invalid_value');
    await fails(saveSettings(OWNER, { 6: [] }), 'invalid_value');
    expect(await rpc(READER, 'admin_reward_settings')).toMatchObject({ faucet_amount: 25 });
  });
  it('the faucet pays the new amount on the new timer', async () => {
    await saveSettings(OWNER, { 0: 40, 1: 30 });
    const r = await play(P1, 'claim_faucet');
    expect(r).toMatchObject({ claimed: true, amount: 40 });
    expect(await balance(P1)).toBe(40);
    await sql(`update public.player_rewards set faucet_at = now() - interval '20 minutes' where user_id = $1`, [P1]);
    expect((await play(P1, 'claim_faucet')).claimed).toBe(false);                 // 30 minutes now, not 10
    await sql(`update public.player_rewards set faucet_at = now() - interval '31 minutes' where user_id = $1`, [P1]);
    expect((await play(P1, 'claim_faucet')).claimed).toBe(true);
    const log = (await sql(`select before, after from public.admin_audit_log where action = 'rewards.settings' order by id desc limit 1`))[0];
    expect(log.before.faucet_amount).toBe(25); expect(log.after.faucet_amount).toBe(40);
  });
  it('rakeback and the calendar follow the settings', async () => {
    await saveSettings(OWNER, { 2: 0.01, 3: 0, 4: 0, 5: [9, 2, 3, 5, 8, 12, 25] });
    await play(P1, 'plinko_drop', [12, 'normal', 10]);
    const pr = (await sql(`select rb_instant, rb_daily from public.player_rewards where user_id = $1`, [P1]))[0];
    expect(Number(pr.rb_instant)).toBeCloseTo(0.1, 4); expect(Number(pr.rb_daily)).toBe(0);
    expect(await play(P2, 'claim_calendar')).toMatchObject({ day: 1, amount: 9 });
  });
  it('the race pays the configured prize for the rank, and nothing past the last prize', async () => {
    await saveSettings(OWNER, { 6: [777, 5] });
    await sql(`select public.wallet_credit($1, 500, 'bonus')`, [P2]);
    await play(P2, 'plinko_drop', [12, 'normal', 100]);
    await sql(`update public.bets set created_at = now() - interval '1 day' where user_id in ($1, $2)`, [P1, P2]);
    expect(await play(P2, 'claim_race_prize')).toMatchObject({ paid: true, rank: 1, prize: 777 });
    expect(await play(P1, 'claim_race_prize')).toMatchObject({ paid: true, rank: 2, prize: 5 });
    await saveSettings(OWNER);                                                    // back to the defaults for the other tests
  });
});

describe('promo codes', () => {
  it('staff create a code that players can redeem once, up to its limit', async () => {
    await fails(rpc(MOD, 'admin_promo_save', ['SPRING', 5, null, null, true, null, 'campaign']), 'admin_denied');
    await fails(rpc(OWNER, 'admin_promo_save', ['no spaces!', 5, null, null, true, null, 'campaign']), 'invalid_code_format');
    await fails(rpc(OWNER, 'admin_promo_save', ['SPRING', 0, null, null, true, null, 'campaign']), 'invalid_value');
    const c = await rpc(OWNER, 'admin_promo_save', ['spring', 5, 1, null, true, 'for the newsletter', 'campaign']);
    expect(c).toMatchObject({ code: 'SPRING', amount: 5, max_uses: 1, note: 'for the newsletter' });
    expect(await play(P1, 'redeem_promo', ['spring'])).toMatchObject({ code: 'SPRING', amount: 5 });
    await fails(play(P2, 'redeem_promo', ['SPRING']), 'code_used_up');
    expect((await rpc(READER, 'admin_promo_users', ['spring'])).map((u: any) => u.name)).toEqual(['Nova']);
    const row = (await rpc(READER, 'admin_promos')).find((p: any) => p.code === 'SPRING');
    expect(row).toMatchObject({ uses: 1, live: false, by: 'Mirage' });
  });
  it('switching a code off or letting it expire makes it answer like a wrong code; the code itself cannot be renamed', async () => {
    await rpc(OWNER, 'admin_promo_save', ['AUTUMN', 3, null, null, true, null, 'campaign']);
    await rpc(OWNER, 'admin_promo_save', ['AUTUMN', 3, null, null, false, null, 'over']);
    expect(await play(P2, 'redeem_promo', ['AUTUMN'])).toEqual({ error: 'invalid_code' });
    await rpc(OWNER, 'admin_promo_save', ['AUTUMN', 3, null, new Date(Date.now() - 60_000).toISOString(), true, null, 'expired']);
    expect(await play(P2, 'redeem_promo', ['AUTUMN'])).toEqual({ error: 'invalid_code' });
    await rpc(OWNER, 'admin_promo_save', ['AUTUMN', 4, null, new Date(Date.now() + 86_400_000).toISOString(), true, null, 'back on']);
    expect(await play(P2, 'redeem_promo', ['AUTUMN'])).toMatchObject({ amount: 4 });
    expect((await sql(`select count(*)::int as n from public.admin_audit_log where action like 'promo.%'`))[0].n).toBeGreaterThanOrEqual(5);
  });
  it('the stats show what the free rewards handed out', async () => {
    const s = await rpc(READER, 'admin_reward_stats');
    const promo = s.kinds.find((k: any) => k.kind === 'promo');
    expect(promo.today_count).toBeGreaterThanOrEqual(2);
    expect(s.kinds.map((k: any) => k.kind)).toEqual(expect.arrayContaining(['faucet', 'calendar', 'promo', 'race']));
  });
});

describe('announcements', () => {
  it('a banner shows in the site status for everyone until it ends; a scheduled one waits for its start', async () => {
    await fails(rpc(READER, 'admin_announce', ['banner', 'info', 'Hello', null, null, 'news']), 'admin_denied');
    await fails(rpc(MOD, 'admin_announce', ['banner', 'info', '', null, null, 'news']), 'text_required');
    await fails(rpc(MOD, 'admin_announce', ['banner', 'info', 'x', null, new Date(Date.now() - 1000).toISOString(), 'news']), 'invalid_dates');
    const a = await rpc(MOD, 'admin_announce', ['banner', 'win', 'Double XP weekend!', null, null, 'event']);
    const later = await rpc(MOD, 'admin_announce', ['popup', 'info', 'Maintenance tonight', new Date(Date.now() + 3_600_000).toISOString(), null, 'heads-up']);
    const st = await rpc(null, 'site_status', [], 'aal1');
    expect(st.announcements).toEqual([{ id: a.id, kind: 'banner', style: 'win', body: 'Double XP weekend!' }]);
    const list = await rpc(MOD, 'admin_announcements');
    expect(list.find((x: any) => x.id === later.id).state).toBe('scheduled');
    await rpc(MOD, 'admin_announce_end', [a.id, 'event over']);
    expect((await rpc(null, 'site_status', [], 'aal1')).announcements).toEqual([]);
    expect((await rpc(MOD, 'admin_announcements')).find((x: any) => x.id === a.id).state).toBe('ended');
  });
  it('the site status keeps everything it had before', async () => {
    const st = await rpc(P1, 'site_status', [], 'aal1');
    expect(Object.keys(st).sort()).toEqual(['announcements', 'country', 'country_blocked', 'games_off', 'maintenance', 'maintenance_message', 'notice', 'signups_open', 'staff']);
  });
  it('can be run a second time without changing anything', async () => {
    const before = await rpc(null, 'reward_settings_public', [], 'aal1');
    await db.exec(readFileSync(new URL('../supabase/migrations/0023_rewards_admin.sql', import.meta.url), 'utf8'));
    expect(await rpc(null, 'reward_settings_public', [], 'aal1')).toEqual(before);
  });
});
