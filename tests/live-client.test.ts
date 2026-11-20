// The live Coinflip page against a fake server: stakes, realtime updates, one payout per game, refunds and the sign-in catch-up.
// (The real rules live in SQL and are tested in live-db.test.ts; this checks that the page uses them correctly.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => {
  const s = { rows: [] as any[], next: 1, watchers: new Set<(ev: string, r: any) => void>(), failNext: '', botResult: 'bolt' };
  const emit = (r: any): void => s.watchers.forEach(w => w('UPDATE', { ...r }));
  const row = (o: any) => ({ id: s.next++, creator: 'friend-uid', creator_name: 'Nova', side: 'bolt', amount: 5, joiner: null, joiner_name: null, status: 'waiting', result: null, winner: null, server_hash: 'h', created_at: new Date().toISOString(), finished_at: null, ...o });
  return { s, emit, row };
});

vi.mock('../src/live.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/live.js')>();
  const fail = (): void => { if (srv.s.failNext) { const m = srv.s.failNext; srv.s.failNext = ''; throw new Error(m); } };
  return {
    ...real,
    isLive: () => true,
    liveMe: () => 'me-uid',
    openLiveFlips: async () => srv.s.rows.filter(r => r.status === 'waiting').map(r => ({ ...r })),
    myLiveFlips: async () => srv.s.rows.filter(r => r.creator === 'me-uid' || r.joiner === 'me-uid').map(r => ({ ...r })),
    watchFlips: async (cb: (ev: string, r: any) => void) => { srv.s.watchers.add(cb); return () => srv.s.watchers.delete(cb); },
    liveFlipSeed: async () => null,
    createLiveFlip: async (side: string, amount: number) => { fail(); const r = srv.row({ creator: 'me-uid', creator_name: 'Mirage', side, amount }); srv.s.rows.push(r); return { ...r }; },
    joinLiveFlip: async (id: number) => {
      fail();
      const r = srv.s.rows.find(x => x.id === id); if (!r || r.status !== 'waiting') throw new Error('Someone already joined that coinflip, or it was cancelled.');
      Object.assign(r, { joiner: 'me-uid', joiner_name: 'Mirage', status: 'done', result: 'star', winner: r.side === 'star' ? r.creator : 'me-uid' });
      return { ...r };
    },
    callLiveFlipBot: async (id: number, name: string) => {
      const r = srv.s.rows.find(x => x.id === id); if (!r || r.status !== 'waiting') throw new Error('Someone already joined that coinflip, or it was cancelled.');
      Object.assign(r, { joiner: null, joiner_name: name, joiner_bot: true, status: 'done', result: srv.s.botResult, winner: r.side === srv.s.botResult ? r.creator : null });
      return { ...r };
    },
    cancelLiveFlip: async (id: number) => {
      const r = srv.s.rows.find(x => x.id === id); if (!r || r.status !== 'waiting') throw new Error('Someone already joined that coinflip, or it was cancelled.');
      r.status = 'cancelled'; return { ...r };
    },
  };
});

import { resetAccount, state } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { render } from '../src/views/coinflip.js';
import { reconcileAll } from '../src/live.js';

const PAYOUT = 2 * 0.97;
const settle = async (ms = 12_000): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
let el: HTMLElement, leave: (() => void) | undefined;
const mount = async (): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = render(el) as any; await vi.advanceTimersByTimeAsync(50); };
const click = (sel: string): void => { (el.querySelector(sel) as HTMLElement).click(); };
const setAmount = (n: number): void => { (el.querySelector('#cfAmt') as HTMLInputElement).value = String(n); };

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="toasts"></div>';
  srv.s.rows.length = 0; srv.s.watchers.clear(); srv.s.next = 100; srv.s.failNext = ''; srv.s.botResult = 'bolt';
  resetAccount(); confirmAge(state.rg); state.liveSettled = [];
});
afterEach(() => { leave?.(); leave = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });

