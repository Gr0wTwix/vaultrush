import { beforeEach, describe, expect, it } from 'vitest';
import { confirmAge } from '../src/rg.js';
import {
  START_BALANCE, XP_PER_COIN, credit, debit, debitError, grant, isExcluded, level, levelFromXp, logTx, recordBet,
  resetAccount, round2, state, xpForLevel, addItems, removeItems,
} from '../src/state.js';

beforeEach(() => { resetAccount(); confirmAge(state.rg); });

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
    state.kyc.tier = 2;                                       // out of the way of the unverified bet cap
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

describe('verification cap and responsible-gambling gate', () => {
  it('explains a bet that is above the unverified cap, and lifts it with verification', () => {
    state.balance = 1000;
    expect(debit(51)).toBe(false);
    expect(debitError(51)).toMatch(/higher verification level/);
    state.kyc.tier = 1;
    expect(debit(51)).toBe(true);
  });
  it('blocks all bets until the player confirms they are 18+', () => {
    resetAccount();
    expect(debit(1)).toBe(false);
    expect(debitError(1)).toMatch(/18/);
  });
  it('tracks stakes and settled results for the limits', () => {
    debit(10);
    recordBet({ game: 'Crash', amount: 10, multi: 0, payout: 0 });
    const day = Object.values(state.rg.days)[0];
    expect(day).toEqual({ staked: 10, wagered: 10, paid: 0 });
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

describe('separate accounts on one browser', () => {
  it('each account keeps its own coins, and signing out shows a blank state', async () => {
    const { state, setAuthed, save } = await import('../src/state.js');
    localStorage.clear();
    setAuthed(true, 'c-alice'); expect(state.balance).toBe(100);
    state.balance = 7; save();
    setAuthed(false); expect(state.balance).toBe(0);
    setAuthed(true, 'c-bob'); expect(state.balance).toBe(100);   // not Alice's 7
    state.balance = 55; save();
    setAuthed(true, 'c-alice'); expect(state.balance).toBe(7);   // switching straight to another person reloads that person
    setAuthed(true, 'c-bob'); expect(state.balance).toBe(55);
    setAuthed(true, '');                                          // restore the shared default for other tests
  });

  it('each account has its own provably fair seeds', async () => {
    const { useFairFor, getFair } = await import('../src/fair.js');
    localStorage.clear();
    const a = (await useFairFor('c-alice')).serverSeed;
    const b = (await useFairFor('c-bob')).serverSeed;
    expect(a).not.toBe(b);
    expect((await useFairFor('c-alice')).serverSeed).toBe(a);
    expect(getFair().serverSeed).toBe(a);
  });
});
