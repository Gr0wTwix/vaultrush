// Free crates are once per account, decided by the server for cloud accounts: the welcome crate once ever, the daily crate once every
// 24 hours, wherever the player is signed in. Browser-only accounts (or a server without migration 0004) keep the local rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({
  welcome: null as string | null, daily: null as string | null, calls: [] as string[], failClaim: false, statusFails: false,
}));

vi.mock('../src/backend.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/backend.js')>();
  const iso = (): string => new Date().toISOString();
  return {
    ...real,
    backendEnabled: () => true,
    call: async (fn: string, args: any = {}) => {
      srv.calls.push(fn === 'claim_free' ? `claim_free:${args.p_kind}` : fn);
      if (fn === 'live_ready') return false;                                  // live lobbies are not under test here
      if (fn === 'claim_status') { if (srv.statusFails) throw new Error('not applied'); return { welcome: srv.welcome, daily_case: srv.daily }; }
      if (fn === 'claim_free') {
        if (srv.failClaim) throw new Error('network');
        if (args.p_kind === 'welcome') { if (srv.welcome) return { claimed: false, last: srv.welcome, next: null }; srv.welcome = iso(); return { claimed: true, last: srv.welcome, next: null }; }
        if (srv.daily && Date.now() - Date.parse(srv.daily) < 86_400_000) return { claimed: false, last: srv.daily, next: new Date(Date.parse(srv.daily) + 86_400_000).toISOString() };
        srv.daily = iso(); return { claimed: true, last: srv.daily, next: new Date(Date.now() + 86_400_000).toISOString() };
      }
      throw new Error('unexpected ' + fn);
    },
  };
});

import { initFair } from '../src/fair.js';
import { initLive, stopLive, syncClaims, takeFreeClaim, claimsEnabled } from '../src/live.js';
import { newGameState, resetAccount, state } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { render } from '../src/views/rewards.js';

let el: HTMLElement, leave: (() => void) | undefined;
const mount = async (): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = render(el) as any; await vi.advanceTimersByTimeAsync(20); };
const click = (sel: string): void => { (el.querySelector(sel) as HTMLElement).click(); };
const opened = (): number => document.querySelectorAll('.modal-back').length;
const count = (k: string): number => srv.calls.filter(c => c === k).length;
const run = async (ms = 15_000): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.body.innerHTML = '<div id="toasts"></div>';
  Object.assign(srv, { welcome: null, daily: null, calls: [], failClaim: false, statusFails: false });
  resetAccount(); confirmAge(state.rg); state.liveSettled = [];
  stopLive(); await initFair();
  await initLive('user-1'); await syncClaims();
});
afterEach(async () => { leave?.(); leave = undefined; await run(20_000); document.body.innerHTML = ''; stopLive(); vi.useRealTimers(); });

describe('defaults', () => {
  it('a new account has one welcome crate', () => { expect(newGameState().welcomeLeft).toBe(1); });
});

describe('claims decided by the server', () => {
  it('syncs what the account already claimed on another browser', async () => {
    srv.welcome = new Date(Date.now() - 3 * 86_400_000).toISOString();
    srv.daily = new Date(Date.now() - 3600_000).toISOString();
    await syncClaims();
    expect(claimsEnabled()).toBe(true);
    expect(state.welcomeLeft).toBe(0);
    expect(Date.now() - state.lastDailyCase).toBeLessThan(2 * 3600_000);
    await mount();
    expect((el.querySelector('#welcome') as HTMLButtonElement).disabled).toBe(true);
    expect((el.querySelector('#dailyCase') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the daily crate once, and a double click asks the server only once', async () => {
    await mount();
    click('#dailyCase'); click('#dailyCase');
    await vi.advanceTimersByTimeAsync(50);
    expect(count('claim_free:daily_case')).toBe(1);
    expect(opened()).toBe(1);
    expect(state.lastDailyCase).toBeGreaterThan(0);
  });

  it('opens the welcome crate once, and a double click asks the server only once', async () => {
    await mount();
    click('#welcome'); click('#welcome');
    await vi.advanceTimersByTimeAsync(50);
    expect(count('claim_free:welcome')).toBe(1);
    expect(opened()).toBe(1);
    expect(state.welcomeLeft).toBe(0);
  });

  it('refuses a crate that another browser already opened, and updates this one', async () => {
    await mount();                                                         // this browser still thinks both are available
    srv.daily = new Date(Date.now() - 600_000).toISOString();              // meanwhile the same account opened them elsewhere
    srv.welcome = new Date(Date.now() - 600_000).toISOString();
    click('#dailyCase'); await vi.advanceTimersByTimeAsync(50);
    click('#welcome'); await vi.advanceTimersByTimeAsync(50);
    expect(opened()).toBe(0);                                              // nothing opened
    expect(state.welcomeLeft).toBe(0);
    expect(Date.now() - state.lastDailyCase).toBeLessThan(2 * 3600_000);
    expect(document.querySelector('#toasts')!.textContent).toMatch(/already opened/);
    expect((el.querySelector('#welcome') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not open anything when the server cannot be asked, and lets the player try again', async () => {
    await mount();
    srv.failClaim = true;
    click('#dailyCase'); await vi.advanceTimersByTimeAsync(50);
    expect(opened()).toBe(0);
    expect(state.lastDailyCase).toBe(0);
    expect(document.querySelector('#toasts')!.textContent).toMatch(/Could not check/);
    srv.failClaim = false;
    click('#dailyCase'); await vi.advanceTimersByTimeAsync(50);
    expect(opened()).toBe(1);
  });

  it('allows the daily crate again 24 hours later', async () => {
    expect(await takeFreeClaim('daily_case')).toBe('ok');
    expect(await takeFreeClaim('daily_case')).toBe('taken');
    await vi.advanceTimersByTimeAsync(25 * 3600_000);
    expect(await takeFreeClaim('daily_case')).toBe('ok');
  });
});

describe('without server claims (browser-only account, or migration 0004 not applied)', () => {
  beforeEach(async () => { stopLive(); srv.statusFails = true; srv.calls.length = 0; await initLive('user-2'); await syncClaims(); });

  it('keeps the local once-a-day rule and never asks the server', async () => {
    expect(claimsEnabled()).toBe(false);
    await mount();
    click('#dailyCase'); click('#dailyCase'); await vi.advanceTimersByTimeAsync(50);
    expect(opened()).toBe(1);
    expect(count('claim_free:daily_case')).toBe(0);
    expect(Date.now() - state.lastDailyCase).toBeLessThan(5000);
  });
  it('keeps the local once-per-account welcome crate', async () => {
    await mount();
    click('#welcome'); click('#welcome'); await vi.advanceTimersByTimeAsync(50);
    expect(opened()).toBe(1);
    expect(state.welcomeLeft).toBe(0);
    expect(count('claim_free:welcome')).toBe(0);
  });
  it('takeFreeClaim never blocks locally: the page applies its own check', async () => {
    expect(await takeFreeClaim('daily_case')).toBe('ok');
  });
});
