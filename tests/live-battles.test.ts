// Live case battles against a fake server: the same seed gives every browser the same result, a player is paid once,
// stakes come back when a battle is cancelled or left, and a finished battle is paid after a reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => {
  const s = { rows: [] as any[], watchers: new Set<(ev: string, r: any) => void>(), seeds: {} as Record<string, string>, left: [] as string[] };
  const emit = (r: any): void => s.watchers.forEach(w => w('UPDATE', { ...r }));
  return { s, emit };
});

vi.mock('../src/live.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/live.js')>();
  return {
    ...real,
    isLive: () => true,
    liveMe: () => 'me-uid',
    getLiveBattle: async (id: string) => { const r = srv.s.rows.find(x => x.id === id); return r ? { ...r } : null; },
    openLiveBattles: async () => srv.s.rows.filter(r => r.status === 'waiting').map(r => ({ ...r })),
    myLiveBattles: async () => srv.s.rows.filter(r => r.player_ids.includes('me-uid')).map(r => ({ ...r })),
    watchBattles: async (cb: (ev: string, r: any) => void) => { srv.s.watchers.add(cb); return () => srv.s.watchers.delete(cb); },
    liveBattleSeed: async (id: string) => { const r = srv.s.rows.find(x => x.id === id); return r && r.status === 'running' ? (srv.s.seeds[id] ?? null) : null; },
    leaveLiveBattle: async (id: string) => {
      const r = srv.s.rows.find(x => x.id === id); if (!r || r.status !== 'waiting') throw new Error('The battle has already started.');
      srv.s.left.push(id);
      if (r.creator === 'me-uid') r.status = 'cancelled';
      else { const i = r.seats.findIndex((x: any) => x && x.uid === 'me-uid'); r.seats[i] = null; r.player_ids = r.player_ids.filter((u: string) => u !== 'me-uid'); }
      return { ...r };
    },
    joinLiveBattle: async (id: string, seat: number | null) => {
      const r = srv.s.rows.find(x => x.id === id); if (!r || r.status !== 'waiting') throw new Error('That battle has already started or was cancelled.');
      const i = seat ?? r.seats.findIndex((x: any) => !x);
      r.seats[i] = { uid: 'me-uid', name: 'Mirage', bot: false }; r.player_ids.push('me-uid');
      if (!r.seats.some((x: any) => !x)) r.status = 'running';
      return { ...r };
    },
  };
});

import { CASES, CASE, entryForTicket, ticketOf } from '../src/data.js';
import { floatsFor } from '../src/fair.js';
import { resetAccount, state } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { renderBattle } from '../src/views/battles.js';
import { reconcileAll } from '../src/live.js';

const CASE_IDS = [CASES[0]!.id, CASES[1]!.id];
const COST = Math.round(CASE_IDS.reduce((s, id) => s + CASE[id]!.price, 0) * 100) / 100;
const SEED = 'ab'.repeat(32);
const BID = '11111111-1111-4111-8111-111111111111';
const seat = (uid: string | null, name: string, bot = false) => ({ uid, name, bot });
const battle = (o: any = {}) => ({
  id: BID, creator: 'friend-uid', case_ids: CASE_IDS, format: '1v1', mode: 'normal', seats: [seat('friend-uid', 'Nova'), null], player_ids: ['friend-uid'],
  status: 'waiting', server_hash: 'h', client_seed: 'cs', created_at: new Date().toISOString(), started_at: null, ...o,
});
/** What every browser must compute from the revealed seed: who wins a 1v1 normal battle, and the pot. */
async function expected(seed: string, clientSeed: string): Promise<{ totals: number[]; winner: number; pot: number }> {
  const floats = await floatsFor(seed, clientSeed, 0, 2 * CASE_IDS.length + 1);
  const totals = [0, 1].map(p => Math.round(CASE_IDS.reduce((s, cid, r) => s + entryForTicket(CASE[cid]!, ticketOf(floats[r * 2 + p]!)).item.value, 0) * 100) / 100);
  return { totals, winner: totals[0]! >= totals[1]! ? 0 : 1, pot: Math.round((totals[0]! + totals[1]!) * 100) / 100 };
}
let el: HTMLElement, leave: (() => void) | undefined;
const mount = async (): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = renderBattle(el, BID) as any; await vi.advanceTimersByTimeAsync(100); };
const run = async (ms = 60_000): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
const drawn = async (): Promise<void> => { await vi.waitFor(() => { expect(el.querySelector('#bStatus')).not.toBeNull(); }); };
/** Run the animation clock forward until the payout is recorded (results come from real async crypto, so poll). */
const paid = async (): Promise<void> => {
  for (let i = 0; i < 300 && !state.liveSettled.includes(`b:${BID}`); i++) await vi.advanceTimersByTimeAsync(500);
  expect(state.liveSettled).toContain(`b:${BID}`);
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="toasts"></div>';
  srv.s.rows.length = 0; srv.s.watchers.clear(); srv.s.seeds = {}; srv.s.left = [];
  resetAccount(); confirmAge(state.rg); state.liveSettled = []; state.speed = 'turbo';
});
afterEach(() => { leave?.(); leave = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });

