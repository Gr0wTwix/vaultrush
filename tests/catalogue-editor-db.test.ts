// @vitest-environment node
// Migration 0022: the case catalogue editor. Who may look and change, the checks on a case (tickets, items, return), versions and restoring,
// cases in use by a waiting battle, switching a case off, and that the game reads (and the server draws from) exactly what was saved.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { realItemMigrations } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const OWNER = '11111111-1111-1111-1111-111111111111';
const MOD = '33333333-3333-3333-3333-333333333333';
const READER = '44444444-4444-4444-4444-444444444444';
const P1 = '55555555-5555-4555-8555-555555555555';
const PW = 'Correct-Horse-Battery-9';
const MIGRATIONS = ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin', '0007_site_controls', '0008_wallet', '0009_catalogue',
  '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace', ...realItemMigrations(), '0017_bet_caps', '0018_server_limits', '0019_admin_wallet', '0020_rate_limits',
  '0021_admin_control', '0022_catalogue_editor'];
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
  insert into auth.users (id, email) values ${[OWNER, MOD, READER, P1].map((id, i) => `('${id}', 'u${i}@example.com')`).join(', ')};
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
/** Saves a case with the given [item, tickets] list. */
const save = (uid: string, id: string, version: number, price: number, entries: [string, number][], name = 'Test Crate', reason = 'testing the editor') =>
  rpc(uid, 'admin_catalogue_save', [id, version, name, price, 210, 'new', null, 5, JSON.stringify(entries.map(([item, tickets]) => ({ item, tickets }))), reason]);

let cheap: { id: string; value: number }[] = [];
let dear: { id: string; value: number };
/** A price that gives the wanted return for these entries. */
const priceFor = (entries: [string, number][], rtp: number): number => {
  const val = (id: string): number => (cheap.find(x => x.id === id) ?? dear).value;
  return Math.round((entries.reduce((s, [id, t]) => s + val(id) * t, 0) / 100000 / rtp) * 100) / 100;
};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
  for (const [id, n] of [[OWNER, 'Mirage'], [MOD, 'Vexx'], [READER, 'Reed'], [P1, 'Nova']] as const) await rpc(id, 'complete_signup', [n, '2026-11-21', true], 'aal1');
  await sql(`insert into public.admin_roles (user_id, role, granted_by) values ($1, 'owner', $1), ($2, 'moderator', $1), ($3, 'readonly', $1)`, [OWNER, MOD, READER]);
  for (const id of [OWNER, MOD, READER]) await unlock(id);
  await sql(`select public.wallet_credit($1, 5000, 'bonus')`, [P1]);
  cheap = (await sql(`select id, value::float as value from public.catalog_items where not legacy and name is not null and value between 0.5 and 2 order by value, id limit 4`));
  dear = (await sql(`select id, value::float as value from public.catalog_items where not legacy and name is not null and value between 40 and 60 order by value, id limit 1`))[0];
}, 300_000);
afterAll(async () => { await db.close(); });

