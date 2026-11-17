import { beforeEach, describe, expect, it } from 'vitest';
import {
  START_BALANCE, XP_PER_COIN, credit, debit, debitError, grant, isExcluded, level, levelFromXp, logTx, recordBet,
  resetAccount, round2, state, xpForLevel, addItems, removeItems,
} from '../src/state.js';

beforeEach(() => { resetAccount(); });

describe('wallet', () => {
  it('starts with the demo balance', () => {
    expect(state.balance).toBe(START_BALANCE);
  });

  it('debits a bet, counts it as wagered and feeds XP and rakeback', () => {
    expect(debit(10)).toBe(true);
    expect(state.balance).toBe(90);
    expect(state.stats.wagered).toBe(10);
    expect(state.stats.bets).toBe(1);
    expect(state.xp).toBe(10 * XP_PER_COIN);
    expect(state.rakeback.instant).toBeCloseTo(0.04, 10);
    expect(state.race.wagered).toBe(10);
  });

  it('refuses a bet that is invalid or larger than the balance and changes nothing', () => {
    for (const bad of [0, -5, NaN, START_BALANCE + 0.01]) expect(debit(bad)).toBe(false);
    expect(state.balance).toBe(START_BALANCE);
    expect(state.stats.bets).toBe(0);
    expect(debitError(1000)).toMatch(/Not enough coins/);
    expect(debitError(0)).toBe('Invalid amount');
  });

  it('pays winnings as won coins but bonuses only as balance plus a transaction', () => {
    credit(25);
    expect(state.balance).toBe(START_BALANCE + 25);
    expect(state.stats.won).toBe(25);
    grant(5, 'Promo code TEST');
    expect(state.balance).toBe(START_BALANCE + 30);
    expect(state.stats.won).toBe(25);
    expect(state.tx[0]).toMatchObject({ type: 'Promo code TEST', amount: 5 });
    credit(-3); credit(0);
    expect(state.balance).toBe(START_BALANCE + 30);
  });

  it('rounds money to cents', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    debit(0.333);
    expect(state.balance).toBe(99.67);
  });
});

describe('self-exclusion', () => {
  it('blocks every bet until it ends, with its own message', () => {
    state.excludedUntil = Date.now() + 60_000;
    expect(isExcluded()).toBe(true);
    expect(debit(1)).toBe(false);
    expect(state.balance).toBe(START_BALANCE);
    expect(debitError(1)).toMatch(/Self-exclusion/);
    state.excludedUntil = Date.now() - 1;
    expect(isExcluded()).toBe(false);
    expect(debit(1)).toBe(true);
  });
});

describe('levels', () => {
  it('xp thresholds and levels are inverses', () => {
    for (let l = 0; l < 60; l++) {
      expect(levelFromXp(xpForLevel(l))).toBe(l);
      expect(levelFromXp(xpForLevel(l + 1) - 1)).toBe(l);
    }
  });
  it('reports the level from state', () => {
    state.xp = xpForLevel(7);
    expect(level()).toBe(7);
  });
});

describe('records', () => {
  it('keeps numbered bet history (newest first) capped at 500', () => {
    for (let i = 0; i < 510; i++) recordBet({ game: 'Crash', amount: 1, multi: 0, payout: 0 });
    expect(state.history).toHaveLength(500);
    expect(state.history[0]?.id).toBe(510);
    expect(state.history[1]?.id).toBe(509);
  });
  it('numbers transactions sequentially and caps the log', () => {
    for (let i = 0; i < 310; i++) logTx('Test', 1);
    expect(state.tx).toHaveLength(300);
    expect((state.tx[0]?.id ?? 0) - (state.tx[1]?.id ?? 0)).toBe(1);
  });
  it('adds and removes inventory items by uid', () => {
    const [a, b] = addItems([{ id: 'p1' }, { id: 'p2' }]);
    expect(state.inv).toHaveLength(2);
    expect(a?.uid).not.toBe(b?.uid);
    removeItems([a!.uid]);
    expect(state.inv.map(i => i.id)).toEqual(['p2']);
  });
});

describe('reset', () => {
  it('restores the defaults', () => {
    debit(50); credit(5);
    resetAccount();
    expect(state.balance).toBe(START_BALANCE);
    expect(state.stats).toEqual({ wagered: 0, won: 0, bets: 0 });
    expect(state.history).toEqual([]);
  });
});
