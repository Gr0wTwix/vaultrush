// Coinflip and Battles with the SERVER wallet, against a fake server: the page never moves coins itself, shows my stake at once, and keeps a win out of the
// balance until the coin has landed / the reels have stopped. (The rules are in SQL: wallet-live-db.test.ts. The same pages without a server wallet:
// live-client.test.ts and live-battles.test.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => {
  const s = { flips: [] as any[], battles: [] as any[], seeds: {} as Record<string, string>, watchers: new Set<(ev: string, r: any) => void>(), bwatchers: new Set<(ev: string, r: any) => void>(), next: 100, balance: 100, cost: 0, pay: 0 };
  return { s };
});

vi.mock('../src/live.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/live.js')>();
  const bal = <T extends object>(r: T): T & { balance: number } => ({ ...r, balance: srv.s.balance });
  return {
    ...real,
    isLive: () => true,
    liveMe: () => 'me-uid',
    openLiveFlips: async () => srv.s.flips.filter(r => r.status === 'waiting').map(r => ({ ...r })),
    myLiveFlips: async () => srv.s.flips.filter(r => r.creator === 'me-uid' || r.joiner === 'me-uid').map(r => ({ ...r })),
    watchFlips: async (cb: (ev: string, r: any) => void) => { srv.s.watchers.add(cb); return () => srv.s.watchers.delete(cb); },
    liveFlipSeed: async () => null,
    createLiveFlip: async (side: string, amount: number) => {
      srv.s.balance = Math.round((srv.s.balance - amount) * 100) / 100;
      const r = { id: srv.s.next++, creator: 'me-uid', creator_name: 'Mirage', side, amount, joiner: null, joiner_name: null, status: 'waiting', result: null, winner: null, server_hash: 'h', created_at: new Date().toISOString(), finished_at: null };
      srv.s.flips.push(r); return real.tellBalance(bal(r));
    },
    joinLiveFlip: async (id: number) => {
      const r = srv.s.flips.find(x => x.id === id)!;
      srv.s.balance = Math.round((srv.s.balance - r.amount) * 100) / 100;
      Object.assign(r, { joiner: 'me-uid', joiner_name: 'Mirage', status: 'done', result: r.side === 'bolt' ? 'star' : 'bolt', winner: 'me-uid' });   // the joiner wins this one
      srv.s.balance = Math.round((srv.s.balance + Math.floor((Math.round(r.amount * 100) * 194) / 100 + 0.5) / 100) * 100) / 100;                       // the server paid at once
      return bal(r);                                                                                                                                      // (the page applies the balance itself, after holding the payout)
    },
    cancelLiveFlip: async (id: number) => { const r = srv.s.flips.find(x => x.id === id)!; r.status = 'cancelled'; srv.s.balance = Math.round((srv.s.balance + r.amount) * 100) / 100; return real.tellBalance(bal(r)); },
    callLiveFlipBot: async () => { throw new Error('unused'); },
    // battles
    getLiveBattle: async (id: string) => { const r = srv.s.battles.find(x => x.id === id); return r ? { ...r } : null; },
    openLiveBattles: async () => srv.s.battles.filter(r => r.status === 'waiting').map(r => ({ ...r })),
    myLiveBattles: async () => srv.s.battles.filter(r => r.player_ids.includes('me-uid')).map(r => ({ ...r })),
    watchBattles: async (cb: (ev: string, r: any) => void) => { srv.s.bwatchers.add(cb); return () => srv.s.bwatchers.delete(cb); },
    liveBattleSeed: async (id: string) => { const r = srv.s.battles.find(x => x.id === id); return r && r.status === 'running' ? (srv.s.seeds[id] ?? null) : null; },
    leaveLiveBattle: async () => { throw new Error('unused'); },
    joinLiveBattle: async (id: string, seat: number | null) => {
      const r = srv.s.battles.find(x => x.id === id)!;
      const i = seat ?? r.seats.findIndex((x: any) => !x);
      r.seats[i] = { uid: 'me-uid', name: 'Mirage', bot: false }; r.player_ids.push('me-uid'); r.status = 'running';
      srv.s.balance = Math.round((srv.s.balance - srv.s.cost) * 100) / 100 + srv.s.pay;                                                      // stake, then the pot if I won (the server paid at once)
      return bal(r);
    },
  };
});