describe('the same seed gives every browser the same battle', () => {
  it('derives results from the revealed seed (the test seed has no tie)', async () => {
    const e = await expected(SEED, 'cs');
    expect(e.totals[0]).not.toBe(e.totals[1]);
    expect(await expected(SEED, 'cs')).toEqual(e);
  });
});

describe('live battle page', () => {
  it('shows the lobby, lets me take the open seat, and plays and pays when the last seat fills', async () => {
    srv.s.rows.push(battle()); srv.s.seeds[BID] = SEED;
    await mount();
    expect(el.textContent).toContain('Nova');
    expect(el.querySelector('.join-seat')).not.toBeNull();                  // I am only watching: I can take the open seat
    expect(el.querySelector('.call-bot')).toBeNull();                       // and only the creator may call bots
    (el.querySelector('.join-seat') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.balance).toBeCloseTo(100 - COST, 2);                        // my stake is taken
    srv.emit(srv.s.rows[0]);                                                // the server started the battle (I filled the last seat)
    await paid();
    const e = await expected(SEED, 'cs');
    // I sit in seat 1 (the joiner), so I win only when the second total is higher
    const iWon = e.winner === 1;
    expect(state.balance).toBeCloseTo(100 - COST + (iWon ? e.pot : 0), 2);
    expect(state.liveSettled).toContain(`b:${BID}`);
    srv.emit(srv.s.rows[0]); await run(1000);                               // repeated events never pay twice
    expect(state.balance).toBeCloseTo(100 - COST + (iWon ? e.pot : 0), 2);
  });

  it('when I am the creator in seat 0 I am paid by the seat-0 result', async () => {
    srv.s.rows.push(battle({ creator: 'me-uid', seats: [seat('me-uid', 'Mirage'), seat('friend-uid', 'Nova')], player_ids: ['me-uid', 'friend-uid'], status: 'running' }));
    srv.s.seeds[BID] = SEED; state.balance = 100 - COST;                      // my stake was taken when I created it
    await mount();
    await paid();
    const e = await expected(SEED, 'cs');
    expect(state.balance).toBeCloseTo(100 - COST + (e.winner === 0 ? e.pot : 0), 2);
    expect(state.liveSettled).toContain(`b:${BID}`);
  });

  it('only watching a running battle never pays or charges anything', async () => {
    srv.s.rows.push(battle({ seats: [seat('friend-uid', 'Nova'), seat('other-uid', 'Vexx')], player_ids: ['friend-uid', 'other-uid'], status: 'running' }));
    srv.s.seeds[BID] = SEED;
    await mount(); await drawn(); await run();
    expect(state.balance).toBe(100);
    expect(state.liveSettled).toHaveLength(0);
  });

  it('the creator can fill a seat with a bot through the server', async () => {
    srv.s.rows.push(battle({ creator: 'me-uid', seats: [seat('me-uid', 'Mirage'), null], player_ids: ['me-uid'] }));
    await mount();
    expect(el.querySelector('.call-bot')).not.toBeNull();
    expect(el.querySelector('.join-seat')).toBeNull();
  });

  it('a creator cancelling takes the joiner out and refunds them once', async () => {
    srv.s.rows.push(battle({ format: '1v1v1', seats: [seat('friend-uid', 'Nova'), seat('me-uid', 'Mirage'), null], player_ids: ['friend-uid', 'me-uid'] }));
    state.balance = 100 - COST;
    await mount(); await drawn();
    srv.s.rows[0].status = 'cancelled'; srv.emit(srv.s.rows[0]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.balance).toBeCloseTo(100, 2);
    srv.emit(srv.s.rows[0]); await vi.advanceTimersByTimeAsync(100);
    expect(state.balance).toBeCloseTo(100, 2);
  });

  it('leaving a battle that has not started refunds the stake', async () => {
    srv.s.rows.push(battle({ format: '1v1v1', seats: [seat('friend-uid', 'Nova'), seat('me-uid', 'Mirage'), null], player_ids: ['friend-uid', 'me-uid'] }));
    state.balance = 100 - COST;
    await mount(); await drawn();
    leave?.(); leave = undefined;
    await vi.advanceTimersByTimeAsync(100);
    expect(srv.s.left).toEqual([BID]);
    expect(state.balance).toBeCloseTo(100, 2);
  });

  it('leaving after the battle is decided still pays the winner', async () => {
    srv.s.rows.push(battle({ creator: 'me-uid', seats: [seat('me-uid', 'Mirage'), seat('friend-uid', 'Nova')], player_ids: ['me-uid', 'friend-uid'], status: 'running' }));
    srv.s.seeds[BID] = SEED; state.balance = 100 - COST;
    await mount(); await drawn();
    leave?.(); leave = undefined;                                           // closes the page before the reels finish
    await paid();
    const e = await expected(SEED, 'cs');
    expect(state.balance).toBeCloseTo(100 - COST + (e.winner === 0 ? e.pot : 0), 2);
  });

  it('refuses a battle that uses cases this site does not have', async () => {
    srv.s.rows.push(battle({ case_ids: ['nope'] }));
    await mount();
    expect(el.textContent).toContain('Battle not found');
  });
});

