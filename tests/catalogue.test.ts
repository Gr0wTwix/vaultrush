// @vitest-environment node
// The full catalogue (src/catalogue.ts) against the static files that `npm run build:catalogue` wrote to public/catalogue: the index and the item files agree
// with each other and with the items bundled in the cases, and the search, paging and lazy loading work (a fake fetch serves the real files).
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cheapestAtLeast, ensureItems, filterRows, indexLoaded, loadIndex, queryItems, TYPES } from '../src/catalogue.js';
import { CATALOGUE_TOTAL, CATALOGUE_VERSION, ITEM, ITEMS, RARITY_ORDER, itemImage } from '../src/data.js';

const pub = (p: string): any => JSON.parse(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));
const manifest = pub('catalogue/manifest.json'), index = pub('catalogue/index.json');
let fetched: string[] = [], broken = false;

beforeAll(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    if (broken) throw new Error('offline');
    try { const j = pub(url); return { ok: true, status: 200, json: async () => j }; } catch { return { ok: false, status: 404, json: async () => ({}) }; }
  });
});
afterEach(() => { broken = false; });

describe('the files agree with each other and with the page', () => {
  it('has the same version and size everywhere', () => {
    expect(manifest.v).toBe(CATALOGUE_VERSION); expect(index.v).toBe(CATALOGUE_VERSION);
    expect(manifest.items).toBe(CATALOGUE_TOTAL); expect(index.items).toHaveLength(CATALOGUE_TOTAL);
    expect(manifest.currency).toBe('USD'); expect(manifest.coinsPerUsd).toBeGreaterThan(0);
  });
  it('lists the index cheapest first with no duplicate ids', () => {
    const rows = index.items as any[];
    for (let i = 1; i < rows.length; i++) expect(rows[i][2]).toBeGreaterThanOrEqual(rows[i - 1][2]);
    expect(new Set(rows.map(r => r[0])).size).toBe(rows.length);
  });
  it('has every index row in the item file it points to, with the same value and grade, and no item file holds more than its share', () => {
    const files = new Map<number, any[]>();
    for (let n = 0; n < manifest.shards; n++) { const rows = pub(`catalogue/s/${n}.json`) as any[]; expect(rows.length).toBeLessThanOrEqual(manifest.shardSize); files.set(n, rows); }
    let seen = 0;
    for (const r of index.items as any[]) {
      const row = files.get(r[4])!.find(x => x[0] === r[0]);
      expect(row, r[0]).toBeTruthy();
      expect(row[6], r[0]).toBe(r[2]); expect(row[5], r[0]).toBe(r[3]); expect(row[8], r[0]).toBe(index.types[r[6]]);
      expect(row[7]).toMatch(/^[\w-]+$|^https:\/\/raw\.githubusercontent\.com\//);                 // a Steam picture key, or a whole address for the newer drops
      expect(`${row[1]} | ${row[2]}`.length).toBeGreaterThan(3);
      seen++;
    }
    expect(seen).toBe(CATALOGUE_TOTAL);
  });
  it('has the items inside the cases at the same value, grade and picture as the full catalogue', () => {
    const byId = new Map<string, any[]>();
    for (let n = 0; n < manifest.shards; n++) for (const r of pub(`catalogue/s/${n}.json`) as any[]) byId.set(r[0], r);
    for (const it of ITEMS) {
      const r = byId.get(it.id)!; expect(r, it.id).toBeTruthy();
      expect(r[6]).toBe(it.value); expect(RARITY_ORDER[r[5]]).toBe(it.rarity); expect(itemImage(r[7])).toBe(it.img); expect(r[1]).toBe(it.weapon); expect(r[2]).toBe(it.skin);
    }
  });
});

describe('searching', () => {
  let rows: Awaited<ReturnType<typeof loadIndex>>;
  beforeAll(async () => { rows = await loadIndex(); });

  it('loads the index once', async () => {
    expect(indexLoaded()).toBe(true);
    const n = fetched.length; await loadIndex(); expect(fetched.length).toBe(n);
  });
  it('keeps only items worth MORE than the minimum, up to the maximum, cheapest first', () => {
    const r = filterRows(rows, { min: 100, max: 200 });
    expect(r.length).toBeGreaterThan(10);
    for (const x of r) { expect(x.value).toBeGreaterThan(100); expect(x.value).toBeLessThanOrEqual(200); }
    for (let i = 1; i < r.length; i++) expect(r[i]!.value).toBeGreaterThanOrEqual(r[i - 1]!.value);
    const exact = rows.find(x => x.value === 100) ?? rows.find(x => x.value > 100)!;
    expect(filterRows(rows, { min: exact.value }).every(x => x.value > exact.value)).toBe(true);
  });
  it('sorts the dearest first on request', () => {
    const r = filterRows(rows, { dir: 'desc' });
    expect(r[0]!.value).toBe(Math.max(...rows.map(x => x.value)));
    for (let i = 1; i < r.length; i++) expect(r[i]!.value).toBeLessThanOrEqual(r[i - 1]!.value);
  });
  it('matches every word of the search, in any order and any case', () => {
    const r = filterRows(rows, { q: 'redline AK-47' });
    expect(r.length).toBeGreaterThan(3);
    for (const x of r) { expect(x.lower).toContain('redline'); expect(x.lower).toContain('ak-47'); }
    expect(filterRows(rows, { q: 'zzzzzz-nothing' })).toEqual([]);
  });
  it('filters by weapon type and by grade', () => {
    const knives = filterRows(rows, { type: 'knife' });
    expect(knives.length).toBeGreaterThan(1000); for (const k of knives) expect(k.type).toBe('knife');
    const covert = filterRows(rows, { rarity: 'covert', type: 'sniper' });
    expect(covert.length).toBeGreaterThan(0); for (const c of covert) { expect(c.rarity).toBe('covert'); expect(c.type).toBe('sniper'); }
    expect(new Set(rows.map(r => r.type))).toEqual(new Set(TYPES));
  });
  it('tells StatTrak and Souvenir apart', () => {
    const st = rows.filter(r => r.st), sv = rows.filter(r => r.souv);
    expect(st.length).toBeGreaterThan(500); expect(sv.length).toBeGreaterThan(50);
    for (const r of st.slice(0, 50)) expect(r.name).toContain('StatTrak');
    for (const r of sv.slice(0, 50)) expect(r.name).toContain('Souvenir');
  });
});

describe('pages and lazy loading', () => {
  it('returns a page of real items, the next page continues where it stopped, and only the item files that page needs are fetched', async () => {
    fetched = [];
    const a = await queryItems({ min: 50, q: 'ak-47' }, 0, 12), b = await queryItems({ min: 50, q: 'ak-47' }, 12, 12);
    expect(a.items).toHaveLength(12); expect(a.total).toBeGreaterThan(24);
    expect(a.items.some(x => b.items.includes(x))).toBe(false);
    expect(a.items[11]!.value).toBeLessThanOrEqual(b.items[0]!.value);
    for (const it of [...a.items, ...b.items]) { expect(ITEM[it.id]).toBe(it); expect(it.weapon).toBe('AK-47'); expect(it.img).toMatch(/^https:/); }
    expect(fetched.filter(u => u.endsWith('index.json')).length).toBeLessThanOrEqual(1);
    expect(fetched.filter(u => /\/s\/\d+\.json$/.test(u)).length).toBeLessThanOrEqual(24);
  });
  it('fetches an item that is not bundled, once, and knows it afterwards', async () => {
    const rows = await loadIndex();
    const id = rows.find(r => !ITEM[r.id] && r.value > 3000)!.id;
    fetched = [];
    expect(await ensureItems([id])).toBe(true);
    expect(ITEM[id]!.value).toBeGreaterThan(3000);
    expect(fetched.filter(u => /\/s\/\d+\.json$/.test(u))).toHaveLength(1);
    fetched = []; expect(await ensureItems([id])).toBe(true); expect(fetched).toEqual([]);
  });
  it('answers false for an id nobody knows, and never throws when the network is down; a failed load is retried later', async () => {
    expect(await ensureItems(['skin-does-not-exist'])).toBe(false);
    const rows = await loadIndex();
    const id = rows.find(r => !ITEM[r.id] && r.value > 1000)!.id;
    broken = true; expect(await ensureItems([id])).toBe(false); expect(ITEM[id]).toBeUndefined();
    broken = false; expect(await ensureItems([id])).toBe(true); expect(ITEM[id]).toBeTruthy();
  });
  it('finds the cheapest item worth at least an amount, and nothing when no item is that valuable', async () => {
    const it = await cheapestAtLeast(500);
    expect(it!.value).toBeGreaterThanOrEqual(500);
    const rows = await loadIndex();
    expect(rows.some(r => r.value >= 500 && r.value < it!.value)).toBe(false);
    expect(await cheapestAtLeast(1e9)).toBeNull();
  });
});