import { CASES, CASE, entryForTicket, ticketOf } from '../src/data.js';
import { decide, shareOf } from '../src/battle-math.js';
import { floatsFor } from '../src/fair.js';
import { resetAccount, setServerWallet, state, credit } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { applyBalance, holdPayout, listenWallet, stopWallet } from '../src/wallet.js';
import { render as renderCoinflip } from '../src/views/coinflip.js';
import { renderBattle } from '../src/views/battles.js';

const settle = async (ms = 12_000): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
let el: HTMLElement, leave: (() => void) | undefined;
const cfPayout = (a: number): number => Math.floor((Math.round(a * 100) * 194) / 100 + 0.5) / 100;
const spin = (): HTMLElement => el.querySelector('.cf-make.bolt') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="toasts"></div>';
  srv.s.flips.length = 0; srv.s.battles.length = 0; srv.s.watchers.clear(); srv.s.bwatchers.clear(); srv.s.seeds = {}; srv.s.next = 100; srv.s.balance = 100;
  stopWallet(); resetAccount(); confirmAge(state.rg); state.liveSettled = []; state.speed = 'turbo';
  setServerWallet(true); listenWallet(); applyBalance(100);
});
afterEach(() => { leave?.(); leave = undefined; stopWallet(); setServerWallet(false); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('live Coinflip with the server wallet', () => {
  const mountFlip = async (): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = renderCoinflip(el) as any; await vi.advanceTimersByTimeAsync(50); };

  it('shows the stake at once, and a win only after the coin has landed (the creator watching a friend join)', async () => {
    await mountFlip();
    (el.querySelector('#cfAmt') as HTMLInputElement).value = '5'; spin().click(); await vi.advanceTimersByTimeAsync(50);
    expect(state.balance).toBe(95);                                              // the server took 5 when the game was created
    const row = srv.s.flips[0];
    // a friend joins and the bolt side (mine) wins: the server pays me at once; the page hears about the flip first, then about the wallet
    Object.assign(row, { joiner: 'friend-uid', joiner_name: 'Nova', status: 'done', result: 'bolt', winner: 'me-uid' });
    srv.s.watchers.forEach(w => w('UPDATE', { ...row }));
    srv.s.balance = 95 + cfPayout(5); applyBalance(srv.s.balance);                // the realtime wallet change right after
    expect(state.balance).toBe(95);                                              // ...is kept out of sight while the coin is in the air
    await settle();
    expect(state.balance).toBeCloseTo(95 + cfPayout(5), 2);                       // revealed when the coin lands
  });

  it('a lost flip shows the stake gone and never a payout', async () => {
    await mountFlip();
    (el.querySelector('#cfAmt') as HTMLInputElement).value = '5'; spin().click(); await vi.advanceTimersByTimeAsync(50);
    const row = srv.s.flips[0];
    Object.assign(row, { joiner: 'friend-uid', joiner_name: 'Nova', status: 'done', result: 'star', winner: 'friend-uid' });
    srv.s.watchers.forEach(w => w('UPDATE', { ...row }));
    await settle();
    expect(state.balance).toBe(95);
  });

  it('joining someone else\'s flip: the balance shows my stake first and the win only when the coin lands', async () => {
    srv.s.flips.push({ id: 7, creator: 'friend-uid', creator_name: 'Nova', side: 'star', amount: 10, joiner: null, joiner_name: null, status: 'waiting', result: null, winner: null, server_hash: 'h', created_at: new Date().toISOString(), finished_at: null });
    await mountFlip();
    (el.querySelector('#openGames .cf-row [data-join], #openGames .cf-row .btn') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(50);
    expect(srv.s.balance).toBe(100 - 10 + cfPayout(10));                          // the server already paid me
    expect(state.balance).toBe(90);                                              // but the page shows only my stake until the flip is over
    await settle();
    expect(state.balance).toBe(100 - 10 + cfPayout(10));
  });

  it('cancelling a waiting flip shows the refund from the server', async () => {
    await mountFlip();
    (el.querySelector('#cfAmt') as HTMLInputElement).value = '5'; spin().click(); await vi.advanceTimersByTimeAsync(50);
    expect(state.balance).toBe(95);
    leave?.(); leave = undefined; await vi.advanceTimersByTimeAsync(50);          // leaving the page cancels my waiting game
    expect(state.balance).toBe(100);
  });

  it('the page itself can never add coins: credit() only reveals what a hold kept back', async () => {
    holdPayout(0); credit(50);
    expect(state.balance).toBe(100);
  });
});

describe('live Battles with the server wallet', () => {
  const CASE_IDS = [CASES[0]!.id, CASES[1]!.id];
  const COST = Math.round(CASE_IDS.reduce((s, id) => s + CASE[id]!.price, 0) * 100) / 100;
  const SEED = 'ab'.repeat(32), BID = '11111111-1111-4111-8111-111111111111';
  const seat = (uid: string | null, name: string) => ({ uid, name, bot: false });
  const battle = () => ({ id: BID, creator: 'friend-uid', case_ids: CASE_IDS, format: '1v1', mode: 'normal', seats: [seat('friend-uid', 'Nova'), null], player_ids: ['friend-uid'], status: 'waiting', server_hash: 'h', client_seed: 'cs', created_at: new Date().toISOString(), started_at: null });
  /** What the server pays: it computes the winners from the same seed with the same maths. */
  async function outcome(): Promise<{ winners: number[]; pot: number }> {
    const fl = await floatsFor(SEED, 'cs', 0, 2 * CASE_IDS.length + 1);
    const results = [0, 1].map(p => CASE_IDS.map((cid, r) => entryForTicket(CASE[cid]!, ticketOf(fl[r * 2 + p]!)).item));
    const oc = decide('normal', '1v1', results, fl[2 * CASE_IDS.length]!);
    return { winners: oc.winners, pot: Math.round(oc.totals.reduce((a: number, b: number) => a + b, 0) * 100) / 100 };
  }
  const mountBattle = async (): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = renderBattle(el, BID) as any; await vi.advanceTimersByTimeAsync(100); };

  it('taking the last seat: the stake shows at once, a win only when the reels have stopped', async () => {
    srv.s.battles.push(battle()); srv.s.seeds[BID] = SEED;
    const oc = await outcome(), iWon = oc.winners.includes(1), share = iWon ? shareOf(oc.pot, oc.winners.length) : 0;
    Object.assign(srv.s, { cost: COST, pay: share });
    await mountBattle();
    (el.querySelector('.join-seat') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(100);
    expect(state.balance).toBeCloseTo(100 - COST, 2);                             // the stake only: a win is not shown while the battle plays
    for (let i = 0; i < 300 && state.liveSettled.length === 0; i++) await vi.advanceTimersByTimeAsync(500);
    expect(state.liveSettled).toContain(`b:${BID}`);
    expect(state.balance).toBeCloseTo(100 - COST + share, 2);                     // the animation is over: the payout the server made is shown
  });

  it('never credits anything itself: the same page, a battle I only watch', async () => {
    srv.s.battles.push({ ...battle(), seats: [seat('friend-uid', 'Nova'), seat('other-uid', 'Vexx')], player_ids: ['friend-uid', 'other-uid'], status: 'running' }); srv.s.seeds[BID] = SEED;
    await mountBattle(); await settle(60_000);
    expect(state.balance).toBe(100); expect(state.liveSettled).toEqual([]);
  });
});
