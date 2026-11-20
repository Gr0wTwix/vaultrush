// How the game page obeys the admin site's controls: a notice bar, a full-screen message for maintenance and blocked countries (with a grace
// minute when maintenance starts while someone is playing), paused games, closed sign-ups. A failed check must never close the site.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ status: {} as Record<string, unknown>, down: false, calls: 0 }));
vi.mock('../src/backend.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backend.js')>()),
  backendEnabled: () => true,
  call: async (fn: string) => { srv.calls++; if (srv.down) throw new Error('offline'); if (fn !== 'site_status') throw new Error('unexpected ' + fn); return JSON.parse(JSON.stringify(srv.status)); },
}));

import { GAME_OF_NAV, GRACE_MS, POLL_MS, applySiteUi, blockedBy, gameOff, initSite, pausedPanel, refreshSite, resetSite, signupsOpen, siteStatus } from '../src/site.js';
import { on } from '../src/state.js';

const OPEN = { maintenance: false, maintenance_message: '', notice: null, signups_open: true, games_off: [], country: null, country_blocked: false, staff: false };
const set = (o: Record<string, unknown>): void => { srv.status = { ...OPEN, ...o }; };
const overlay = (): HTMLElement | null => document.getElementById('siteBlock');
const bar = (): HTMLElement | null => document.getElementById('siteNotice');

