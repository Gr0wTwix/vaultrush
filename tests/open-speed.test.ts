// Case opening: a normal length and a fast open (the lightning button next to Demo spin), which also applies to demo spins and is remembered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_MS, openMs } from '../src/ui.js';
import { resetAccount, state } from '../src/state.js';
import { renderCase } from '../src/views/cases.js';

describe('the two opening lengths', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('normal by default, fast between the old Fast and Turbo, and the quickest for people who ask for less motion', () => {
    resetAccount();
    expect(state.ui.fastOpen).toBe(false); expect(openMs()).toBe(OPEN_MS.normal);
    state.ui.fastOpen = true; expect(openMs()).toBe(OPEN_MS.fast);
    expect(OPEN_MS.fast).toBeLessThan(2600); expect(OPEN_MS.fast).toBeGreaterThan(1200);        // in between what Fast (2.6 s) and Turbo (1.2 s) were
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(openMs()).toBe(OPEN_MS.reduced);
  });
});

describe('the lightning button on the case page', () => {
  let el: HTMLElement, leave: (() => void) | void;
  const demo = async (ms: number): Promise<boolean> => { (el.querySelector('#demoBtn') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(ms); return !!el.querySelector('.reel-won'); };
  beforeEach(() => {
    vi.useFakeTimers(); document.body.innerHTML = '<div id="toasts"></div>'; resetAccount();
    el = document.createElement('div'); document.body.append(el); leave = renderCase(el, 'starter');
  });
  afterEach(() => { if (typeof leave === 'function') leave(); vi.useRealTimers(); document.body.innerHTML = ''; });

  it('sits right after Demo spin, is off by default, and there is no speed selector any more', () => {
    const demoBtn = el.querySelector('#demoBtn') as HTMLElement, fast = el.querySelector('#fastBtn') as HTMLElement;
    expect(demoBtn.nextElementSibling).toBe(fast);
    expect(fast.getAttribute('aria-pressed')).toBe('false'); expect(fast.classList.contains('on')).toBe(false);
    expect(fast.querySelector('svg')).not.toBeNull();                                           // the lightning icon
    expect(el.querySelector('.speed-seg')).toBeNull();
  });
  it('turns on and off, and remembers the choice', () => {
    const fast = el.querySelector('#fastBtn') as HTMLElement;
    fast.click();
    expect(state.ui.fastOpen).toBe(true); expect(fast.getAttribute('aria-pressed')).toBe('true'); expect(fast.classList.contains('on')).toBe(true);
    fast.click();
    expect(state.ui.fastOpen).toBe(false); expect(fast.getAttribute('aria-pressed')).toBe('false');
  });
  it('a demo spin is quick with the lightning on and takes its time without it', async () => {
    (el.querySelector('#fastBtn') as HTMLElement).click();
    expect(await demo(OPEN_MS.fast + 400)).toBe(true);                                          // done within about two seconds
    expect((el.querySelector('#demoBtn') as HTMLButtonElement).disabled).toBe(false);
    (el.querySelector('#fastBtn') as HTMLElement).click();                                      // off again
    expect(await demo(OPEN_MS.fast + 400)).toBe(false);                                         // the same wait is not enough any more
    await vi.advanceTimersByTimeAsync(OPEN_MS.normal);
    expect(el.querySelector('.reel-won')).not.toBeNull();
  });
});
