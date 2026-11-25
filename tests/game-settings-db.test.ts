// @vitest-environment node
// Migration 0025: per-game stake limits, round betting windows, lobby expiry and caps, house bots and their names, simulated activity.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits', '0021_admin_control',
  '0023_rewards_admin', '0024_events'];
/** The live-game functions 0025 edits, stored with Windows (CR LF) line breaks the way the SQL editor keeps a file pasted from Windows. */
const PATCHED = ['create_live_battle', 'create_live_coinflip', 'call_live_bot', 'call_live_coinflip_bot'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, P1, P2].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
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
let defaults: any;
/** Saves the settings: the current ones with some fields changed. */
const save = (uid: string, over: Record<string, unknown> = {}, reason = 'tuning') => {
  const s = { ...defaults, ...over };
  return rpc(uid, 'admin_game_settings_save', [s.crash_bet_seconds, s.double_bet_seconds, s.lobby_minutes, s.battle_lobbies_max, s.flip_lobbies_max, s.bots_battles, s.bots_coinflip,
    s.simulated_activity, s.bot_names, JSON.stringify(over['limits'] ?? {}), reason]);
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  // the owner's database: these functions were pasted from Windows files (2026-11-25: the first run of 0025 failed on exactly this)
  for (const fn of PATCHED) {
    const def = (await sql(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]))[0].d as string;
    await db.exec(def.replace(/\r?\n/g, '\r\n'));
    expect((await sql(`select position(E'\\r' in prosrc) > 0 as crlf from pg_proc where proname = $1`, [fn]))[0].crlf).toBe(true);
  }
  await db.exec(readFileSync(new URL('../supabase/migrations/0025_game_settings.sql', import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [P1, 'Nova'], [P2, 'Orion']] as const) await play(id, 'complete_signup', [n, '2026-11-21', true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1)`, [OWNER, MOD]);
  for (const id of [OWNER, MOD]) await unlock(id);
  for (const id of [P1, P2]) await sql(`select public.wallet_credit($1, 5000, 'bonus')`, [id]);
  defaults = await rpc(null, 'game_settings_public', [], 'aal1');
}, 180_000);
afterAll(async () => { await db.close(); });

describe('settings', () => {
  it('start with the values the game always had, readable by anyone', () => {
    expect(defaults).toMatchObject({ crash_bet_seconds: 7, double_bet_seconds: 12, lobby_minutes: 30, battle_lobbies_max: 3, flip_lobbies_max: 5, bots_battles: true, bots_coinflip: true, simulated_activity: true });
    expect(defaults.bot_names).toHaveLength(20);
    expect(defaults.limits.plinko).toEqual({ min: 0.01, max: 50000 });
  });
  it('only staff with config.edit may change them, with a reason, inside safe ranges', async () => {
    await fails(save(MOD), 'admin_denied');
    await fails(save(OWNER, {}, ''), 'reason_required');
    await fails(save(OWNER, { crash_bet_seconds: 3 }), 'invalid_value');
    await fails(save(OWNER, { lobby_minutes: 500 }), 'invalid_value');
    await fails(save(OWNER, { bot_names: ['a', 'b'] }), 'invalid_bot_names');
    await fails(save(OWNER, { bot_names: [...defaults.bot_names, 'Nova'] }), 'bot_name_taken');            // a new bot name may not be a player's name
    await fails(save(OWNER, { limits: { plinko: { min: 10, max: 5 } } }), 'invalid_value');
    await fails(save(OWNER, { limits: { poker: { min: 1, max: 5 } } }), 'unknown_game');
    expect((await save(OWNER)).crash_bet_seconds).toBe(7);                                                  // the defaults themselves save fine (Mirage was a bot name already)
  });
});

describe('what the settings change', () => {
  it('a stake outside the game\'s limits is refused; other games are not affected', async () => {
    await save(OWNER, { limits: { plinko: { min: 1, max: 20 } } });
    await fails(play(P1, 'plinko_drop', [12, 'normal', 0.5]), 'bet_below_min');
    await fails(play(P1, 'plinko_drop', [12, 'normal', 25]), 'bet_above_max');
    await play(P1, 'plinko_drop', [12, 'normal', 10]);
    await play(P1, 'create_live_coinflip', ['bolt', 25]);                                                 // coinflip keeps its own limits
    await save(OWNER, { limits: { plinko: { min: 0.01, max: 50000 } } });
  });
  it('Crash takes bets for the configured number of seconds', async () => {
    await save(OWNER, { crash_bet_seconds: 15 });
    await sql(`update public.game_rounds set status = 'finished', finished_at = now() - interval '1 hour', result = '{"point": 1.5}' where game = 'crash' and status <> 'finished'`);
    const r = (await sql(`select extract(epoch from (betting_ends_at - created_at)) as s from public.advance_round_internal('crash')`))[0];
    expect(Math.round(Number(r.s))).toBe(15);
  });
  it('the number of open lobbies per player follows the setting', async () => {
    await save(OWNER, { flip_lobbies_max: 2 });
    await play(P2, 'create_live_coinflip', ['bolt', 1]);
    await play(P2, 'create_live_coinflip', ['star', 1]);
    await fails(play(P2, 'create_live_coinflip', ['bolt', 1]), 'too_many_open');
  });
  it('waiting lobbies are cancelled and refunded after the configured minutes', async () => {
    await save(OWNER, { lobby_minutes: 5, flip_lobbies_max: 5 });
    const before = await balance(P2);
    await sql(`update public.live_coinflips set created_at = now() - interval '6 minutes' where creator = $1 and status = 'waiting'`, [P2]);
    await sql(`select public.live_reap()`);
    expect(await balance(P2)).toBe(before + 2);
  });
  it('house bots can be switched off per game, and only listed names are accepted', async () => {
    const f = await play(P1, 'create_live_coinflip', ['star', 2]);
    await fails(play(P1, 'call_live_coinflip_bot', [f.id, 'not_a_bot']), 'invalid_name');
    await save(OWNER, { bots_coinflip: false });
    await fails(play(P1, 'call_live_coinflip_bot', [f.id, defaults.bot_names[0]]), 'bots_off');
    await save(OWNER, { bots_coinflip: true });
    expect((await play(P1, 'call_live_coinflip_bot', [f.id, defaults.bot_names[0]])).status).toBe('done');
    const b = await play(P1, 'create_live_battle', [['starter'], '1v1', 'normal']);
    await save(OWNER, { bots_battles: false });
    await fails(play(P1, 'call_live_bot', [b.id, 1, defaults.bot_names[1]]), 'bots_off');
    await save(OWNER);
  });
  it('every change is logged with the values before and after; the file can be run again', async () => {
    const log = (await sql(`select before, after from public.admin_audit_log where action = 'config.games' order by id desc limit 1`))[0];
    expect(log.before.bots_battles).toBe(false); expect(log.after.bots_battles).toBe(true);
    await db.exec(readFileSync(new URL('../supabase/migrations/0025_game_settings.sql', import.meta.url), 'utf8'));
    expect(await rpc(null, 'game_settings_public', [], 'aal1')).toMatchObject({ crash_bet_seconds: 7, bots_battles: true });
    await fails(play(P1, 'create_live_coinflip', ['bolt', 0.05]), '');                                     // still guarded after the second run
  });
});
