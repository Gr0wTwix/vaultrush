// The maths of a case battle that both the page and the tests rely on: the formats, and who wins each mode.
// The database has its own port of decide() (battle_outcome in supabase/migrations/0011_live_wallet.sql, which pays the winners);
// tests/wallet-live-db.test.ts checks the two against each other on real draws, so a change here must be made there too.
import { pickWeighted } from './fair.js';
import type { Item } from './types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Each winner's share of the pot, rounded to the cent the way the database does (half a cent rounds up). The server pays this exact amount. */
export const shareOf = (pot: number, winners: number): number => Math.floor(Math.round(pot * 100) / winners + 0.5) / 100;

export const FORMATS: Record<string, { size: number; label: string; teams?: number[][] }> = {
  '1v1': { size: 2, label: '1v1' },
  '1v1v1': { size: 3, label: '3-way' },
  '1v1v1v1': { size: 4, label: '4-way' },
  '6way': { size: 6, label: '6-way' },
  '2v2': { size: 4, label: '2v2', teams: [[0, 1], [2, 3]] },
  '3v3': { size: 6, label: '3v3', teams: [[0, 1, 2], [3, 4, 5]] },
};

/** Decide the winners. Returns { winners: [player idx], scores, points, weights }. */
export function decide(mode: string, format: string, results: Pick<Item, 'value'>[][], extraF: number): any {
  const P = results.length, R = results[0].length;
  const totals = results.map(row => round2(row.reduce((s, it) => s + it.value, 0)));
  const last = results.map(row => row[R - 1].value);
  const tie = (idx: number[]): number[] => (idx.length === 1 ? idx : [idx[Math.min(idx.length - 1, Math.floor(extraF * idx.length))]]);
  const best = (vals: number[], low: boolean): number[] => { const t = low ? Math.min(...vals) : Math.max(...vals); return vals.map((v, i) => (v === t ? i : -1)).filter(i => i >= 0); };
  const teams = FORMATS[format]?.teams;

  if (teams) {
    const vals = mode === 'terminal' ? last : totals;
    const teamScores = teams.map(t => round2(t.reduce((s, i) => s + vals[i], 0)));
    const winTeam = tie(best(teamScores, mode === 'crazy'))[0];
    return { winners: teams[winTeam], totals, teamScores, winTeam };
  }
  switch (mode) {
    case 'group': return { winners: [...Array(P).keys()], totals };
    case 'terminal': return { winners: tie(best(last, false)), totals };
    case 'crazy': return { winners: tie(best(totals, true)), totals };
    case 'jackpot':
    case 'crazyjackpot': {
      const weights = totals.map(t => (mode === 'jackpot' ? Math.max(t, 0.01) : 1 / (t + 0.05)));
      const sum = weights.reduce((a, b) => a + b, 0);
      const w = pickWeighted<{ i: number; weight: number }>(weights.map((weight, i) => ({ i, weight })), extraF).i;
      return { winners: [w], totals, chances: weights.map(x => x / sum) };
    }
    case 'pointrush': {
      const points: number[] = Array(P).fill(0);
      for (let r = 0; r < R; r++) best(results.map(row => row[r].value), false).forEach(i => points[i]++);
      return { winners: tie(best(points, false)), totals, points };
    }
    default: return { winners: tie(best(totals, false)), totals };
  }
}

