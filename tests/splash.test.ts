// The loading screen (2026-11-25): drawn by index.html, removed by hideSplash() once the first page is drawn.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPLASH_FADE_MS, SPLASH_MIN_MS, hideSplash } from '../src/splash.js';

const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

describe('loading screen markup', () => {
  it('is in the page itself, before the app, with a spoken status', () => {
    expect(html.indexOf('id="splash"')).toBeGreaterThan(0);
    expect(html.indexOf('id="splash"')).toBeLessThan(html.indexOf('class="app"'));
    expect(html).toMatch(/id="splash" role="status"/);
    expect(html).toMatch(/<strong>Loading<\/strong>/);
  });
  it('uses no inline script (the security policy forbids it) and fades out by itself if no script runs', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/)/);
    expect(html).toMatch(/animation: splash-fallback [^;]*12s forwards/);
  });
  it('stops moving for people who ask for reduced motion', () => {
    expect(html).toMatch(/prefers-reduced-motion: reduce\)[^@]*\.splash-arc[^@]*animation: none/);
  });
  it('is removed once the first page is drawn, and also when start-up fails', () => {
    const app = readFileSync(resolve(__dirname, '..', 'src', 'app.ts'), 'utf8');
    expect(app).toMatch(/route\(\);\s*void hideSplash\(\);/);
    expect(app).toMatch(/boot\(\)\.catch\(err => \{[^}]*hideSplash\(\)/);
  });
});

describe('hideSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="splash" id="splash" role="status"></div><div class="app" aria-busy="true"></div>';
  });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps a fast load on screen until the minimum time, then fades and removes it', async () => {
    const done = hideSplash(200);
    vi.advanceTimersByTime(SPLASH_MIN_MS - 200 - 1);
    expect(document.querySelector('#splash')?.classList.contains('out')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.querySelector('#splash')?.classList.contains('out')).toBe(true);
    expect(document.querySelector('.app')?.hasAttribute('aria-busy')).toBe(false);
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    await done;
    expect(document.querySelector('#splash')).toBeNull();
  });

  it('fades at once after a slow load, and a second call does nothing', async () => {
    const done = hideSplash(SPLASH_MIN_MS + 500);
    vi.advanceTimersByTime(0);
    expect(document.querySelector('#splash')?.classList.contains('out')).toBe(true);
    await expect(hideSplash(5000)).resolves.toBeUndefined();
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    await done;
    expect(document.querySelector('#splash')).toBeNull();
  });
});
