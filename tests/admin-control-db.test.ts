// @vitest-environment node
// Migration 0021: admin step B (dashboard, players, account actions, chat moderation, live rooms, rounds) and the player-side rules it adds.
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
const P3 = '77777777-7777-4777-8777-777777777777';
const P4 = '88888888-8888-4888-8888-888888888888';
const PW = 'Correct-Horse-Battery-9';
const TERMS = '2026-11-21';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits', '0021_admin_control'];
let db: PGlite;

const PRELUDE = `
  create schema extensions; create schema auth;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, banned_until timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb default '{}');
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
  insert into auth.users (id, email, raw_app_meta_data) values ${[OWNER, MOD, READER, P1, P2, P3, P4].map((id, i) => `('${id}', 'u${i}@example.com', '{"provider":"steam"}')`).join(', ')};
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
const chat = (uid: string, body: string) => as(uid, 'aal1', () => db.query(`insert into public.chat_messages (body) values ($1)`, [body]));
const quiet = (uid: string) => sql(`update public.chat_messages set created_at = created_at - interval '10 minutes' where user_id = $1`, [uid]);    // past the rate limits
const balance = async (uid: string): Promise<number> => Number((await sql(`select balance from public.wallets where user_id = $1`, [uid]))[0].balance);
const unlock = async (uid: string): Promise<void> => {
  if (!(await rpc(uid, 'admin_status')).password_set) expect((await rpc(uid, 'admin_set_password', [PW])).ok).toBe(true);
  expect((await rpc(uid, 'admin_unlock', [PW])).ok).toBe(true);
};
const lastAudit = async (action: string) => (await sql(`select * from public.admin_audit_log where action = $1 order by id desc limit 1`, [action]))[0];

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [READER, 'Reed'], [P1, 'Nova'], [P2, 'Orion'], [P3, 'Lyra'], [P4, 'Pax']] as const) await play(id, 'complete_signup', [n, TERMS, true]);
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1), ($3, 'readonly', $1)`, [OWNER, MOD, READER]);
  for (const id of [OWNER, MOD, READER]) await unlock(id);
  for (const id of [P1, P2, P3, P4]) await sql(`select public.wallet_credit($1, 1000, 'bonus')`, [id]);
  await sql(`insert into auth.sessions (user_id) values ($1), ($1), ($2)`, [P2, P3]);
}, 180_000);
afterAll(async () => { await db.close(); });

