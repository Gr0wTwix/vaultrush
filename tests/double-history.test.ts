// Double's "Previous rounds" strip and "Last 100" counts: a bait result is shown as bait (it used to look like a plain purple or gray tile), finished rounds are
// added once, and the saved results from the server are merged in behind them whichever arrives first.
import { describe, expect, it } from 'vitest';
import { HISTORY_MAX, addRound, chipOf, isBait, laneCounts, mergeRecent } from '../src/double-history.js';
import { doubleWins } from '../src/fair.js';

describe('what a result looks like', () => {
  it('knows the two bait tiles, beside green', () => {
    expect(isBait(1)).toBe(true); expect(isBait(14)).toBe(true);
    for (const n of [0, 2, 3, 7, 8, 13]) expect(isBait(n), String(n)).toBe(false);
  });
  it('shows a bait result as bait, with the colour of its tile', () => {
    expect(chipOf(1)).toMatchObject({ kind: 'bait', color: 'purple' });
    expect(chipOf(14)).toMatchObject({ kind: 'bait', color: 'gray' });
    expect(chipOf(1).title).toMatch(/bait/i); expect(chipOf(1).title).toMatch(/purple/);
  });
  it('shows every other result as its colour', () => {
    expect(chipOf(0)).toMatchObject({ kind: 'green', color: 'green' });
    expect(chipOf(3)).toMatchObject({ kind: 'purple', color: 'purple' });
    expect(chipOf(2)).toMatchObject({ kind: 'gray', color: 'gray' });
  });
  it('agrees with the game rules: a bait tile wins the bait lane and its colour lane', () => {
    for (let n = 0; n < 15; n++) expect(doubleWins('bait', n), String(n)).toBe(isBait(n));
    expect(doubleWins('purple', 1)).toBe(true); expect(doubleWins('gray', 14)).toBe(true);
  });
});

describe('the Last 100 counts', () => {
  it('counts a bait result for the bait lane and for its colour', () => {
    expect(laneCounts([1, 14, 2, 0, 3])).toEqual({ purple: 2, gray: 2, green: 1, bait: 2 });
    expect(laneCounts([])).toEqual({ purple: 0, gray: 0, green: 0, bait: 0 });
  });
  it('counts the 15 tiles once each: 7 purple, 7 gray, 1 green and 2 bait', () => {
    expect(laneCounts(Array.from({ length: 15 }, (_, n) => n))).toEqual({ purple: 7, gray: 7, green: 1, bait: 2 });
  });
});

describe('the history', () => {
  it('puts a finished round at the front, once', () => {
    const h: number[] = [], seen = new Set<number>();
    expect(addRound(h, seen, 10, 5)).toBe(true);
    expect(addRound(h, seen, 11, 1)).toBe(true);
    expect(addRound(h, seen, 11, 1)).toBe(false);                      // the same round arriving again changes nothing
    expect(h).toEqual([1, 5]);
  });
  it('keeps only the last 100', () => {
    const h: number[] = [], seen = new Set<number>();
    for (let id = 1; id <= HISTORY_MAX + 20; id++) addRound(h, seen, id, id % 15);
    expect(h).toHaveLength(HISTORY_MAX); expect(h[0]).toBe((HISTORY_MAX + 20) % 15);
  });
  it('merges the saved results behind what is there, newest first, without showing a round twice (the latest round arrived first)', () => {
    const h: number[] = [], seen = new Set<number>();
    addRound(h, seen, 12, 7);                                           // the page showed round 12 before the saved list arrived
    mergeRecent(h, seen, [{ id: 12, v: 7 }, { id: 11, v: 1 }, { id: 10, v: 0 }]);
    expect(h).toEqual([7, 1, 0]);
  });
  it('and the other way round (the saved list arrived first, then the page showed the same latest round and a newer one)', () => {
    const h: number[] = [], seen = new Set<number>();
    mergeRecent(h, seen, [{ id: 12, v: 7 }, { id: 11, v: 1 }]);
    addRound(h, seen, 12, 7);                                           // already there: not shown twice
    addRound(h, seen, 13, 14);                                          // a new round goes in front
    expect(h).toEqual([14, 7, 1]);
  });
  it('merging twice, or a list that overlaps the history, changes nothing more', () => {
    const h: number[] = [], seen = new Set<number>();
    const rows = [{ id: 3, v: 2 }, { id: 2, v: 4 }, { id: 1, v: 6 }];
    mergeRecent(h, seen, rows); mergeRecent(h, seen, rows);
    expect(h).toEqual([2, 4, 6]);
  });
  it('never grows past 100 when merging', () => {
    const h: number[] = [], seen = new Set<number>();
    mergeRecent(h, seen, Array.from({ length: 250 }, (_, i) => ({ id: 1000 - i, v: i % 15 })));
    expect(h).toHaveLength(HISTORY_MAX);
  });
});
