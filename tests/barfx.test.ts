// The balance / inventory chip in the top bar glows green only when something was ADDED. Before, any saved state made it glow, whatever the animation speed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET_MS, bumps, initBarFx } from '../src/barfx.js';
import { emit, resetAccount, state } from '../src/state.js';

describe('which changes deserve the glow', () => {
  const p = { bal: 100, inv: 2 };
  it('only an increase, and never while an account is being loaded', () => {
    expect(bumps(p, { bal: 100, inv: 2 }, true)).toEqual({ balance: false, inventory: false });        // nothing changed: the old bug glowed here
    expect(bumps(p, { bal: 100.004, inv: 2 }, true).balance).toBe(false);                               // rounding noise
    expect(bumps(p, { bal: 100.01, inv: 2 }, true).balance).toBe(true);
    expect(bumps(p, { bal: 90, inv: 1 }, true)).toEqual({ balance: false, inventory: false });          // a bet or a sale of an item is not a gain
    expect(bumps(p, { bal: 100, inv: 3 }, true).inventory).toBe(true);
    expect(bumps(p, { bal: 500, inv: 9 }, false)).toEqual({ balance: false, inventory: false });       // quiet: just signed in
  });
});

describe('the chip in the page', () => {
  let items = 0, stop: () => void;
  const chip = (): HTMLElement => document.getElementById('invCount') as HTMLElement;
  const pill = (): HTMLElement => document.querySelector('.balance') as HTMLElement;
  const tick = async (ms = 5): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
  const change = async (balance: number, inv = items): Promise<void> => { state.balance = balance; items = inv; emit('state', state); await tick(); };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<a class="balance"><span id="bal">100.00</span><span class="inv-count" id="invCount"><i></i><b>0</b></span></a>';
    resetAccount(); state.balance = 100; state.ui.fx = false; items = 0;
    stop = initBarFx(document, () => items);
  });
  afterEach(() => { stop(); vi.useRealTimers(); document.body.innerHTML = ''; });

  it('does not glow when the state is saved but nothing changed (a speed setting, a bet that took nothing, any page saving)', async () => {
    for (let i = 0; i < 5; i++) { emit('state', state); await tick(); }
    expect(pill().classList.contains('bump-up')).toBe(false); expect(chip().classList.contains('inv-bump')).toBe(false);
  });
  it('glows green on added coins, and shows the new number', async () => {
    await change(140.5);
    expect(pill().classList.contains('bump-up')).toBe(true);
    expect(document.getElementById('bal')!.textContent).toBe('140.50');
    expect(chip().classList.contains('inv-bump')).toBe(false);                      // the inventory chip is for items
  });
  it('does not glow when coins are spent', async () => {
    await change(60);
    expect(pill().classList.contains('bump-up')).toBe(false);
    expect(document.getElementById('bal')!.textContent).toBe('60.00');
  });
  it('glows the inventory chip when an item is added, not when one is sold', async () => {
    await change(100, 1);
    expect(chip().classList.contains('inv-bump')).toBe(true); expect(chip().querySelector('b')!.textContent).toBe('1');
    expect(pill().classList.contains('bump-up')).toBe(false);
    chip().classList.remove('inv-bump');
    await change(100, 0);
    expect(chip().classList.contains('inv-bump')).toBe(false); expect(chip().querySelector('b')!.textContent).toBe('0');
  });
  it('a sale glows both: coins added and an item gone only glows the coins', async () => {
    await change(100, 1); chip().classList.remove('inv-bump');
    await change(104.5, 0);
    expect(pill().classList.contains('bump-up')).toBe(true); expect(chip().classList.contains('inv-bump')).toBe(false);
  });
  it('replays the glow for the next gain', async () => {
    await change(110); pill().classList.remove('bump-up');
    await change(120);
    expect(pill().classList.contains('bump-up')).toBe(true);
  });
  it('is quiet while an account is being loaded, then works again', async () => {
    emit('auth', true);                                                                // signing in: the balance jumps from nothing to the real one
    await change(4434.86, 3);
    expect(pill().classList.contains('bump-up')).toBe(false); expect(chip().classList.contains('inv-bump')).toBe(false);
    expect(document.getElementById('bal')!.textContent).toBe('4,434.86'); expect(chip().querySelector('b')!.textContent).toBe('3');
    await tick(QUIET_MS + 100);
    await change(4440, 4);
    expect(pill().classList.contains('bump-up')).toBe(true); expect(chip().classList.contains('inv-bump')).toBe(true);
  });
  it('the first sync from the server is quiet too', async () => {
    emit('wallet:quiet');
    await change(125);
    expect(pill().classList.contains('bump-up')).toBe(false);
  });
  it('the glow does not depend on the animation speed of any game: the same one animation length for every gain', async () => {
    for (const speed of ['normal', 'fast', 'turbo'] as const) {
      state.speed = speed; pill().classList.remove('bump-up');
      await change(state.balance + 10);
      expect(pill().classList.contains('bump-up'), speed).toBe(true);
    }
  });
});
