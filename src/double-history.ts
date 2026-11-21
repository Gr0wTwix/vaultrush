// The "Previous rounds" strip and the "Last 100" counts of the Double page: what each result looks like, how finished rounds are added (once each) and how the
// saved results from the server are merged in behind them. Pure functions, tested in tests/double-history.test.ts.
import { doubleColor } from './fair.js';
import type { DoubleColor } from './types.js';

/** The two tiles beside green. A bait tile is also purple (tile 1) or gray (tile 14), so it wins that colour lane and the bait lane. */
export const isBait = (n: number): boolean => n === 1 || n === 14;
export const HISTORY_MAX = 100;

/** How a result is drawn in the strip: a bait result shows the hook (with its colour as a small dot), every other result its colour. */
export interface Chip { kind: 'bait' | DoubleColor; color: DoubleColor; title: string }
export function chipOf(n: number): Chip {
  const color = doubleColor(n);
  return isBait(n) ? { kind: 'bait', color, title: `Bait (also ${color}), tile ${n}` } : { kind: color, color, title: `${color[0]!.toUpperCase()}${color.slice(1)}, tile ${n}` };
}

/** How many of these results each lane has won. A bait result counts for the bait lane AND for its colour, so the four numbers can add up to more than the results. */
export function laneCounts(results: number[]): Record<'purple' | 'gray' | 'green' | 'bait', number> {
  const c = { purple: 0, gray: 0, green: 0, bait: 0 };
  for (const n of results) { c[doubleColor(n)]++; if (isBait(n)) c.bait++; }
  return c;
}

/** A finished shared round goes to the front of the history, once: false if it was already there. */
export function addRound(history: number[], seen: Set<number>, id: number, n: number): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  history.unshift(n);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  return true;
}

/**
 * Older results from the server (newest first). Rounds already in the history are skipped by id, the rest are put BEHIND what is there, so it does not matter
 * whether the page saw the latest round before or after the saved list arrived: no round is missing and none is shown twice.
 */
export function mergeRecent(history: number[], seen: Set<number>, rows: { id: number; v: number }[]): void {
  for (const r of rows) {
    if (seen.has(r.id) || history.length >= HISTORY_MAX) continue;
    seen.add(r.id);
    history.push(r.v);
  }
}
