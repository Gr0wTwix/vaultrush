// The page's side of the database-kept limits (migration 0018): the limits, pending changes, breaks and usage the database reports are mirrored into the page,
// changes go to the database, local safeguards are copied up once and never loosen anything, and the Responsible Play pane talks to the database.
// The database rules themselves are tested in server-limits-db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const srv = vi.hoisted(() => ({ calls: [] as [string, any][], handlers: {} as Record<string, (a: any) => any> }));
vi.mock('../src/backend.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backend.js')>()),
  backendEnabled: () => true,
  call: async (fn: string, args: any = {}) => {
    srv.calls.push([fn, args]);
    const h = srv.handlers[fn]; if (!h) throw new Error(`no fake for ${fn}`);
    return JSON.parse(JSON.stringify(await h(args)));
  },
}));
vi.mock('../src/live.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/live.js')>()),
  watchTable: async () => () => {},
}));

import { renderResponsible } from '../src/account-rg.js';
import { setLimit } from '../src/rg.js';
import { applyServerLimits, cancelServerLimit, refreshLimits, resetServerLimits, serverUsage, setServerLimit, takeBreak } from '../src/rg-server.js';
import { resetAccount, setServerWallet, state } from '../src/state.js';
import { initWallet, stopWallet } from '../src/wallet.js';
import { ERROR_TEXT, explain } from '../src/backend.js';

const HOUR = 3_600_000;
type Limits = Record<string, number | null>;
/** A tiny database: one player's limits, breaks and usage, answering like migration 0018's functions. */
const db = {
  limits: {} as Limits, pending: [] as { key: string; value: number | null; effective_at: number }[], excluded: null as number | null, cool: null as number | null,
  usage: { staked_today: 0, loss_1: 0, loss_7: 0, loss_30: 0, active_minutes: 0 }, skew: 0,
};
const reset = (): void => {
  db.limits = { max_bet: null, loss_daily: null, loss_weekly: null, loss_monthly: null, wager_daily: null, time_daily_min: null };
  db.pending = []; db.excluded = null; db.cool = null; db.usage = { staked_today: 0, loss_1: 0, loss_7: 0, loss_30: 0, active_minutes: 0 }; db.skew = 0;
};
const serverNow = (): number => Date.now() + db.skew;
const asked = (fn: string) => srv.calls.filter(c => c[0] === fn).map(c => c[1]);