describe('live coinflip page', () => {
  it('shows real open games from the server, not simulated ones', async () => {
    srv.s.rows.push(srv.row({ amount: 7 }));
    await mount();
    expect(el.querySelectorAll('#openGames .cf-row')).toHaveLength(1);
    expect(el.querySelector('#openGames')!.textContent).toContain('Nova');
    expect(el.textContent).toContain('Live: real players');
  });

  it('creating a game takes the stake, and a friend joining plays it out and pays the winner once', async () => {
    await mount();
    setAmount(5); click('.cf-make.bolt');
    await vi.advanceTimersByTimeAsync(50);
    expect(state.balance).toBe(95);
    const mine = srv.s.rows[0];
    expect(mine).toMatchObject({ creator: 'me-uid', side: 'bolt', amount: 5, status: 'waiting' });
    await settle(8000);                                   // no bot picks it up: it waits for a real player
    expect(mine.status).toBe('waiting');
    // the friend joins and the server decides: bolt wins, which is my side
    Object.assign(mine, { joiner: 'friend-uid', joiner_name: 'Nova', status: 'done', result: 'bolt', winner: 'me-uid' });
    srv.emit(mine);
    await settle();
    expect(state.balance).toBeCloseTo(95 + 5 * PAYOUT, 2);
    expect(state.liveSettled).toContain(`f:${mine.id}`);
    srv.emit(mine); srv.emit(mine);                       // duplicate realtime events must not pay again
    await settle();
    expect(state.balance).toBeCloseTo(95 + 5 * PAYOUT, 2);
  });

  it('a lost game pays nothing but is still settled once', async () => {
    await mount();
    setAmount(3); click('.cf-make.star');
    await vi.advanceTimersByTimeAsync(50);
    const mine = srv.s.rows[0];
    Object.assign(mine, { joiner: 'friend-uid', joiner_name: 'Nova', status: 'done', result: 'bolt', winner: 'friend-uid' });
    srv.emit(mine);
    await settle();
    expect(state.balance).toBe(97);
    expect(state.liveSettled).toContain(`f:${mine.id}`);
  });

  it("joining a friend's game takes the stake and pays the server's result", async () => {
    srv.s.rows.push(srv.row({ amount: 10, side: 'bolt' }));       // friend is on bolt; the fake server rolls star, so I win
    await mount();
    click('[data-join]');
    await settle();
    expect(state.balance).toBeCloseTo(100 - 10 + 10 * PAYOUT, 2);
    expect(state.liveSettled).toHaveLength(1);
  });

  it('refunds the stake when the server refuses the game, and when the game was already taken', async () => {
    await mount();
    srv.s.failNext = 'Too many open games.';
    setAmount(5); click('.cf-make.bolt');
    await vi.advanceTimersByTimeAsync(50);
    expect(state.balance).toBe(100);
    srv.s.rows.push(srv.row({ id: 900, amount: 4 }));
    srv.s.rows[srv.s.rows.length - 1].status = 'done';            // someone else got there first; the page still lists it
    srv.emit({ ...srv.s.rows[srv.s.rows.length - 1], status: 'waiting' });
    await vi.advanceTimersByTimeAsync(50);
    click('[data-join]');
    await settle(100);
    expect(state.balance).toBe(100);
  });

  it('leaving the page cancels a waiting game and gives the stake back once', async () => {
    await mount();
    setAmount(6); click('.cf-make.bolt');
    await vi.advanceTimersByTimeAsync(50);
    expect(state.balance).toBe(94);
    leave?.(); leave = undefined;
    await vi.advanceTimersByTimeAsync(50);
    expect(srv.s.rows[0].status).toBe('cancelled');
    expect(state.balance).toBe(100);
    await reconcileAll();                                         // a later catch-up must not refund it a second time
    expect(state.balance).toBe(100);
  });

  it("another player's game being cancelled disappears from the list", async () => {
    const r = srv.row({ amount: 2 }); srv.s.rows.push(r);
    await mount();
    expect(el.querySelectorAll('#openGames .cf-row')).toHaveLength(1);
    r.status = 'cancelled'; srv.emit(r);
    await vi.advanceTimersByTimeAsync(50);
    expect(el.querySelectorAll('#openGames .cf-row')).toHaveLength(0);
  });
});

describe('calling a bot into a live game', () => {
  const callBot = async (): Promise<void> => { (document.querySelector('#callBot') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(50); };
  it('a waiting game of mine shows Call bot; when my side wins I am paid', async () => {
    await mount();
    setAmount(5); click('.cf-make.bolt');
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector('#callBot')).not.toBeNull();
    srv.s.botResult = 'bolt';                                      // the server's roll lands on my side
    await callBot();
    await settle();
    expect(srv.s.rows[0]).toMatchObject({ joiner_bot: true, status: 'done', winner: 'me-uid' });
    expect(state.balance).toBeCloseTo(95 + 5 * PAYOUT, 2);
    expect(state.liveSettled).toContain(`f:${srv.s.rows[0].id}`);
  });
  it('when the bot wins nobody is paid, and the game is still settled once', async () => {
    await mount();
    setAmount(5); click('.cf-make.bolt');
    await vi.advanceTimersByTimeAsync(50);
    srv.s.botResult = 'star';
    await callBot();
    await settle();
    expect(srv.s.rows[0].winner).toBeNull();
    expect(state.balance).toBe(95);
    expect(state.liveSettled).toContain(`f:${srv.s.rows[0].id}`);
    srv.emit(srv.s.rows[0]); await settle(1000);
    expect(state.balance).toBe(95);
  });
  it('other players cannot call a bot into my game (no button on their side)', async () => {
    srv.s.rows.push(srv.row({ amount: 3 }));
    await mount();
    expect(document.querySelector('#callBot')).toBeNull();
    expect(el.querySelector('[data-join]')).not.toBeNull();
  });
});

describe('catching up after a reload', () => {
  it('pays a game that finished while the page was closed, exactly once', async () => {
    const r = srv.row({ creator: 'me-uid', creator_name: 'Mirage', amount: 8, side: 'star', status: 'done', joiner: 'friend-uid', result: 'star', winner: 'me-uid' });
    srv.s.rows.push(r);
    await reconcileAll();
    expect(state.balance).toBeCloseTo(100 + 8 * PAYOUT, 2);
    await reconcileAll(); await reconcileAll();
    expect(state.balance).toBeCloseTo(100 + 8 * PAYOUT, 2);
  });

  it('marks a lost game as settled without paying, and refunds a game left waiting', async () => {
    srv.s.rows.push(srv.row({ id: 501, creator: 'me-uid', amount: 8, status: 'done', joiner: 'friend-uid', result: 'bolt', winner: 'friend-uid' }));
    srv.s.rows.push(srv.row({ id: 502, creator: 'me-uid', amount: 3, status: 'waiting' }));
    await reconcileAll();
    expect(state.balance).toBe(103);                              // only the waiting game's 3 comes back
    expect(srv.s.rows[1].status).toBe('cancelled');
    expect(state.liveSettled).toEqual(expect.arrayContaining(['f:501', 'f:502']));
  });
});