describe('looking', () => {
  it('lists every case with its return and version; staff without catalogue.view and players see nothing', async () => {
    const list = await rpc(READER, 'admin_catalogue_cases');
    expect(list.length).toBe(52);
    const starter = list.find((c: any) => c.id === 'starter');
    expect(starter).toMatchObject({ version: 1, active: true, reward: false, in_use: false });
    expect(starter.ev / starter.price).toBeGreaterThan(0.85);                    // the generated cases keep a 90% return
    await fails(rpc(MOD, 'admin_catalogue_cases'), 'admin_denied');
    await fails(rpc(P1, 'admin_catalogue_cases', [], 'aal1'), 'admin_denied');
  });
  it('one case shows its items with ticket ranges, and its first version is already in the history', async () => {
    const c = await rpc(READER, 'admin_catalogue_case', ['starter']);
    expect(c.entries.reduce((s: number, e: any) => s + e.tickets, 0)).toBe(100000);
    expect(c.entries[0].from).toBe(0);
    expect(c.history).toEqual([expect.objectContaining({ version: 1, reason: 'as installed (0015)' })]);
    await fails(rpc(READER, 'admin_catalogue_case', ['nope']), 'case_not_found');
  });
  it('item search finds real items by every word of the name, within a value range', async () => {
    const got = await rpc(READER, 'admin_catalogue_items', ['ak-47 redline', 0, null, 20]);
    expect(got.length).toBeGreaterThan(0);
    for (const i of got) { expect(i.name.toLowerCase()).toContain('ak-47'); expect(i.name.toLowerCase()).toContain('redline'); }
    const band = await rpc(READER, 'admin_catalogue_items', ['', 10, 11, 50]);
    for (const i of band) expect(i.value).toBeGreaterThanOrEqual(10), expect(i.value).toBeLessThanOrEqual(11);
  });
  it('anyone, even signed out, can read the published catalogue the game shows', async () => {
    const pub = await rpc(null, 'catalogue_public', [], 'aal1');
    expect(pub.cases.length).toBe(52);
    const s = pub.cases.find((c: any) => c.id === 'starter');
    expect(s.entries[0]).toEqual([expect.any(String), 0, expect.any(Number)]);
  });
});

describe('creating and changing a case', () => {
  it('refuses tickets that do not add up to 100,000, unknown or repeated items, a bad id or name', async () => {
    const a = cheap[0]!, b = cheap[1]!;
    await fails(save(OWNER, 'test-crate', 0, 1, [[a.id, 60000], [b.id, 30000]]), 'tickets_not_100000');
    await fails(save(OWNER, 'test-crate', 0, 1, [[a.id, 50000], ['no-such-item', 50000]]), 'unknown_item');
    await fails(save(OWNER, 'test-crate', 0, 1, [[a.id, 50000], [a.id, 50000]]), 'duplicate_item');
    await fails(save(OWNER, 'Bad Id!', 0, 1, [[a.id, 100000]]), 'invalid_case_id');
    await fails(save(OWNER, 'test-crate', 0, 1, [[a.id, 100000]], 'x'), 'invalid_case_name');
    await fails(save(OWNER, 'test-crate', 0, 1, [[a.id, 100000]], 'Test Crate', ''), 'reason_required');
    await fails(save(MOD, 'test-crate', 0, 1, [[a.id, 100000]]), 'admin_denied');
  });
  it('refuses a price whose return is outside 70% to 98%, and accepts one inside', async () => {
    const entries: [string, number][] = [[cheap[0]!.id, 70000], [cheap[1]!.id, 29000], [dear.id, 1000]];
    await fails(save(OWNER, 'test-crate', 0, priceFor(entries, 0.99), entries), 'rtp_out_of_range');
    await fails(save(OWNER, 'test-crate', 0, priceFor(entries, 0.6), entries), 'rtp_out_of_range');
    const r = await save(OWNER, 'test-crate', 0, priceFor(entries, 0.9), entries);
    expect(r).toMatchObject({ id: 'test-crate', version: 1, created: true });
    expect(r.rtp).toBeGreaterThan(0.89); expect(r.rtp).toBeLessThan(0.91);
    const c = await rpc(OWNER, 'admin_catalogue_case', ['test-crate']);
    expect(c.entries.map((e: any) => [e.from, e.to])).toEqual([[0, 69999], [70000, 98999], [99000, 99999]]);
    expect((await sql(`select action from public.admin_audit_log order by id desc limit 1`))[0].action).toBe('catalogue.create');
  });
  it('a change needs the version it was based on, so two editors cannot overwrite each other', async () => {
    const entries: [string, number][] = [[cheap[0]!.id, 50000], [cheap[2]!.id, 49000], [dear.id, 1000]];
    await fails(save(OWNER, 'test-crate', 0, priceFor(entries, 0.9), entries), 'case_changed');
    const r = await save(OWNER, 'test-crate', 1, priceFor(entries, 0.9), entries, 'Test Crate II', 'new mix');
    expect(r.version).toBe(2);
    await fails(save(OWNER, 'test-crate', 1, priceFor(entries, 0.9), entries), 'case_changed');
    expect((await rpc(OWNER, 'admin_catalogue_case', ['test-crate'])).history.map((h: any) => h.version)).toEqual([2, 1]);
  });
  it('restoring an old version brings its contents back as a new version', async () => {
    const r = await rpc(OWNER, 'admin_catalogue_restore', ['test-crate', 1, 'the old mix sold better']);
    expect(r.version).toBe(3);
    const c = await rpc(OWNER, 'admin_catalogue_case', ['test-crate']);
    expect(c.name).toBe('Test Crate');
    expect(c.entries.map((e: any) => e.tickets)).toEqual([70000, 29000, 1000]);
    await fails(rpc(OWNER, 'admin_catalogue_restore', ['test-crate', 1, '']), 'reason_required');
  });
  it('the game sees the new case and the server opens it exactly as saved', async () => {
    const pub = await rpc(P1, 'catalogue_public', [], 'aal1');
    const mine = pub.cases.find((c: any) => c.id === 'test-crate');
    expect(mine).toMatchObject({ name: 'Test Crate', version: 3, hue: 210, tag: 'new' });
    const opened = await rpc(P1, 'open_cases', ['test-crate', 1, 'k1'], 'aal1');
    expect(JSON.stringify(opened)).toMatch(new RegExp(`${cheap[0]!.id}|${cheap[1]!.id}|${dear.id}`));
  });
});