beforeEach(() => {
  vi.useFakeTimers(); resetSite(); srv.down = false; srv.calls = 0; set({});
  document.body.innerHTML = '<div class="app"><header id="topbar"></header><main id="view"></main></div>';
});
afterEach(() => { resetSite(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('an open site', () => {
  it('shows nothing and blocks nothing', async () => {
    await initSite();
    expect(bar()).toBeNull(); expect(overlay()).toBeNull();
    expect(blockedBy()).toBeNull(); expect(gameOff('crash')).toBe(false); expect(signupsOpen()).toBe(true);
    expect(document.querySelector('.app')?.hasAttribute('inert')).toBe(false);
  });
});

describe('the notice bar', () => {
  it('shows the text under the top bar with its kind, and escapes it', async () => {
    set({ notice: { text: 'Race ends <b>tonight</b>', kind: 'warn' } });
    await initSite();
    expect(bar()?.classList.contains('warn')).toBe(true);
    expect(bar()?.textContent).toBe('Race ends <b>tonight</b>');
    expect(bar()?.querySelector('b')).toBeNull();
    expect(document.getElementById('topbar')?.nextElementSibling).toBe(bar());
  });
  it('goes away when the notice is switched off, and never doubles up', async () => {
    set({ notice: { text: 'Hello', kind: 'info' } }); await initSite();
    set({ notice: { text: 'Hello again', kind: 'info' } }); await refreshSite();
    expect(document.querySelectorAll('#siteNotice')).toHaveLength(1);
    set({}); await refreshSite();
    expect(bar()).toBeNull();
  });
});

describe('paused games', () => {
  it('knows which pages belong to a switchable game', async () => {
    set({ games_off: ['crash', 'coinflip'] }); await initSite();
    expect(gameOff('crash')).toBe(true); expect(gameOff('double')).toBe(false);
    expect(GAME_OF_NAV['coin']).toBe('coinflip');
    expect(pausedPanel('coinflip')).toContain('Coinflip is paused');
    expect(pausedPanel('crash')).toContain('Go home');
  });
  it('does not pause anything for staff', async () => {
    set({ games_off: ['crash'], staff: true }); await initSite();
    expect(gameOff('crash')).toBe(false);
  });
  it('maps every page to a game that the database knows about', () => {
    const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/0007_site_controls.sql'), 'utf8');
    const games = (/site_games\(\)[\s\S]*?array\[([^\]]+)\]/.exec(migration)?.[1] ?? '').split(',').map(s => s.trim().replace(/'/g, ''));
    expect(games.length).toBeGreaterThan(5);
    for (const g of Object.values(GAME_OF_NAV)) expect(games).toContain(g);
    expect([...new Set(Object.values(GAME_OF_NAV))].sort()).toEqual([...games].sort());
  });
});

describe('maintenance', () => {
  it('covers the page at once when it is already on at load, with the message', async () => {
    set({ maintenance: true, maintenance_message: 'Back at <i>noon</i>' }); await initSite();
    expect(blockedBy()).toBe('maintenance');
    expect(overlay()?.textContent).toContain('Down for maintenance');
    expect(overlay()?.textContent).toContain('Back at <i>noon</i>');
    expect(overlay()?.querySelector('i')).toBeNull();
    expect(overlay()?.getAttribute('role')).toBe('alertdialog');
    expect(document.querySelector('.app')?.hasAttribute('inert')).toBe(true);        // nothing behind it can be reached with the keyboard
  });
  it('uses a friendly default when no message was written', async () => {
    set({ maintenance: true }); await initSite();
    expect(overlay()?.textContent).toContain('making improvements');
  });
  it('gives a minute of warning when it starts while someone is playing, then closes the page', async () => {
    await initSite();
    set({ maintenance: true, maintenance_message: 'Updating' });
    await vi.advanceTimersByTimeAsync(POLL_MS);                                       // the next check notices it
    expect(overlay()).toBeNull(); expect(blockedBy()).toBeNull();
    expect(bar()?.classList.contains('warn')).toBe(true); expect(bar()?.textContent).toContain('about to start');
    await vi.advanceTimersByTimeAsync(GRACE_MS + 100);
    expect(overlay()).not.toBeNull(); expect(blockedBy()).toBe('maintenance');
    expect(bar()).toBeNull();
  });
  it('opens again by itself when maintenance ends', async () => {
    set({ maintenance: true }); await initSite();
    expect(overlay()).not.toBeNull();
    set({}); await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(overlay()).toBeNull(); expect(document.querySelector('.app')?.hasAttribute('inert')).toBe(false); expect(document.body.classList.contains('site-blocked')).toBe(false);
  });
  it('never covers the page for staff', async () => {
    set({ maintenance: true, staff: true }); await initSite();
    expect(overlay()).toBeNull(); expect(blockedBy()).toBeNull(); expect(bar()).toBeNull();
  });
});

describe('blocked countries', () => {
  it('covers the page at once and names the country', async () => {
    set({ country: 'US', country_blocked: true }); await initSite();
    expect(blockedBy()).toBe('country');
    expect(overlay()?.textContent).toContain('Not available in your country');
    expect(overlay()?.textContent).toContain('(US)');
  });
  it('does not cover the page for staff', async () => {
    set({ country: 'US', country_blocked: true, staff: true }); await initSite();
    expect(overlay()).toBeNull();
  });
});

describe('sign-ups', () => {
  it('tracks open and closed, and staff are always allowed', async () => {
    set({ signups_open: false }); await initSite();
    expect(signupsOpen()).toBe(false);
    set({ signups_open: false, staff: true }); await refreshSite();
    expect(signupsOpen()).toBe(true);
    set({}); await refreshSite();
    expect(signupsOpen()).toBe(true);
  });
});

describe('keeping the status fresh', () => {
  it('checks again every half minute', async () => {
    await initSite();
    const first = srv.calls;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 10);
    expect(srv.calls).toBe(first + 2);
  });
  it('keeps what it knew when a check fails: a hiccup never closes or opens the site', async () => {
    set({ notice: { text: 'Hello', kind: 'info' }, games_off: ['mines'] }); await initSite();
    srv.down = true;
    expect(await refreshSite()).toBe(false);
    expect(siteStatus().games_off).toEqual(['mines']); expect(bar()).not.toBeNull();
  });
  it('announces a change, and only a change', async () => {
    const seen: unknown[] = []; const off = on('site', d => seen.push(d));
    await initSite();
    expect(await refreshSite()).toBe(false);
    set({ games_off: ['plinko'] });
    expect(await refreshSite()).toBe(true);
    expect(seen).toHaveLength(1); expect((seen[0] as { games_off: string[] }).games_off).toEqual(['plinko']);
    off();
  });
  it('can redraw without asking the server', async () => {
    set({ notice: { text: 'Hi', kind: 'info' } }); await initSite();
    bar()?.remove(); applySiteUi();
    expect(bar()?.textContent).toBe('Hi');
  });
});
