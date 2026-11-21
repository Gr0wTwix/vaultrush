// The full Counter-Strike 2 catalogue (every priced item), loaded on demand. Only the items inside the cases are bundled with the page (src/data.ts);
// everything else lives in static files made by `npm run build:catalogue`:
//   catalogue/index.json    one short row per item (id, name, value, grade, which file holds it): enough to search, filter and sort
//   catalogue/s/<n>.json    the items themselves (weapon, skin, wear, picture, type), 50 per file, cheapest first
// A page asks for what it shows: the Upgrade page for the target list, the Inventory for items that came from an upgrade.
import { ITEM, RARITY_ORDER, itemImage, registerItem } from './data.js';
import type { Item, Rarity } from './types.js';

/** One row of the search index. */
export interface Row { id: string; name: string; lower: string; value: number; rarity: Rarity; shard: number; st: boolean; souv: boolean; type: string }
export interface Query { min?: number; max?: number; q?: string; dir?: 'asc' | 'desc'; type?: string; rarity?: Rarity }
/** Weapon types, in the order the index numbers them. */
export const TYPES = ['knife', 'gloves', 'rifle', 'sniper', 'smg', 'pistol', 'heavy', 'equipment'] as const;

const DIR = 'catalogue/';
const getJson = async (path: string): Promise<any> => {
  const r = await fetch(DIR + path, { cache: 'default' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

let indexP: Promise<Row[]> | null = null;
let byId: Map<string, Row> | null = null;
/** The search index (about 14,000 rows). Loaded once; a failed load is retried next time. */
export function loadIndex(): Promise<Row[]> {
  if (!indexP) {
    indexP = getJson('index.json').then((j): Row[] => {
      const rows = (j.items as any[]).map((r): Row => ({ id: r[0], name: r[1], lower: String(r[1]).toLowerCase(), value: r[2], rarity: RARITY_ORDER[r[3]] as Rarity, shard: r[4], st: !!(r[5] & 1), souv: !!(r[5] & 2), type: TYPES[r[6]] ?? 'rifle' }));
      byId = new Map(rows.map(r => [r.id, r]));
      return rows;
    }).catch(e => { indexP = null; throw e; });
  }
  return indexP;
}
/** True once the index is in memory (the Upgrade page then answers searches without waiting). */
export const indexLoaded = (): boolean => byId !== null;

const shardP = new Map<number, Promise<void>>();
function loadShard(n: number): Promise<void> {
  let p = shardP.get(n);
  if (!p) {
    p = getJson(`s/${n}.json`).then((rows: any[]) => {
      for (const r of rows) registerItem({ id: r[0], weapon: r[1], skin: r[2], wear: r[3], st: !!(r[4] & 1), souv: !!(r[4] & 2), rarity: RARITY_ORDER[r[5]] as Rarity, value: r[6], img: itemImage(r[7]), type: r[8] });
    }).catch(e => { shardP.delete(n); throw e; });
    shardP.set(n, p);
  }
  return p;
}

/**
 * Make sure the page knows every one of these items (fetching what is missing). Resolves true when all of them are known afterwards; never throws, so a page
 * can call it and draw whatever it has either way.
 */
export async function ensureItems(ids: string[]): Promise<boolean> {
  const missing = [...new Set(ids)].filter(id => !ITEM[id]);
  if (!missing.length) return true;
  try {
    await loadIndex();
    const shards = new Set<number>();
    for (const id of missing) { const r = byId!.get(id); if (r) shards.add(r.shard); }
    await Promise.all([...shards].map(loadShard));
  } catch { /* offline or a missing file: the caller draws the stand-ins */ }
  return missing.every(id => !!ITEM[id]);
}

/** The rows that match: worth more than `min` (and at most `max`), name contains every word of `q`, the type and grade if given; cheapest first, or dearest first with dir "desc". */
export function filterRows(rows: Row[], { min = 0, max = Infinity, q = '', dir = 'asc', type, rarity }: Query = {}): Row[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // rows are sorted by value ascending: skip straight past everything at or under `min`
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((rows[mid] as Row).value > min) hi = mid; else lo = mid + 1; }
  const out: Row[] = [];
  for (let i = lo; i < rows.length; i++) {
    const r = rows[i] as Row;
    if (r.value > max) break;
    if (rarity && r.rarity !== rarity) continue;
    if (type && r.type !== type) continue;
    if (words.length && !words.every(w => r.lower.includes(w))) continue;
    out.push(r);
  }
  return dir === 'desc' ? out.reverse() : out;
}

/** One page of results: the matching items (fetched), and how many match in all. */
export async function queryItems(query: Query, offset: number, limit: number): Promise<{ total: number; items: Item[] }> {
  const rows = await loadIndex();
  const hits = filterRows(rows, query);
  const page = hits.slice(offset, offset + limit);
  await ensureItems(page.map(r => r.id));
  return { total: hits.length, items: page.map(r => ITEM[r.id]).filter((i): i is Item => !!i) };
}

/** The cheapest item worth at least `value` (the Upgrade page's 2× / 5× / 10× buttons). */
export async function cheapestAtLeast(value: number): Promise<Item | null> {
  const rows = await loadIndex();
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((rows[mid] as Row).value >= value) hi = mid; else lo = mid + 1; }
  const r = rows[lo];
  if (!r) return null;
  await ensureItems([r.id]);
  return ITEM[r.id] ?? null;
}
