import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASE, CASES, ITEM, ITEMS, REWARD_CASES, RARITY, RARITY_ORDER, CATALOGUE_TOTAL, entryForTicket, ticketOf, isBigDrop, isHugeDrop, itemImage, itemOf, itemName } from '../src/data.js';
import { HOUSE } from '../src/fair.js';

describe('item catalog (the items inside the cases)', () => {
  it('has unique ids, positive values and a known grade for every item', () => {
    expect(new Set(ITEMS.map(i => i.id)).size).toBe(ITEMS.length);
    for (const i of ITEMS) {
      expect(i.value).toBeGreaterThan(0);
      expect(RARITY[i.rarity]).toBeDefined();
      expect(ITEM[i.id]).toBe(i);
    }
  });
  it('is the real thing: every item has a weapon, a skin, a wear and a picture on the Steam CDN', () => {
    for (const i of ITEMS) {
      expect(i.id, i.id).toMatch(/^skin-/);
      expect(i.weapon.length, i.id).toBeGreaterThan(0); expect(i.skin.length, i.id).toBeGreaterThan(0);
      expect(i.img, i.id).toMatch(/^https:\/\/community\.akamai\.steamstatic\.com\/economy\/image\/.+\/256fx192f$/);
      expect(['', 'FN', 'MW', 'FT', 'WW', 'BS']).toContain(i.wear);
    }
  });
  it('is listed cheapest first and every item of every case is in it', () => {
    for (let k = 1; k < ITEMS.length; k++) expect(ITEMS[k]!.value).toBeGreaterThanOrEqual(ITEMS[k - 1]!.value);
    for (const c of [...CASES, ...REWARD_CASES]) for (const e of c.entries) expect(ITEMS).toContain(e.item);
  });
  it('knows how big the full catalogue is', () => { expect(CATALOGUE_TOTAL).toBeGreaterThan(10000); });
  it('has the real item grades and colours in order', () => {
    expect(RARITY_ORDER).toHaveLength(8);
    for (const r of RARITY_ORDER) expect(RARITY[r].color).toMatch(/^#[0-9a-f]{6}$/);
    expect(isBigDrop('covert')).toBe(true); expect(isBigDrop('milspec')).toBe(false); expect(isHugeDrop('covert')).toBe(false); expect(isHugeDrop('contraband')).toBe(true);
  });
  it('builds picture addresses, and a stand-in for an item that is not loaded yet', () => {
    expect(itemImage('abc')).toBe('https://community.akamai.steamstatic.com/economy/image/abc/256fx192f');
    expect(itemImage('https://example.com/x.png')).toBe('https://example.com/x.png');
    const m = itemOf('skin-nope'); expect(m.value).toBe(0); expect(m.id).toBe('skin-nope');
    expect(itemOf(ITEMS[0]!.id)).toBe(ITEMS[0]);
    expect(itemName({ ...ITEMS[0]!, st: true, wear: 'FT', weapon: 'AK-47', skin: 'Redline' })).toBe('StatTrak\u2122 AK-47 | Redline (Field-Tested)');
  });
});

describe('cases', () => {
  const all = [...CASES, ...REWARD_CASES];

  it('registers every case by id', () => {
    expect(Object.keys(CASE).sort()).toEqual(all.map(c => c.id).sort());
  });

  it.each(all.map(c => [c.id, c] as const))('%s: ticket ranges cover 0..99,999 exactly once', (_id, c) => {
    const sorted = [...c.entries].sort((a, b) => a.from - b.from);
    expect(sorted[0]?.from).toBe(0);
    for (let i = 1; i < sorted.length; i++) expect((sorted[i] as typeof sorted[number]).from).toBe((sorted[i - 1] as typeof sorted[number]).to + 1);
    expect(sorted[sorted.length - 1]?.to).toBe(99999);
  });

  it.each(all.map(c => [c.id, c] as const))('%s: chances sum to 1 and the price keeps the 90% return', (_id, c) => {
    expect(c.entries.reduce((s, e) => s + e.chance, 0)).toBeCloseTo(1, 10);
    const exact = c.entries.reduce((s, e) => s + ((e.to - e.from + 1) / 100000) * e.item.value, 0) / c.price;
    expect(exact).toBeGreaterThan(HOUSE.cases - 0.02);
    expect(exact).toBeLessThan(HOUSE.cases + 0.02);
  });

  it('fixed-odds cases hit their advertised chances', () => {
    const fox = CASE.fox33!;
    expect(fox.entries.map(e => e.chance).sort()).toEqual([0.33, 0.33, 0.34]);
    expect(fox.entries.find(e => e.item.skin === 'Redline')!.chance).toBeCloseTo(0.33, 10);
    const p10 = CASE.phantom10!.entries.map(e => e.chance).sort((x, y) => x - y);
    expect(p10[0]).toBeCloseTo(0.1, 10); expect(p10[2]).toBeCloseTo(0.6, 10);
  });

  it('maps a roll to the entry that owns its ticket, at both ends', () => {
    const c = CASE.starter!;
    expect(ticketOf(0)).toBe(0);
    expect(ticketOf(0.99999999)).toBe(99999);
    expect(entryForTicket(c, 0)).toBe(c.entries[0]);
    expect(entryForTicket(c, 99999).to).toBe(99999);
    for (const e of c.entries) expect(entryForTicket(c, e.from)).toBe(e);
  });
});

describe('the cases and their pictures', () => {
  const all = [...CASES, ...REWARD_CASES];
  const NEW = ['duel', 'glockgal', 'silentclub', 'heavyduty', 'smgstorm', 'riflerush', 'fadeneon', 'dragons', 'akdynasty', 'm4legends', 'awpacademy', 'wrappedup', 'flipgut', 'hunters', 'driverseat', 'specialist', 'sportsclub',
    'bayonetclub', 'dopplerhall', 'crimsoncrown', 'legends', 'blackmarket', 'karambit', 'butterfly', 'millionaire'];
  it('has a picture file for every case, one each', () => {
    for (const c of all) { expect(c.img, c.id).toBe(`assets/cases/${c.id}.webp`); expect(existsSync(`public/assets/cases/${c.id}.webp`), c.id).toBe(true); }
  });
  it('has the 25 high-stakes cases, each priced from 20 to 1,000 coins, cheapest to dearest in the order they are made', () => {
    expect(NEW).toHaveLength(25);
    const prices = NEW.map(id => CASE[id]!.price);
    for (const p of prices) { expect(p).toBeGreaterThanOrEqual(20); expect(p).toBeLessThanOrEqual(1000); }
    for (let i = 1; i < prices.length; i++) expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
    expect(CASES.filter(c => c.price >= 20 && c.price <= 1000).length).toBeGreaterThanOrEqual(33);   // the 25 plus the 8 older cases in that range
  });
  it('gives each high-stakes case 10 real items, an exciting top drop and no item twice', () => {
    for (const id of NEW) {
      const c = CASE[id]!;
      expect(c.entries, id).toHaveLength(10);
      expect(new Set(c.entries.map(e => e.item.id)).size, id).toBe(10);
      expect(c.entries[0]!.item.value, id).toBeGreaterThan(c.price);                         // the best item is worth more than the case costs
    }
  });
  it('keeps the case ids unique', () => { expect(new Set(all.map(c => c.id)).size).toBe(all.length); });
});
