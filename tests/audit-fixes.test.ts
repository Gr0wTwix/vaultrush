// Regression tests for the defects found in the full-site audit of 2026-11-22 (browser-only mode).
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { localStorage.clear(); vi.resetModules(); document.body.innerHTML = ''; });

describe('a damaged save', () => {
  it('loads with every list field as a list and a numeric balance, so the games keep working', async () => {
    localStorage.setItem('vaultrush.state.v1', JSON.stringify({ balance: 'lots', history: 'oops', tx: null, promos: 7, inv: [null, { uid: 'a', id: 'old-invented-item', at: 1 }], name: 'Kept' }));
    const { state, recordBet } = await import('../src/state.js');
    expect(Array.isArray(state.history)).toBe(true); expect(Array.isArray(state.tx)).toBe(true); expect(Array.isArray(state.promos)).toBe(true);
    expect(state.inv).toEqual([]); expect(state.balance).toBe(100); expect(state.name).toBe('Kept');
    expect(() => recordBet({ game: 'Plinko', amount: 1, multi: 0.5, payout: 0.5 })).not.toThrow();
  });
  it('that is not an object at all starts fresh', async () => {
    localStorage.setItem('vaultrush.state.v1', 'null');
    const { state } = await import('../src/state.js');
    expect(state.balance).toBe(100); expect(state.history).toEqual([]);
  });
});

describe('selling an item without the server wallet', () => {
  it('pays the item value once, logs an "Item sale" transaction and does not count it as winnings', async () => {
    const { state, addItems, resetAccount } = await import('../src/state.js');
    const { ITEMS } = await import('../src/data.js');
    const { render } = await import('../src/views/inventory.js');
    resetAccount();
    const item = ITEMS.find(i => i.value > 0)!;
    addItems([item]);
    const before = state.balance, won = state.stats.won;
    document.body.innerHTML = '<div id="toasts"></div><main id="view"></main>';
    const el = document.getElementById('view')!;
    render(el);
    const sell = el.querySelector('.sell') as HTMLButtonElement;
    sell.click(); sell.click();                                                              // a double click pays once
    await new Promise(r => setTimeout(r, 0));
    expect(state.balance).toBeCloseTo(before + item.value, 2);
    expect(state.inv).toHaveLength(0);
    expect(state.stats.won).toBe(won);
    expect(state.tx[0]).toMatchObject({ type: 'Item sale', amount: item.value });
  });
});
