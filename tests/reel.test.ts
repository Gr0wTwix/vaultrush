// The case-opening reel: a real deceleration curve (races through the case, slows to a crawl, stops with no speed left) and a landing with no snap at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sfx.js', () => ({ sfx: { tick: vi.fn(), click: vi.fn(), win: vi.fn(), lose: vi.fn(), big: vi.fn() } }));
import { sfx } from '../src/sfx.js';
import { ITEMS } from '../src/data.js';
import { reelProgress, spinReel } from '../src/ui.js';

describe('the reel curve', () => {
  const at = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => reelProgress(i / n));
  it('starts at 0, ends at exactly 1, and never goes backwards', () => {
    const p = at(500);
    expect(p[0]).toBe(0); expect(p[500]).toBe(1);
    for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 1]!);
    expect(reelProgress(-1)).toBe(0); expect(reelProgress(2)).toBe(1);
  });
  it('races early and crawls late: most of the distance in the first half, a gentle last stretch', () => {
    expect(reelProgress(0.5)).toBeGreaterThan(0.78);          // more than three quarters of the way by half time
    expect(reelProgress(0.5)).toBeLessThan(0.92);             // but not all of it: it is still moving visibly
    const lastFifth = 1 - reelProgress(0.8), lastTenth = 1 - reelProgress(0.9);
    expect(lastFifth).toBeLessThan(0.03); expect(lastFifth).toBeGreaterThan(0.002);      // the last fifth of the time is a crawl over a few tiles at most
    expect(lastTenth).toBeLessThan(0.006);
  });
  it('has no jump anywhere and no speed left at the end (it stops, it does not snap)', () => {
    const n = 2000, p = at(n), steps = p.slice(1).map((v, i) => v - p[i]!);
    expect(Math.max(...steps)).toBeLessThan(0.0035);                      // the fastest moment is a smooth sweep, not a jump
    expect(steps[steps.length - 1]!).toBeLessThan(steps[Math.floor(n * 0.3)]! / 200);          // the last step is almost nothing
    const early = steps.slice(0, 60), peak = Math.max(...steps);
    expect(early[0]!).toBeLessThan(peak / 5);                              // it picks up speed instead of starting at full speed
  });
});

describe('spinning a reel', () => {
  let host: HTMLElement;
  const STEP = 148, SIZE = 140, VIEW = 700;
  beforeEach(() => {
    // happy-dom has no layout: give the tiles a width and a position like the real page does
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = this.parentElement?.classList.contains('reel-strip') ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: i * STEP, top: 0, right: i * STEP + SIZE, bottom: 0, width: SIZE, height: 100, x: i * STEP, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return SIZE; } });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return VIEW; } });
    document.body.innerHTML = '<div id="host"></div>'; host = document.getElementById('host') as HTMLElement;
    vi.mocked(sfx.tick).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as any).offsetWidth; delete (HTMLElement.prototype as any).clientWidth; });

  const pool = ITEMS.slice(0, 8).map(item => ({ item, weight: 1 }));
  const x = (): number => { const m = /translate3d\((-?[\d.]+)px/.exec((host.querySelector('.reel-strip') as HTMLElement).style.transform); return m ? parseFloat(m[1] as string) : 0; };

  it('lands exactly under the marker on the winning tile, with no correction move at the end, and then lights the winner', async () => {
    const winner = ITEMS[20]!, seen: number[] = [];
    const strip = (): HTMLElement => host.querySelector('.reel-strip') as HTMLElement;
    const p = spinReel(host, pool, winner, { duration: 600, sound: true });
    const tm = setInterval(() => seen.push(x()), 8);
    await p; clearInterval(tm);
    const final = x(), centre = VIEW / 2 - (46 * STEP + SIZE / 2);                   // the winner sits at index 46 of 56
    expect(Math.abs(final - centre)).toBeLessThanOrEqual(SIZE * 0.3);                // inside the winning tile, away from its edges
    expect(strip().style.transition).toBe('none');                                   // one moving transform, nothing animating on the side
    expect(host.classList.contains('settled')).toBe(true);
    expect(host.querySelectorAll('.reel-won')).toHaveLength(1);
    expect(host.classList.contains('spinning')).toBe(false);
    // the strip only ever moved one way and never jumped back or forward at the end
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]! + 1e-6);
    const tail = seen.slice(-5); expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(40);
  });
  it('ticks once for every tile that passes the marker', async () => {
    await spinReel(host, pool, ITEMS[5]!, { duration: 500, sound: true });
    const n = vi.mocked(sfx.tick).mock.calls.length;
    expect(n).toBeGreaterThan(35); expect(n).toBeLessThanOrEqual(47);             // about 46 tiles go by
    vi.mocked(sfx.tick).mockClear();
    await spinReel(host, pool, ITEMS[5]!, { duration: 300, sound: false });
    expect(sfx.tick).not.toHaveBeenCalled();
  });
  it('shows no big glow blobs: the glow is contained in its tile', () => {
    void spinReel(host, pool, ITEMS[1]!, { duration: 100 });
    expect(host.querySelectorAll('.reel-cell.bare .bare-glow').length).toBe(56);
  });
});
