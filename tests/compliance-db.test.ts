// @vitest-environment node
// Migration 0026: verification requests decided by staff, and the responsible-play console (staff can only make things safer for a player).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const COMP = '44444444-4444-4444-4444-444444444444';
const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits', '0021_admin_control',
  '0023_rewards_admin', '0024_events', '0025_game_settings', '0026_compliance'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, COMP, P1, P2].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
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
const ctl = async (uid: string) => (await sql(`select * from public.account_controls where user_id = $1`, [uid]))[0];

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [COMP, 'Reed'], [P1, 'Nova'], [P2, 'Orion']] as const) await play(id, 'complete_signup', [n, '2026-11-21', true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1), ($3, 'compliance', $1)`, [OWNER, MOD, COMP]);
  for (const id of [OWNER, MOD, COMP]) await unlock(id);
  for (const id of [P1, P2]) await sql(`select public.wallet_credit($1, 50000, 'bonus')`, [id]);
}, 180_000);
afterAll(async () => { await db.close(); });

describe('verification requests', () => {
  it('a player asks for a higher level once at a time, and can withdraw', async () => {
    expect(await play(P1, 'my_verification')).toEqual({ tier: 0, request: null });
    await fails(play(P1, 'request_verification', [0, '']), 'invalid_tier');
    await fails(play(P1, 'request_verification', [3, '']), 'invalid_tier');
    expect((await play(P1, 'request_verification', [1, 'I play big battles'])).request).toMatchObject({ tier: 1, status: 'pending' });
    await fails(play(P1, 'request_verification', [2, '']), 'request_pending');
    expect((await play(P1, 'withdraw_verification')).request.status).toBe('withdrawn');
    await play(P1, 'request_verification', [2, 'second try']);
  });
  it('the queue is for compliance staff; moderators do not see it', async () => {
    await fails(rpc(MOD, 'admin_kyc_queue', ['pending']), 'admin_denied');
    const q = await rpc(COMP, 'admin_kyc_queue', ['pending']);
    expect(q).toEqual([expect.objectContaining({ name: 'Nova', tier: 2, current_tier: 0, note: 'second try' })]);
  });
  it('approving raises the level, so bigger stakes pass the verification cap', async () => {
    await fails(play(P1, 'plinko_drop', [12, 'normal', 20000]), 'tier_cap_exceeded');
    const id = (await rpc(COMP, 'admin_kyc_queue', ['pending']))[0].id;
    await fails(rpc(MOD, 'admin_kyc_decide', [id, true, 'ok']), 'admin_denied');
    await rpc(COMP, 'admin_kyc_decide', [id, true, 'looks fine']);
    expect(await play(P1, 'my_verification')).toMatchObject({ tier: 2, request: { status: 'approved', note: 'looks fine' } });
    await play(P1, 'plinko_drop', [12, 'normal', 20000]);
    await fails(rpc(COMP, 'admin_kyc_decide', [id, false, 'again']), 'request_closed');
  });
  it('declining leaves the level alone; staff can also set a level directly, up or down', async () => {
    await play(P2, 'request_verification', [1, '']);
    const id = (await rpc(COMP, 'admin_kyc_queue', ['pending']))[0].id;
    await rpc(COMP, 'admin_kyc_decide', [id, false, 'too new']);
    expect((await play(P2, 'my_verification')).tier).toBe(0);
    await rpc(COMP, 'admin_kyc_set_tier', [P1, 1, 'correction']);
    expect((await ctl(P1)).kyc_tier).toBe(1);
    const log = (await sql(`select before, after from public.admin_audit_log where action = 'kyc.set_tier' order by id desc limit 1`))[0];
    expect(log).toEqual({ before: { tier: 2 }, after: { tier: 1 } });
  });
});

describe('responsible-play console', () => {
  it('shows breaks, exclusions, waiting loosenings, and the biggest losers and busiest players', async () => {
    await play(P2, 'request_limit_change', ['loss_daily', 100]);
    await play(P2, 'request_limit_change', ['loss_daily', 500]);                 // a loosening: waits 24 hours
    await play(P2, 'plinko_drop', [12, 'normal', 50]);
    const o = await rpc(COMP, 'admin_rg_overview');
    expect(o.pending).toEqual([expect.objectContaining({ name: 'Orion', key: 'loss_daily', value: 500 })]);
    expect(o.busy_today.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Nova', 'Orion']));
    await fails(rpc(MOD, 'admin_rg_overview'), 'admin_denied');
  });
  it('staff can start and extend a break or an exclusion, never shorten it', async () => {
    await fails(rpc(MOD, 'admin_rg_apply', [P2, 'cool_off', 24, 'worried']), 'admin_denied');
    const a = await rpc(COMP, 'admin_rg_apply', [P2, 'cool_off', 48, 'asked by support']);
    const b = await rpc(COMP, 'admin_rg_apply', [P2, 'cool_off', 1, 'shorter?']);
    expect(Date.parse(b.until)).toBe(Date.parse(a.until));                        // the longer break stays
    await fails(play(P2, 'plinko_drop', [12, 'normal', 5]), 'cool_off');
    await rpc(COMP, 'admin_rg_apply', [P2, 'exclude', 30, 'player asked by e-mail']);
    expect((await rpc(COMP, 'admin_rg_overview')).excluded.map((x: any) => x.name)).toEqual(['Orion']);
  });
  it('a limit can only be tightened; tightening cancels a loosening that was waiting', async () => {
    await fails(rpc(COMP, 'admin_rg_apply', [P2, 'loss_daily', 200, 'looser']), 'not_tighter');
    await rpc(COMP, 'admin_rg_apply', [P2, 'loss_daily', 40, 'heavy losses']);
    expect(Number((await ctl(P2)).loss_daily)).toBe(40);
    expect((await sql(`select count(*)::int as n from public.limit_changes where user_id = $1`, [P2]))[0].n).toBe(0);
    await rpc(COMP, 'admin_rg_apply', [P1, 'max_bet', 500, 'no limit set before']);
    expect(Number((await ctl(P1)).max_bet)).toBe(500);
    await fails(rpc(COMP, 'admin_rg_apply', [P1, 'time_daily_min', 2000, 'x y z']), 'invalid_limit');
    await fails(rpc(COMP, 'admin_rg_apply', [COMP, 'cool_off', 5, 'myself']), 'not_allowed_self');
  });
  it('can be run a second time without changing anything', async () => {
    const before = (await sql(`select count(*)::int as n from public.kyc_requests`))[0].n;
    await db.exec(readFileSync(new URL('../supabase/migrations/0026_compliance.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.kyc_requests`))[0].n).toBe(before);
  });
});