describe('cases in use and switching off', () => {
  it('a case in a waiting battle cannot be re-priced or switched off; its contents can still be edited', async () => {
    const b = await rpc(P1, 'create_live_battle', [['test-crate'], '1v1', 'normal'], 'aal1');
    const c = await rpc(OWNER, 'admin_catalogue_case', ['test-crate']);
    expect(c.in_use).toBe(true);
    const entries: [string, number][] = c.entries.map((e: any) => [e.item, e.tickets]);
    await fails(save(OWNER, 'test-crate', c.version, c.price + 1, entries), 'case_in_use');
    await fails(rpc(OWNER, 'admin_catalogue_set_active', ['test-crate', false, 'retire']), 'case_in_use');
    await rpc(P1, 'leave_live_battle', [b.id], 'aal1');
    expect((await rpc(OWNER, 'admin_catalogue_case', ['test-crate'])).in_use).toBe(false);
  });
  it('a case switched off disappears from the game and cannot be opened; switching it on brings it back', async () => {
    await rpc(OWNER, 'admin_catalogue_set_active', ['test-crate', false, 'retired for now']);
    expect((await rpc(P1, 'catalogue_public', [], 'aal1')).cases.map((c: any) => c.id)).not.toContain('test-crate');
    await fails(rpc(P1, 'open_cases', ['test-crate', 1, 'k2'], 'aal1'), 'case');
    await rpc(OWNER, 'admin_catalogue_set_active', ['test-crate', true, 'back']);
    expect((await rpc(P1, 'catalogue_public', [], 'aal1')).cases.map((c: any) => c.id)).toContain('test-crate');
  });
  it('reward crates can be edited without a price check, and players cannot call the editor', async () => {
    const d = await rpc(OWNER, 'admin_catalogue_case', ['daily']);
    const entries: [string, number][] = d.entries.map((e: any) => [e.item, e.tickets]);
    expect((await save(OWNER, 'daily', d.version, d.price, entries, d.name, 'same contents, new version')).version).toBe(d.version + 1);
    await fails(rpc(P1, 'admin_catalogue_save', ['x', 0, 'X', 1, null, null, null, 0, '[]', 'why'], 'aal1'), 'admin_denied');
  });
  it('can be run a second time without changing anything', async () => {
    const before = (await sql(`select count(*)::int as n from public.catalog_case_history`))[0].n;
    await db.exec(readFileSync(new URL('../supabase/migrations/0022_catalogue_editor.sql', import.meta.url), 'utf8'));
    expect((await sql(`select count(*)::int as n from public.catalog_case_history`))[0].n).toBe(before);
    expect((await rpc(READER, 'admin_catalogue_case', ['test-crate'])).version).toBe(3);
  });
});
