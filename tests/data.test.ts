import { describe, expect, it } from 'vitest';
import { CASE, CASES, ITEM, ITEMS, REWARD_CASES, RARITY, entryForTicket, ticketOf } from '../src/data.js';
import { HOUSE } from '../src/fair.js';

describe('item catalog', () => {
  it('has unique ids, positive values and a known rarity for every item', () => {
    expect(new Set(ITEMS.map(i => i.id)).size).toBe(ITEMS.length);
    for (const i of ITEMS) {
      expect(i.value).toBeGreaterThan(0);
      expect(RARITY[i.rarity]).toBeDefined();
      expect(ITEM[i.id]).toBe(i);
    }
  });
  it('only gives wear to weapons and knives', () => {
    for (const i of ITEMS) if (['charm', 'gear', 'tool'].includes(i.type)) expect(i.wear).toBe('');
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
    const chance = (id: string) => fox.entries.find(e => e.item.id === id)!.chance;
    expect(chance('x28')).toBeCloseTo(0.33, 2);
    expect(chance('x44')).toBeCloseTo(0.34, 2);
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
