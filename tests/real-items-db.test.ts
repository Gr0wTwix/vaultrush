// @vitest-environment node
// Migrations 0014 and 0015 (the real Counter-Strike 2 catalogue) on a database that already has players holding the OLD invented items: every old item is
// swapped for the real item of the new cases closest in value, the invented items are gone, the cases and their tickets are the new ones, and running the
// files again (a price refresh) changes nothing about what players own.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES, CATALOGUE_TOTAL, ITEM, REWARD_CASES } from '../src/data.js';
import { realItemMigrations } from './helpers.js';

const P = '66666666-6666-4666-8666-666666666666';
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
  insert into auth.users (id, email) values ('${P}', 'p@example.com');
`;
const sql = async (t: string, p: unknown[] = []) => (await db.query(t, p)).rows as any[];
const run = (m: string) => db.exec(readFileSync(new URL(`../supabase/migrations/${m}.sql`, import.meta.url), 'utf8'));
const OLD = ['p1', 'k1', 'x18', 'c2'];                                  // invented items of the old catalogue, from cheap to dear
let oldValues: Record<string, number> = {};

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const m of ['0001_core', '0002_live', '0003_live_erasure', '0004_claims_bots_caps', '0005_rounds', '0006_admin']) await run(m);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${P}', false), set_config('request.jwt.claims', '{"sub":"${P}","aal":"aal1"}', false); select public.complete_signup('Nova', '2026-11-21', true); reset role;`);
  for (const m of ['0007_site_controls', '0008_wallet', '0009_catalogue', '0010_solo_games', '0011_live_wallet', '0012_rewards', '0013_crash_pace']) await run(m);
  for (const r of await sql(`select id, value from public.catalog_items where id = any($1)`, [OLD])) oldValues[r.id] = Number(r.value);
  for (const id of OLD) await db.query(`insert into public.inventory (user_id, item_id) values ($1, $2), ($1, $2)`, [P, id]);
}, 120_000);
afterAll(async () => { await db.close(); });

describe('0014 and 0015 on a database that has players with old items', () => {
  it('starts with the invented catalogue and two of each old item in the inventory', async () => {
    expect(Object.keys(oldValues).sort()).toEqual([...OLD].sort());
    expect((await sql(`select count(*)::int as n from public.inventory where user_id = $1`, [P]))[0].n).toBe(OLD.length * 2);
  });
  it('swaps every old item for the real item closest in value, and removes the invented items', async () => {
    for (const m of realItemMigrations()) await run(m);
    const inv = await sql(`select i.item_id, it.value from public.inventory i join public.catalog_items it on it.id = i.item_id where i.user_id = $1`, [P]);
    expect(inv).toHaveLength(OLD.length * 2);
    expect(inv.every(r => String(r.item_id).startsWith('skin-'))).toBe(true);
    // the new items are the case items, each within a few percent of an old value
    const got = inv.map(r => Number(r.value)).sort((a, b) => a - b), want = OLD.flatMap(id => [oldValues[id]!, oldValues[id]!]).sort((a, b) => a - b);
    got.forEach((v, i) => { const w = want[i]!; if (w >= 1) expect(Math.abs(Math.log(v / w))).toBeLessThan(0.5); });   // within a factor of about 1.6 (the cases only hold some values)
    expect((await sql(`select count(*)::int as n from public.catalog_items where legacy or id in ('p1', 'k1', 'x18', 'c2')`))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from public.catalog_items`))[0].n).toBe(CATALOGUE_TOTAL);
  });
  it('has exactly the cases, prices and tickets of the page, and the free crates', async () => {
    const all = [...CASES, ...REWARD_CASES];
    const rows = await sql(`select id, price, reward from public.catalog_cases order by id`);
    expect(rows.map(r => r.id)).toEqual(all.map(c => c.id).sort());
    for (const c of all) {
      expect(Number(rows.find(r => r.id === c.id)!.price)).toBe(c.price);
      const es = await sql(`select item_id, ticket_from, ticket_to from public.catalog_case_entries where case_id = $1 order by ticket_from`, [c.id]);
      expect(es.map(e => [e.item_id, e.ticket_from, e.ticket_to])).toEqual([...c.entries].sort((a, b) => a.from - b.from).map(e => [e.item.id, e.from, e.to]));
    }
    expect(Number((await sql(`select count(*)::int as n from public.catalog_case_entries e join public.catalog_items i on i.id = e.item_id where i.value = 0`))[0].n)).toBe(0);
  });
  it('gives every item of a case a name for the database too', async () => {
    const rows = await sql(`select id, weapon, skin, type from public.catalog_items where id in (select item_id from public.catalog_case_entries)`);
    for (const r of rows) { const it = ITEM[r.id]!; expect(r.weapon).toBe(it.weapon); expect(r.skin).toBe(it.skin); expect(r.type).toBe(it.type); }
  });
  it('can be run again for a price refresh without touching what players own', async () => {
    const before = await sql(`select item_id from public.inventory where user_id = $1 order by item_id`, [P]);
    for (const m of realItemMigrations()) await run(m);
    expect(await sql(`select item_id from public.inventory where user_id = $1 order by item_id`, [P])).toEqual(before);
    expect((await sql(`select count(*)::int as n from public.catalog_items`))[0].n).toBe(CATALOGUE_TOTAL);
    expect((await sql(`select count(*)::int as n from public.catalog_cases`))[0].n).toBe(CASES.length + REWARD_CASES.length);
  });
  it('lets a player open a case and upgrade to ANY item of the catalogue afterwards', async () => {
    const top = (await sql(`select id, value from public.catalog_items order by value desc limit 1`))[0];
    expect(Number(top.value)).toBeGreaterThan(10000);
    await db.exec(`update public.wallets set balance = 1000 where user_id = '${P}'`);
    const as = async <T>(fn: () => Promise<T>) => { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${P}', false), set_config('request.jwt.claims', '{"sub":"${P}","aal":"aal1"}', false);`); try { return await fn(); } finally { await db.exec('reset role;'); } };
    const opened = await as(async () => (await db.query(`select public.open_cases('starter', 1) as v`)).rows[0] as any);
    expect(opened.v.opened).toHaveLength(1); expect(String(opened.v.opened[0].item)).toMatch(/^skin-/);
    const up = await as(async () => (await db.query(`select public.upgrade_item('{}'::uuid[], 20, $1, false) as v`, [top.id])).rows[0] as any);
    expect(up.v.item).toBe(top.id); expect(up.v.chance).toBeCloseTo((20 / Number(top.value)) * 0.95, 8);
  });
});