describe('the migration', () => {
  it('can be run a second time without changing anything', async () => {
    const before = (await sql(`select count(*)::int as n from public.chat_settings`))[0].n;
    await db.exec(readFileSync(new URL('../supabase/migrations/0021_admin_control.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.chat_settings`))[0].n).toBe(before);
  });
});

describe('dashboard and players', () => {
  it('the dashboard needs dashboard.view: players are refused, read-only staff may look', async () => {
    await fails(play(P1, 'admin_dashboard'), 'admin_denied');
    const d = await rpc(READER, 'admin_dashboard');
    expect(d.players.total).toBe(7);
    expect(d.signups_7d).toHaveLength(7);
    expect(d.bets_24h).toHaveLength(24);
    expect(d.rooms).toMatchObject({ battles_waiting: 0, coinflips_waiting: 0 });
  });
  it('lists players by name, by id and by status, and shows one profile', async () => {
    expect((await rpc(MOD, 'admin_players', ['ov'])).map((p: any) => p.name)).toEqual(['Nova']);
    expect((await rpc(MOD, 'admin_players', [P2])).map((p: any) => p.name)).toEqual(['Orion']);
    expect((await rpc(MOD, 'admin_players', ['', 'staff'])).length).toBe(3);
    const p = await rpc(MOD, 'admin_player', [P1]);
    expect(p.player).toMatchObject({ name: 'Nova', closed: false, staff_role: null });
    expect(p.player.sign_in.provider).toBe('steam');
    expect(p.wallet).toBeNull();                                               // a moderator has no ledger.view
    expect((await rpc(OWNER, 'admin_player', [P1])).wallet.balance).toBe(1000);
  });
  it('notes and tags are kept per player and logged; read-only staff cannot write them', async () => {
    await rpc(MOD, 'admin_player_note', [P1, 'Asked about the daily race']);
    expect(await rpc(MOD, 'admin_player_tag', [P1, 'watch', true])).toEqual(['watch']);
    await fails(rpc(READER, 'admin_player_note', [P1, 'x']), 'admin_denied');
    await fails(rpc(MOD, 'admin_player_tag', [P1, 'king', true]), 'invalid_value');
    const p = await rpc(OWNER, 'admin_player', [P1]);
    expect(p.notes[0]).toMatchObject({ body: 'Asked about the daily race', author: 'Vexx' });
    expect(p.tags).toEqual(['watch']);
    expect((await rpc(MOD, 'admin_players', ['', 'tag:watch'])).map((x: any) => x.name)).toEqual(['Nova']);
  });
});

describe('account actions', () => {
  it('a moderator may mute and warn but not ban; nobody may act on themselves or on a higher rank', async () => {
    await fails(rpc(MOD, 'admin_flag_player', [P1, 'bet_ban', 60, '', 'spam']), 'admin_denied');
    await fails(rpc(MOD, 'admin_flag_player', [MOD, 'mute', 10, '', 'test']), 'not_allowed_self');
    await fails(rpc(MOD, 'admin_flag_player', [OWNER, 'mute', 10, '', 'test']), 'rank_too_low');
    await fails(rpc(MOD, 'admin_flag_player', [P1, 'mute', 10, '', '']), 'reason_required');
    await fails(rpc(MOD, 'admin_flag_player', [P1, 'warn', null, '', 'rude']), 'text_required');
  });
  it('a mute stops chat until it ends; staff are never muted', async () => {
    await rpc(MOD, 'admin_flag_player', [P1, 'mute', 30, '', 'flooding']);
    await fails(chat(P1, 'hello'), 'chat_muted');
    await chat(MOD, 'staff can talk'); await quiet(MOD);
    await sql(`update public.account_flags set until = now() - interval '1 second' where user_id = $1 and kind = 'mute'`, [P1]);
    await chat(P1, 'free again'); await quiet(P1);
    expect((await lastAudit('account.mute')).reason).toBe('flooding');
  });
  it('a warning is shown once to the player, then marked read', async () => {
    const w = await rpc(MOD, 'admin_flag_player', [P1, 'warn', null, 'Please keep the chat friendly.', 'insults']);
    const n = await play(P1, 'my_notices');
    expect(n).toEqual([expect.objectContaining({ id: w.id, message: 'Please keep the chat friendly.' })]);
    expect(await play(P2, 'my_notices')).toEqual([]);                          // nobody else sees it
    await play(P2, 'ack_notice', [w.id]);                                       // and nobody else can mark it read
    expect(await play(P1, 'my_notices')).toHaveLength(1);
    await play(P1, 'ack_notice', [w.id]);
    expect(await play(P1, 'my_notices')).toEqual([]);
  });
  it('a betting ban refuses games but not chat or rewards; lifting it restores play', async () => {
    const b = await rpc(OWNER, 'admin_flag_player', [P2, 'bet_ban', null, '', 'chargeback suspicion']);
    await fails(play(P2, 'create_live_coinflip', ['bolt', 10]), 'betting_banned');
    await fails(play(P2, 'plinko_drop', [12, 'normal', 5]), 'betting_banned');
    await chat(P2, 'still allowed to talk'); await quiet(P2);
    expect((await rpc(OWNER, 'admin_players', ['', 'banned'])).map((p: any) => p.name)).toEqual(['Orion']);
    await rpc(OWNER, 'admin_lift_flag', [b.id, 'checked, all fine']);
    await play(P2, 'plinko_drop', [12, 'normal', 5]);
  });
  it('a site ban refuses games, rewards and chat, ends the sign-in and blocks new ones; lifting it lets them back in', async () => {
    const b = await rpc(OWNER, 'admin_flag_player', [P3, 'site_ban', 60, '', 'botting']);
    expect(b.signed_out).toBe(true);
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [P3]))[0].n).toBe(0);
    expect((await sql(`select banned_until from auth.users where id = $1`, [P3]))[0].banned_until).not.toBeNull();
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [P2]))[0].n).toBe(2);       // nobody else is signed out
    await fails(play(P3, 'plinko_drop', [12, 'normal', 5]), 'account_banned');
    await fails(play(P3, 'claim_free', ['welcome']), 'account_banned');
    await fails(chat(P3, 'hi'), 'chat_muted');
    await rpc(OWNER, 'admin_lift_flag', [b.id, 'appeal accepted']);
    expect((await sql(`select banned_until from auth.users where id = $1`, [P3]))[0].banned_until).toBeNull();
    await play(P3, 'plinko_drop', [12, 'normal', 5]);
  });
  it('force sign-out ends every session of that player only', async () => {
    await sql(`insert into auth.sessions (user_id) values ($1), ($2)`, [P4, P1]);
    expect((await rpc(OWNER, 'admin_sign_out', [P4, 'lost phone'])).signed_out).toBe(true);
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [P4]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from auth.sessions where user_id = $1`, [P1]))[0].n).toBe(1);
    await fails(rpc(READER, 'admin_sign_out', [P4, 'x y z']), 'admin_denied');
  });
  it('rename follows the sign-up rules and is logged with the old name', async () => {
    await fails(rpc(OWNER, 'admin_rename', [P4, 'a', 'bad name']), 'invalid_name');
    await fails(rpc(OWNER, 'admin_rename', [P4, 'Nova', 'bad name']), 'name_taken');
    expect((await rpc(OWNER, 'admin_rename', [P4, 'Paxton', 'offensive name'])).name).toBe('Paxton');
    expect((await lastAudit('account.rename')).before).toEqual({ name: 'Pax' });
  });
  it('a free claim can be reset so the player may take it again', async () => {
    await play(P4, 'claim_free', ['welcome']);
    expect((await play(P4, 'claim_free', ['welcome'])).claimed).toBe(false);
    await rpc(OWNER, 'admin_reset_claim', [P4, 'welcome', 'crate failed to open']);
    expect((await play(P4, 'claim_free', ['welcome'])).claimed).toBe(true);
  });
  it('closing an account needs its name typed again, never closes staff, and anonymises it like a self-closure', async () => {
    await fails(rpc(OWNER, 'admin_close_account', [P4, 'Pax', 'requested by e-mail']), 'confirm_mismatch');
    await fails(rpc(OWNER, 'admin_close_account', [MOD, 'Vexx', 'test']), 'staff_account');
    const r = await rpc(OWNER, 'admin_close_account', [P4, 'Paxton', 'requested by e-mail']);
    expect(r.name).toMatch(/^deleted-/);
    expect(await balance(P4)).toBe(0);
    expect((await sql(`select deleted_at from public.profiles where id = $1`, [P4]))[0].deleted_at).not.toBeNull();
    expect((await sql(`select banned_until from auth.users where id = $1`, [P4]))[0].banned_until).not.toBeNull();
    await fails(rpc(OWNER, 'admin_flag_player', [P4, 'mute', 5, '', 'closed']), 'player_not_found');
  });
});

describe('chat moderation', () => {
  it('removing a message hides its text for everyone, closes its reports and keeps the original in the audit log', async () => {
    await chat(P1, 'buy coins at my site'); await quiet(P1);
    const id = (await sql(`select id from public.chat_messages where user_id = $1 order by id desc limit 1`, [P1]))[0].id;
    expect((await play(P2, 'report_chat', [id, 'spam'])).reported).toBe(true);
    await play(P2, 'report_chat', [id, 'spam again']);                          // a second report from the same player changes nothing
    expect(await rpc(MOD, 'admin_chat_reports', [true])).toHaveLength(1);
    await rpc(MOD, 'admin_chat_remove', [id, 'advertising']);
    const m = (await sql(`select body, removed_at from public.chat_messages where id = $1`, [id]))[0];
    expect(m.body).toBe('removed'); expect(m.removed_at).not.toBeNull();
    expect(await rpc(MOD, 'admin_chat_reports', [true])).toHaveLength(0);
    expect((await lastAudit('chat.remove')).before.body).toBe('buy coins at my site');
    await fails(play(P2, 'report_chat', [id, '']), 'message_not_found');
  });
  it('players cannot mark their own message as staff or removed', async () => {
    await expect(as(P1, 'aal1', () => db.query(`insert into public.chat_messages (body, is_staff) values ('i am staff', true)`))).rejects.toThrow(/permission denied/);
  });
  it('lock, slow mode, links and blocked words apply to players and not to staff', async () => {
    await fails(rpc(READER, 'admin_chat_settings', [0, true, true, [], 'x y z']), 'admin_denied');
    await rpc(MOD, 'admin_chat_settings', [0, true, true, [], 'raid']);
    await fails(chat(P1, 'hello?'), 'chat_locked');
    await chat(MOD, 'room locked for a minute'); await quiet(MOD);
    await rpc(MOD, 'admin_chat_settings', [30, false, false, ['Scam', ' scam ', ''], 'calm down']);
    expect((await rpc(MOD, 'admin_chat', [])).settings.blocked_words).toEqual(['scam']);
    await fails(chat(P1, 'free skins at www.example.com'), 'chat_no_links');
    await fails(chat(P1, 'this is a SCAM'), 'chat_blocked_word');
    await chat(P1, 'ok, sorry');
    await sql(`update public.chat_messages set created_at = created_at - interval '5 seconds' where user_id = $1`, [P1]);       // past the 2-second limit, inside slow mode
    await fails(chat(P1, 'again'), 'chat_slow');
    await quiet(P1);
    await rpc(MOD, 'admin_chat_settings', [0, false, true, [], 'back to normal']);
    await chat(P1, 'see www.example.com'); await quiet(P1);
  });
  it('staff messages carry a badge, can be pinned, and every player sees the pin', async () => {
    const { id } = await rpc(MOD, 'admin_chat_post', ['Welcome! Be nice.']); await quiet(MOD);
    expect((await sql(`select is_staff from public.chat_messages where id = $1`, [id]))[0].is_staff).toBe(true);
    await rpc(MOD, 'admin_chat_pin', [id, 'rules']);
    expect((await play(P1, 'chat_status')).pinned).toMatchObject({ body: 'Welcome! Be nice.', is_staff: true });
    await rpc(MOD, 'admin_chat_pin', [null, 'old']);
    expect((await play(P1, 'chat_status')).pinned).toBeNull();
  });
  it('clear removes every recent message at once', async () => {
    await chat(P2, 'one'); await quiet(P2); await chat(P3, 'two');
    await sql(`update public.chat_messages set created_at = now() - interval '1 minute' where user_id in ($1, $2) and removed_at is null`, [P2, P3]);
    expect((await rpc(MOD, 'admin_chat_clear', [5, 'raid'])).removed).toBeGreaterThanOrEqual(2);
    expect((await sql(`select count(*)::int as n from public.chat_messages where removed_at is null and created_at > now() - interval '5 minutes'`))[0].n).toBe(0);
  });
});

describe('live rooms', () => {
  it('lists coinflips and cancels a waiting one with a refund; finished ones cannot be cancelled', async () => {
    const before = await balance(P1);
    const f = await play(P1, 'create_live_coinflip', ['bolt', 40]);
    expect(await balance(P1)).toBe(before - 40);
    const list = await rpc(READER, 'admin_rooms', ['coinflips', 'waiting']);
    expect(list.map((x: any) => x.id)).toContain(f.id);
    expect(list[0].seed).toBeNull();                                           // the seed stays secret until the flip is done
    await fails(rpc(READER, 'admin_room_cancel', ['coinflip', String(f.id), 'stuck']), 'admin_denied');
    expect((await rpc(MOD, 'admin_room_cancel', ['coinflip', String(f.id), 'stuck lobby'])).refunded).toBe(1);
    expect(await balance(P1)).toBe(before);
    await fails(rpc(MOD, 'admin_room_cancel', ['coinflip', String(f.id), 'again']), 'flip_not_open');
    await fails(rpc(MOD, 'admin_room_cancel', ['coinflip', 'abc', 'bad id']), 'invalid_value');
  });
  it('cancels a waiting battle and refunds every player in it', async () => {
    const before = await balance(P1);
    const b = await play(P1, 'create_live_battle', [['starter'], '1v1', 'normal']);
    const cost = before - await balance(P1);
    expect(cost).toBeGreaterThan(0);
    expect((await rpc(MOD, 'admin_room_cancel', ['battle', b.id, 'test lobby'])).refunded).toBe(1);
    expect(await balance(P1)).toBe(before);
    expect((await sql(`select status from public.live_battles where id = $1`, [b.id]))[0].status).toBe('cancelled');
  });
  it('marks a game suspicious or void as a record only, with the right permission', async () => {
    const f = await play(P1, 'create_live_coinflip', ['star', 5]);
    const bal = await balance(P1);
    await rpc(MOD, 'admin_room_flag', ['coinflip', String(f.id), 'suspicious', 'same two players again']);
    await fails(rpc(MOD, 'admin_room_flag', ['coinflip', String(f.id), 'void', 'x y z']), 'admin_denied');       // void needs rooms.void
    await rpc(OWNER, 'admin_room_flag', ['coinflip', String(f.id), 'void', 'collusion confirmed']);
    expect(await balance(P1)).toBe(bal);                                       // no coins move
    const row = (await rpc(MOD, 'admin_rooms', ['coinflips'])).find((x: any) => x.id === f.id);
    expect(row.flags.map((x: any) => x.flag).sort()).toEqual(['suspicious', 'void']);
  });
});

describe('rounds', () => {
  let finished = 0;
  beforeAll(async () => {
    const r = (await sql(`select (public.advance_round_internal('crash')).id as id`))[0];
    await sql(`update public.game_rounds set created_at = now() - interval '2 hours', betting_ends_at = now() - interval '2 hours' where id = $1`, [r.id]);
    await sql(`select public.advance_round_internal('crash')`);              // starts it
    await sql(`select public.advance_round_internal('crash')`);              // and it has long crashed
    finished = r.id;
  });
  it('a finished round shows its seed and checks out; the round in play keeps its seed secret', async () => {
    const list = await rpc(READER, 'admin_rounds', ['crash']);
    const done = list.find((x: any) => x.id === finished);
    expect(done.status).toBe('finished'); expect(done.seed).toMatch(/^[0-9a-f]{64}$/);
    for (const r of list.filter((x: any) => x.status !== 'finished')) { expect(r.seed).toBeNull(); expect(r.result).toBeNull(); }
    const v = await rpc(READER, 'admin_round_verify', [finished]);
    expect(v).toMatchObject({ hash_ok: true, result_ok: true });
  });
  it('a recorded result that does not match the seed is reported as such', async () => {
    await sql(`update public.game_rounds set result = '{"point": 1.01}' where id = $1`, [finished]);
    const v = await rpc(OWNER, 'admin_round_verify', [finished]);
    expect(v.hash_ok).toBe(true);
    expect(v.result_ok).toBe(v.recomputed.point === 1.01);
  });
  it('an unfinished round cannot be checked, and voiding needs rounds.void', async () => {
    const open = (await rpc(READER, 'admin_rounds', ['crash'])).find((x: any) => x.status !== 'finished');
    if (open) await fails(rpc(READER, 'admin_round_verify', [open.id]), 'round_not_finished');
    await fails(rpc(MOD, 'admin_room_flag', ['round', String(finished), 'void', 'bad']), 'admin_denied');
    await rpc(OWNER, 'admin_room_flag', ['round', String(finished), 'void', 'server hiccup']);
    expect((await rpc(READER, 'admin_rounds', ['crash'])).find((x: any) => x.id === finished).flags[0].flag).toBe('void');
  });
});
