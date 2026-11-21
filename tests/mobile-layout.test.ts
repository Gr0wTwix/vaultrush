// The phone fixes of 2026-11-21: the page scrolls to the arena or the reels when a battle or an opening starts (the phone styles are checked in mobile-css.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bringIntoView } from '../src/ui.js';

const node = (top: number): Element => ({ getBoundingClientRect: () => ({ top }) }) as unknown as Element;
function env(o: { small: boolean; calm?: boolean; scrollY?: number; height?: number }): ReturnType<typeof vi.fn> {
  const scrollTo = vi.fn();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width') ? o.small : !!o.calm }));
  vi.stubGlobal('scrollTo', scrollTo); vi.stubGlobal('scrollY', o.scrollY ?? 100); vi.stubGlobal('innerHeight', o.height ?? 800);
  return scrollTo;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('bringIntoView', () => {
  it('on a phone, scrolls the page so the node sits just under the top bar', () => {
    const scrollTo = env({ small: true });
    bringIntoView(node(600));
    expect(scrollTo).toHaveBeenCalledWith({ top: 100 + 600 - 78, behavior: 'smooth' });
  });
  it('does not move the page on wide screens, or when the top of the node is already in view, or when there is no node', () => {
    let scrollTo = env({ small: false }); bringIntoView(node(600)); expect(scrollTo).not.toHaveBeenCalled();
    scrollTo = env({ small: true }); bringIntoView(node(200)); expect(scrollTo).not.toHaveBeenCalled();
    bringIntoView(null); bringIntoView(undefined); expect(scrollTo).not.toHaveBeenCalled();
  });
  it('scrolls without animation when the player asked for less motion, and never above the top of the page', () => {
    const scrollTo = env({ small: true, calm: true, scrollY: 0 });
    bringIntoView(node(40));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });
  it('never throws, so a game cannot break because scrolling failed', () => {
    env({ small: true }); vi.stubGlobal('scrollTo', () => { throw new Error('no scrolling here'); });
    expect(() => bringIntoView(node(600))).not.toThrow();
  });
});

import { ROUND_PAUSE, roundPauseMs } from '../src/ui.js';
import { state } from '../src/state.js';

describe('the pause between battle rounds', () => {
  it('rests long enough to read what was pulled, longer on slower speeds, and the old 400 ms is gone', () => {
    expect(ROUND_PAUSE.normal).toBeGreaterThan(ROUND_PAUSE.fast); expect(ROUND_PAUSE.fast).toBeGreaterThan(ROUND_PAUSE.turbo);
    expect(ROUND_PAUSE.turbo).toBeGreaterThanOrEqual(800); expect(ROUND_PAUSE.normal).toBeGreaterThanOrEqual(2000);
    for (const s of ['normal', 'fast', 'turbo'] as const) { state.speed = s; expect(roundPauseMs()).toBe(ROUND_PAUSE[s]); }
    (state as { speed: string }).speed = 'unknown'; expect(roundPauseMs()).toBe(ROUND_PAUSE.normal);
  });
});
