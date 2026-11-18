import { describe, expect, it } from 'vitest';
import { bigWins, freeRewardStats, gameRows, totalPlayed } from '../src/profile-stats.js';
import { credit, debit, recordBet, resetAccount, state } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { beforeEach } from 'vitest';
import { newGameState } from '../src/state.js';

describe('free reward stats', () => {
  it('splits coin bonuses by source and counts item rewards as free cases', () => {
    const s = newGameState();
    s.tx.push(
      { id: 1, type: 'Free coins', amount: 25, note: '', at: 0 }, { id: 2, type: 'Free coins', amount: 25, note: '', at: 0 },
      { id: 3, type: 'Rakeback (daily)', amount: 1.5, note: '', at: 0 }, { id: 4, type: 'Promo code VAULT10', amount: 10, note: '', at: 0 },
      { id: 5, type: 'Login calendar, day 2', amount: 2, note: '', at: 0 }, { id: 6, type: 'Coin rain', amount: 3.25, note: '', at: 0 },
      { id: 7, type: 'Race prize', amount: 400, note: '', at: 0 }, { id: 8, type: 'Welcome gift', amount: 0.4, note: 'Hornet SMG | Grid Rot', at: 0 },
      { id: 9, type: 'Payout (sandbox)', amount: -50, note: 'No money moved', at: 0 });
    expect(freeRewardStats(s)).toEqual({ freeCoins: 50, rakeback: 1.5, promos: 10, calendar: 2, rain: 3.25, race: 400, total: 466.75, freeCases: 2 });
  });
  it('is all zeros for a new player', () => {
    expect(freeRewardStats(newGameState())).toMatchObject({ total: 0, freeCases: 0 });
  });
});

describe('per-game stats and big wins', () => {
  beforeEach(() => { resetAccount(); confirmAge(state.rg); });
  it('accumulates lifetime totals and best results per game, independent of the capped history', () => {
    state.kyc.tier = 1;
    for (const [game, amount, multi] of [['Crash', 10, 0], ['Crash', 10, 3], ['Mines', 5, 12.5], ['Crash', 20, 1.5]] as [string, number, number][]) {
      debit(amount); credit(amount * multi);
      recordBet({ game, amount, multi, payout: amount * multi });
    }
    const rows = gameRows(state);
    expect(rows.map(r => r.game)).toEqual(['Crash', 'Mines']);                 // sorted by amount wagered
    expect(rows[0]).toMatchObject({ bets: 3, wagered: 40, paid: 60, bestPayout: 30, bestMulti: 3 });
    expect(rows[1]).toMatchObject({ bets: 1, wagered: 5, paid: 62.5, bestPayout: 62.5, bestMulti: 12.5 });
    expect(totalPlayed(state)).toBe(45);
    expect(bigWins(state)).toEqual({ biggest: { game: 'Mines', payout: 62.5, multi: 12.5 }, bestMulti: { game: 'Mines', multi: 12.5, payout: 62.5 } });
  });
  it('has no big wins before any winning bet', () => {
    expect(bigWins(newGameState())).toEqual({ biggest: null, bestMulti: null });
    const s = newGameState(); s.gameStats['Crash'] = { bets: 2, wagered: 4, paid: 0, bestPayout: 0, bestMulti: 0 };
    expect(bigWins(s).biggest).toBeNull();
  });
});