describe('catching up after a reload', () => {
  it('pays a battle that finished while the page was closed, once', async () => {
    srv.s.rows.push(battle({ creator: 'me-uid', seats: [seat('me-uid', 'Mirage'), seat('friend-uid', 'Nova')], player_ids: ['me-uid', 'friend-uid'], status: 'running' }));
    srv.s.seeds[BID] = SEED; state.balance = 100 - COST;
    await reconcileAll(); await reconcileAll();
    const e = await expected(SEED, 'cs');
    expect(state.balance).toBeCloseTo(100 - COST + (e.winner === 0 ? e.pot : 0), 2);
    expect(state.liveSettled).toContain(`b:${BID}`);
  });

  it('refunds a cancelled battle and closes one that was left waiting', async () => {
    srv.s.rows.push(battle({ id: '22222222-2222-4222-8222-222222222222', status: 'cancelled', seats: [seat('friend-uid', 'Nova'), seat('me-uid', 'Mirage')], player_ids: ['friend-uid', 'me-uid'] }));
    srv.s.rows.push(battle({ id: '33333333-3333-4333-8333-333333333333', creator: 'me-uid', seats: [seat('me-uid', 'Mirage'), null], player_ids: ['me-uid'] }));
    state.balance = 100 - 2 * COST;
    await reconcileAll();
    expect(state.balance).toBeCloseTo(100, 2);
    expect(srv.s.rows[1].status).toBe('cancelled');
    await reconcileAll();
    expect(state.balance).toBeCloseTo(100, 2);
  });
});
