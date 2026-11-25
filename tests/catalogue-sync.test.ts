// The game site reads the published cases (migration 0022) at start-up and swaps the bundled ones in place; anything odd keeps the bundled cases.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ answer: null as any, fail: false, enabled: true }));
vi.mock('../src/backend.js', async orig => ({
  ...(await orig<typeof import('../src/backend.js')>()),
  backendEnabled: () => fake.enabled,
  call: async (fn: string) => { if (fake.fail) throw new Error('network'); if (fn !== 'catalogue_public') throw new Error(fn); return fake.answer; },
}));
vi.mock('../src/catalogue.js', async orig => ({ ...(await orig<typeof import('../src/catalogue.js')>()), ensureItems: async (ids: string[]) => ids.every(id => id !== 'never-heard-of') }));

const { CASE, CASES, REWARD_CASES, ITEMS, applyCatalogue } = await import('../src/data.js');
const { syncCatalogue } = await import('../src/catalogue-sync.js');

const [i1, i2, i3] = [ITEMS[0]!, ITEMS[10]!, ITEMS[ITEMS.length - 1]!];
const bundled = CASES.map(c => c.id);
const pub = (over: Partial<Record<string, any>> = {}) => ({
  cases: [
    { id: 'starter', name: 'Starter Crate v2', price: 0.75, reward: false, hue: null, tag: null, art: null, version: 2, entries: [[i1.id, 0, 89999], [i2.id, 90000, 99999]] },
    { id: 'brand-new', name: 'Brand New', price: 3, reward: false, hue: 40, tag: 'new', art: 'neon', version: 1, entries: [[i1.id, 0, 98999], [i3.id, 99000, 99999]] },
    { id: 'daily', name: 'Daily Crate', price: 0.34, reward: true, hue: null, tag: null, art: null, version: 1, entries: [[i1.id, 0, 99999]] },
    ...(over['extra'] ?? []),
  ],
});

beforeEach(() => { fake.fail = false; fake.enabled = true; });

describe('the published catalogue', () => {
  it('does nothing without a backend, on an error, or with an empty answer (the bundled cases stay)', async () => {
    fake.enabled = false; expect(await syncCatalogue()).toBe(false);
    fake.enabled = true; fake.fail = true; expect(await syncCatalogue()).toBe(false);
    fake.fail = false; fake.answer = { cases: [] }; expect(await syncCatalogue()).toBe(false);
    expect(CASES.map(c => c.id)).toEqual(bundled);
  });
  it('refuses a list with an item the page cannot load, changing nothing', async () => {
    fake.answer = pub({ extra: [{ id: 'odd', name: 'Odd', price: 1, reward: false, hue: null, tag: null, art: null, version: 1, entries: [['never-heard-of', 0, 99999]] }] });
    expect(await syncCatalogue()).toBe(false);
    expect(CASES.map(c => c.id)).toEqual(bundled);
  });
  it('swaps the cases in place: edited, new and switched-off cases, with chances and expected value from the tickets', async () => {
    const sameArray = CASES;
    fake.answer = pub();
    expect(await syncCatalogue()).toBe(true);
    expect(sameArray).toBe(CASES);
    expect(CASES.map(c => c.id)).toEqual(['starter', 'brand-new']);           // every other bundled case is switched off
    expect(REWARD_CASES.map(c => c.id)).toEqual(['daily']);
    const s = CASE['starter']!;
    expect(s).toMatchObject({ name: 'Starter Crate v2', price: 0.75 });
    expect(s.entries.map(e => [e.from, e.to, e.chance])).toEqual([[0, 89999, 0.9], [90000, 99999, 0.1]]);
    expect(s.ev).toBeCloseTo(i1.value * 0.9 + i2.value * 0.1, 3);
    expect(s.hue).toBeTypeOf('number');                                       // kept from the bundled case when the database has none
    const n = CASE['brand-new']!;
    expect(n).toMatchObject({ hue: 40, tag: 'new', img: 'assets/cases/neon.webp' });   // a new case can borrow another case's picture
    expect(CASE['neon']).toBeDefined();                                       // switched-off cases stay known for old records
  });
  it('asking again with the same versions changes nothing', async () => {
    expect(await syncCatalogue()).toBe(false);
  });
  it('applyCatalogue never empties the site', () => {
    expect(applyCatalogue([{ id: 'daily', name: 'Daily', price: 0, reward: true, hue: null, tag: null, art: null, version: 9, entries: [[i1.id, 0, 99999]] }])).toBe(false);
    expect(CASES.length).toBe(2);
  });
});
