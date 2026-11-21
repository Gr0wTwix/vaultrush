// Crash pace and the number on screen: slower than before, and shown a little behind the server and never past what the server last confirmed, so it can
// not climb beyond the number a round then crashes at.
import { describe, expect, it } from 'vitest';
import { CRASH_GROWTH } from '../src/fair.js';
import { DISPLAY_LAG_MS, liveElapsed } from '../src/rounds.js';

describe('the pace', () => {
  it('is slower than the old pace (0.00012): 2x takes about 8.7 s, 10x about 29 s', () => {
    expect(CRASH_GROWTH).toBeLessThan(0.00012);
    expect(Math.log(2) / CRASH_GROWTH / 1000).toBeGreaterThan(8); expect(Math.log(2) / CRASH_GROWTH / 1000).toBeLessThan(9.5);
    expect(Math.log(10) / CRASH_GROWTH / 1000).toBeGreaterThan(27); expect(Math.log(10) / CRASH_GROWTH / 1000).toBeLessThan(31);
  });
});

describe('the number shown during a shared round', () => {
  const start = 1_000_000;
  it('runs a little behind the server clock when answers keep coming', () => {
    expect(liveElapsed(start + 5000, start + 5000, start)).toBe(5000 - DISPLAY_LAG_MS);
    expect(liveElapsed(start + 5000, start + 9999, start)).toBe(5000 - DISPLAY_LAG_MS);       // confirmations ahead of the clock never speed it up
  });
  it('never goes past the last moment the server confirmed the round was still running', () => {
    for (const stale of [0, 100, 300, 800, 2000]) expect(liveElapsed(start + 6000, start + 6000 - stale, start)).toBeLessThanOrEqual(6000 - stale);
    // the page stopped hearing from the server for 3 s: the number holds where the server last said all was well, it does not run on
    expect(liveElapsed(start + 9000, start + 6000, start)).toBe(6000);
  });
  it('is zero before the round has started, and never negative', () => {
    expect(liveElapsed(start - 500, start - 500, start)).toBe(0); expect(liveElapsed(start + 100, start + 100, start)).toBe(0);
  });
  it('so a crash noticed late never finds the number already past the crash point', () => {
    const crashAt = start + 2000;                                                                   // the round crashes 2 s in, at e^(rate x 2000)
    for (const noticed of [200, 400, 700]) {                                                         // how late the page learns about it
      const shownTime = liveElapsed(crashAt + noticed, crashAt - 1, start);                          // the last answer said "still running" just before the crash
      expect(Math.exp(CRASH_GROWTH * shownTime)).toBeLessThanOrEqual(Math.exp(CRASH_GROWTH * 2000));
    }
  });
});