beforeEach(() => {
  reset(); srv.calls.length = 0; resetServerLimits();
  srv.handlers = {
    wallet_ready: () => true,
    wallet_me: () => ({ balance: 100, wagered: 0, won: 0, xp: 0, now: Date.now(), inventory: [], rewards: { rb_instant: 0, rb_daily: 0, rb_weekly: 0, last_daily: null, last_weekly: null, calendar_streak: 0, calendar_last: null, promos: [], keys_used: [], faucet_at: null, welcome_at: null, daily_case_at: null } }),
    my_limits: () => ({ limits: db.limits, pending: db.pending, usage: db.usage, excluded_until: db.excluded, cool_off_until: db.cool, kyc_tier: 0, now: serverNow() }),
    request_limit_change: ({ p_key, p_value }: any) => {
      const cur = db.limits[p_key] ?? null;
      db.pending = db.pending.filter(p => p.key !== p_key);
      if (p_value === cur) return 'same';
      if (p_value !== null && (cur === null || p_value < cur)) { db.limits[p_key] = p_value; return 'applied'; }
      db.pending.push({ key: p_key, value: p_value, effective_at: serverNow() + 24 * HOUR }); return 'pending';
    },
    start_cool_off: ({ p_hours }: any) => { db.cool = Math.max(db.cool ?? 0, serverNow() + p_hours * HOUR); return new Date(db.cool).toISOString(); },
    self_exclude: ({ p_hours }: any) => { db.excluded = Math.max(db.excluded ?? 0, serverNow() + p_hours * HOUR); return new Date(db.excluded).toISOString(); },
  };
  document.body.innerHTML = '<div id="toasts"></div>';
  resetAccount(); setServerWallet(false); stopWallet();
});
afterEach(() => { stopWallet(); setServerWallet(false); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('mirroring what the database holds', () => {
  it('limits, pending changes, breaks and usage come into the page, shifted to the page\'s own clock', async () => {
    setServerWallet(true);
    db.skew = 5 * 60_000;                                                                 // the database's clock is five minutes ahead
    db.limits = { ...db.limits, loss_weekly: 2000, wager_daily: 500.5, time_daily_min: 90, max_bet: 100 };
    db.pending = [{ key: 'loss_weekly', value: null, effective_at: serverNow() + 20 * HOUR }];
    db.cool = serverNow() + 2 * HOUR; db.excluded = serverNow() + 100 * HOUR;
    db.usage = { staked_today: 120.25, loss_1: 10, loss_7: 1500, loss_30: 1600, active_minutes: 12 };
    state.rg.pending = [{ key: 'realityMin', value: 60, effectiveAt: Date.now() + HOUR }];       // the reality check is the page's own: it must survive
    await refreshLimits();
    const L = state.rg.limits;
    expect([L.lossWeekly, L.wagerDaily, L.timeDailyMin, L.maxBet, L.lossDaily, L.lossMonthly]).toEqual([2000, 500.5, 90, 100, null, null]);
    expect(state.rg.pending.map(p => [p.key, p.value])).toEqual([['realityMin', 60], ['lossWeekly', null]]);
    const wait = state.rg.pending.find(p => p.key === 'lossWeekly')!.effectiveAt - Date.now();
    expect(wait).toBeGreaterThan(19.9 * HOUR); expect(wait).toBeLessThan(20.1 * HOUR);              // 20 hours away on the page's clock, not 25
    expect(state.rg.coolOffUntil - Date.now()).toBeGreaterThan(1.9 * HOUR); expect(state.rg.coolOffUntil - Date.now()).toBeLessThan(2.1 * HOUR);
    expect(state.excludedUntil - Date.now()).toBeGreaterThan(99.9 * HOUR);
    expect(serverUsage()).toEqual({ stakedToday: 120.25, loss1: 10, loss7: 1500, loss30: 1600, activeMinutes: 12 });
  });

  it('does nothing without the server wallet, and the usage is hidden', async () => {
    await refreshLimits();
    expect(srv.calls).toEqual([]);
    applyServerLimits({ limits: { max_bet: null, loss_daily: null, loss_weekly: null, loss_monthly: null, wager_daily: null, time_daily_min: null }, pending: [], usage: { staked_today: 1, loss_1: 1, loss_7: 1, loss_30: 1, active_minutes: 1 }, excluded_until: null, cool_off_until: null, kyc_tier: 0, now: Date.now() });
    expect(serverUsage()).toBeNull();
  });

  it('is loaded when the server wallet starts, and an older database without the function is ignored quietly', async () => {
    db.limits.loss_daily = 777;
    expect(await initWallet('p1')).toBe(true);
    await vi.waitFor(() => expect(state.rg.limits.lossDaily).toBe(777));
    stopWallet();
    srv.handlers['my_limits'] = () => { throw new Error('function public.my_limits does not exist'); };
    expect(await initWallet('p2')).toBe(true);                                            // the wallet still works
    expect(state.balance).toBe(100);
  });

  it('forgets the usage when the player signs out', async () => {
    expect(await initWallet('p1')).toBe(true);
    await vi.waitFor(() => expect(serverUsage()).not.toBeNull());
    stopWallet();
    expect(serverUsage()).toBeNull();
  });
});

describe('changing limits and taking breaks', () => {
  it('a limit change goes to the database under its own name, rounded to cents, and the answer comes back', async () => {
    setServerWallet(true); await refreshLimits();
    expect(await setServerLimit('lossMonthly', 1234.567)).toBe('applied');
    expect(asked('request_limit_change')).toEqual([{ p_key: 'loss_monthly', p_value: 1234.57 }]);
    expect(state.rg.limits.lossMonthly).toBe(1234.57);                                    // mirrored from the database's answer
    expect(await setServerLimit('lossMonthly', 5000)).toBe('pending');                    // looser: waits
    expect(state.rg.limits.lossMonthly).toBe(1234.57);
    expect(state.rg.pending.map(p => [p.key, p.value])).toEqual([['lossMonthly', 5000]]);
    await cancelServerLimit('lossMonthly');                                               // asks for the current value
    expect(asked('request_limit_change').at(-1)).toEqual({ p_key: 'loss_monthly', p_value: 1234.57 });
    expect(state.rg.pending).toEqual([]);
    expect(await setServerLimit('timeDailyMin', null)).toBe('same');                      // no limit to remove
    expect(await setServerLimit('timeDailyMin', 60)).toBe('applied');
    expect(await setServerLimit('timeDailyMin', null)).toBe('pending');                   // removing a limit waits 24 hours
  });

  it('a refusal reaches the caller as a readable message', async () => {
    setServerWallet(true);
    srv.handlers['request_limit_change'] = () => { throw new Error('invalid_limit'); };
    await expect(setServerLimit('lossDaily', -1)).rejects.toThrow('invalid_limit');
    expect(explain({ message: 'invalid_limit' })).toContain('zero or more');
  });

  it('a cool-off or self-exclusion is kept by the database, for whole hours rounded up, and answers when it ends', async () => {
    setServerWallet(true);
    const until = await takeBreak('cool-off', 90 * 60_000);                               // 90 minutes -> 2 hours
    expect(asked('start_cool_off')).toEqual([{ p_hours: 2 }]);
    expect(Math.abs(until - (Date.now() + 2 * HOUR))).toBeLessThan(5_000);
    expect(state.rg.coolOffUntil).toBe(until);
    const excl = await takeBreak('self-exclusion', 3 * 24 * HOUR);
    expect(asked('self_exclude')).toEqual([{ p_hours: 72 }]);
    expect(state.excludedUntil).toBe(excl);
  });

  it('without the server wallet the same calls keep the break in the browser and ask nothing', async () => {
    const until = await takeBreak('cool-off', HOUR);
    expect(state.rg.coolOffUntil).toBe(until); expect(until).toBeGreaterThan(Date.now() + 0.9 * HOUR);
    const excl = await takeBreak('self-exclusion', 2 * HOUR);
    expect(state.excludedUntil).toBe(excl);
    expect(srv.calls).toEqual([]);
  });
});

describe('what this browser kept before the database knew', () => {
  it('stricter limits and longer breaks are copied up once; looser ones are ignored; nothing is ever loosened', async () => {
    db.limits.loss_daily = 1000; db.limits.loss_weekly = 500;
    setLimit(state.rg, 'lossDaily', 400);                                                 // stricter than the database's 1000: copied
    state.rg.limits.lossWeekly = 9000;                                                    // looser than 500: ignored
    state.rg.limits.maxBet = 50;                                                          // the database has none: copied
    state.excludedUntil = Date.now() + 10 * 24 * HOUR;
    state.rg.coolOffUntil = Date.now() + 5 * HOUR;
    setServerWallet(true);
    await refreshLimits();
    expect(asked('request_limit_change').map(a => [a.p_key, a.p_value]).sort()).toEqual([['loss_daily', 400], ['max_bet', 50]]);
    expect(db.limits.loss_weekly).toBe(500); expect(state.rg.limits.lossWeekly).toBe(500);       // the database's value wins
    expect(asked('self_exclude')).toEqual([{ p_hours: 240 }]);
    expect(asked('start_cool_off')).toEqual([{ p_hours: 5 }]);
    expect(state.rg.limits.lossDaily).toBe(400); expect(state.rg.limits.maxBet).toBe(50);
    srv.calls.length = 0;
    await refreshLimits();                                                                // once only
    expect(srv.calls.map(c => c[0])).toEqual(['my_limits']);
  });

  it('a failing copy does not stop the page from showing the database\'s limits', async () => {
    db.limits.loss_daily = 1000;
    setLimit(state.rg, 'lossDaily', 400);
    srv.handlers['request_limit_change'] = () => { throw new Error('offline'); };
    setServerWallet(true);
    await refreshLimits();
    expect(state.rg.limits.lossDaily).toBe(1000);
  });
});

describe('the Responsible Play pane', () => {
  const draw = async (): Promise<{ pane: HTMLElement; ctx: { rerender: Mock<() => void>; close: Mock<() => void> } }> => {
    setServerWallet(true); await refreshLimits();
    const pane = document.createElement('div'); document.body.append(pane);
    const ctx = { rerender: vi.fn<() => void>(), close: vi.fn<() => void>() };
    renderResponsible(pane, ctx);
    return { pane, ctx };
  };

  it('shows the database\'s usage and says the limits are kept there', async () => {
    db.limits.loss_weekly = 2000; db.usage.loss_7 = 1500;
    const { pane } = await draw();
    expect(pane.textContent).toMatch(/1,?500(\.00)? of 2,?000(\.00)? coins used/);
    expect(pane.textContent).toContain('kept by the database');
    expect(pane.querySelector('.rg-use i')!.getAttribute('style')).toContain('75.0%');
  });

  it('setting a limit asks the database and draws the page again', async () => {
    const { pane, ctx } = await draw();
    const box = pane.querySelector('.rg-limit[data-k="wagerDaily"]')!;
    (box.querySelector('input') as HTMLInputElement).value = '800';
    (box.querySelector('[data-set]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalled());
    expect(db.limits.wager_daily).toBe(800); expect(state.rg.limits.wagerDaily).toBe(800);
  });

  it('a limit the database refuses shows its message and changes nothing', async () => {
    const { pane, ctx } = await draw();
    srv.handlers['request_limit_change'] = () => { throw new Error('invalid_limit'); };
    const box = pane.querySelector('.rg-limit[data-k="timeDailyMin"]')!;
    (box.querySelector('input') as HTMLInputElement).value = '1.5';
    (box.querySelector('[data-set]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#toasts')!.textContent).toBeTruthy());
    expect(ctx.rerender).not.toHaveBeenCalled(); expect(state.rg.limits.timeDailyMin).toBeNull();
  });

  it('removing a limit and cancelling the wait both go to the database', async () => {
    db.limits.loss_daily = 300;
    const { pane, ctx } = await draw();
    (pane.querySelector('.rg-limit[data-k="lossDaily"] [data-off]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalled());                       // the answer has been mirrored
    expect(db.pending).toHaveLength(1);
    expect(db.pending[0]).toMatchObject({ key: 'loss_daily', value: null });
    expect(db.limits.loss_daily).toBe(300);                                               // removing waits 24 hours
    ctx.rerender.mockClear();
    const again = document.createElement('div'); document.body.append(again);
    renderResponsible(again, ctx);                                                        // the pending change is now shown
    expect(again.textContent).toContain('takes effect');
    (again.querySelector('.rg-limit[data-k="lossDaily"] [data-cancel]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(db.pending).toHaveLength(0));
  });

  it('a cool-off and a self-exclusion are started on the database after confirming', async () => {
    vi.stubGlobal('confirm', () => true);
    const { pane, ctx } = await draw();
    (pane.querySelector('[data-cool]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(db.cool).not.toBeNull());
    expect(asked('start_cool_off')).toEqual([{ p_hours: 24 }]);
    (pane.querySelector('[data-excl]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(db.excluded).not.toBeNull());
    expect(asked('self_exclude')).toEqual([{ p_hours: 72 }]);
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalledTimes(2));
    vi.stubGlobal('confirm', () => false);
    (pane.querySelector('[data-cool]') as HTMLButtonElement).click();                      // declined: nothing more is sent
    expect(asked('start_cool_off')).toHaveLength(1);
  });
});

describe('the new refusals have readable text', () => {
  it('every limit the database can refuse a stake for is explained to the player', () => {
    for (const code of ['wager_daily_limit', 'daily_loss_limit', 'weekly_loss_limit', 'monthly_loss_limit', 'time_limit', 'cool_off', 'self_excluded', 'max_bet_exceeded', 'tier_cap_exceeded'])
      expect(ERROR_TEXT[code], code).toBeTruthy();
    expect(explain({ message: 'weekly_loss_limit' })).toContain('weekly loss limit');
    expect(explain({ message: 'wager_daily_limit' })).toContain('wager limit');
  });
});
