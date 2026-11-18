// Numbers shown on the Account overview (free-reward totals, per-game stats, big wins). Pure functions over the player's state.
import type { GameState, GameStat } from './types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sum = (xs: number[]): number => round2(xs.reduce((a, b) => a + b, 0));

export interface FreeRewardStats { total: number; freeCoins: number; rakeback: number; promos: number; calendar: number; rain: number; race: number; freeCases: number }
/** Coins received without paying for them, split by source. Item rewards (those with a note) are counted separately as free cases. */
export function freeRewardStats(s: GameState): FreeRewardStats {
  const coins = s.tx.filter(t => !t.note && t.amount > 0);
  const by = (re: RegExp): number => sum(coins.filter(t => re.test(t.type)).map(t => t.amount));
  const r = { freeCoins: by(/^free coins/i), rakeback: by(/^rakeback/i), promos: by(/^promo/i), calendar: by(/calendar/i), rain: by(/rain/i), race: by(/race prize/i) };
  return { ...r, total: sum(Object.values(r)), freeCases: s.tx.filter(t => !!t.note).length };
}

export interface GameRow extends GameStat { game: string }
export function gameRows(s: GameState): GameRow[] {
  return Object.entries(s.gameStats).map(([game, g]) => ({ game, ...g })).sort((a, b) => b.wagered - a.wagered);
}
export const totalPlayed = (s: GameState): number => sum(Object.values(s.gameStats).map(g => g.wagered));

export interface BigWins { biggest: { game: string; payout: number; multi: number } | null; bestMulti: { game: string; multi: number; payout: number } | null }
export function bigWins(s: GameState): BigWins {
  const rows = gameRows(s).filter(r => r.bestPayout > 0);
  const pay = [...rows].sort((a, b) => b.bestPayout - a.bestPayout)[0], mul = [...rows].sort((a, b) => b.bestMulti - a.bestMulti)[0];
  return {
    biggest: pay ? { game: pay.game, payout: pay.bestPayout, multi: pay.bestMulti } : null,
    bestMulti: mul ? { game: mul.game, multi: mul.bestMulti, payout: mul.bestPayout } : null,
  };
}
