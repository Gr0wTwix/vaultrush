// The Crash and Double pages against a scripted server: a friend's bet shows on the right, the round is the server's, cash-outs and payouts
// are credited exactly once, and leaving mid-round is handled. (The rules themselves are tested in rounds-db.test.ts.)
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => {
  const s = {
    round: null as any, bets: [] as any[], nextId: 1, mult: 1.5, failBet: false,
    roundWatchers: new Set<(ev: string, r: any) => void>(), betWatchers: new Set<(ev: string, r: any) => void>(),
    calls: { cashout: [] as any[], cancel: [] as any[], settleLater: [] as any[], bet: [] as any[] },
  };
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const emitBet = (ev: string, row: any): void => s.betWatchers.forEach(w => w(ev, { ...row }));
  const emitRound = (): void => s.roundWatchers.forEach(w => w('UPDATE', { ...s.round }));
  return { s, round2, emitBet, emitRound };
});

vi.mock('../src/live.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/live.js')>();
  return { ...real, isLive: () => true, roundsOn: () => true, liveMe: () => 'me-uid' };
});
vi.mock('../src/rounds.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/rounds.js')>();
  const { s, round2, emitBet } = srv;
  const mine = (round: number, lane = ''): any => s.bets.find(b => b.round_id === round && b.user_id === 'me-uid' && b.lane === lane);
  return {
    ...real,
    serverNow: () => Date.now(),
    advanceRound: async () => ({ ...s.round }),
    roundBets: async (id: number) => s.bets.filter(b => b.round_id === id).map(b => ({ ...b })),
    recentResults: async () => [],
    roundSeed: async () => null,
    watchRounds: async (cb: (ev: string, r: any) => void) => { s.roundWatchers.add(cb); return () => s.roundWatchers.delete(cb); },
    watchRoundBets: async (cb: (ev: string, r: any) => void) => { s.betWatchers.add(cb); return () => s.betWatchers.delete(cb); },
    settleLater: (game: string, id: number) => { s.calls.settleLater.push([game, id]); },
    crashBet: async (round: number, amount: number, auto: number | null) => {
      s.calls.bet.push([amount, auto]);
      if (s.failBet) throw new Error('Betting is closed for this round.');
      const row = { id: s.nextId++, round_id: round, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount, auto_cashout: auto, riding: amount, locked: 0, cashouts: [], done: false };
      s.bets.push(row); emitBet('INSERT', row); return { ...row };
    },
    crashCancel: async (round: number) => {
      s.calls.cancel.push(round);
      const row = mine(round); s.bets.splice(s.bets.indexOf(row), 1); emitBet('DELETE', { id: row.id }); return row.amount;
    },
    crashCashout: async (round: number, frac: number) => {
      s.calls.cashout.push([round, frac]);
      const row = mine(round); if (!row || row.done) throw new Error('Too late: the round is over.');
      const take = frac >= 1 ? row.riding : round2(row.riding * frac), got = round2(take * s.mult);
      Object.assign(row, { riding: round2(row.riding - take), locked: round2(row.locked + got), cashouts: [...row.cashouts, s.mult], done: round2(row.riding - take) <= 0 });
      emitBet('UPDATE', row);
      return { mult: s.mult, take, got, riding: row.riding, locked: row.locked, done: row.done, bet: { ...row } };
    },
    doubleBet: async (round: number, lane: string, amount: number) => {
      s.calls.bet.push([lane, amount]);
      if (s.failBet) throw new Error('Betting is closed for this round.');
      let row = mine(round, lane);
      if (row) Object.assign(row, { amount: round2(row.amount + amount), riding: round2(row.riding + amount) });
      else { row = { id: s.nextId++, round_id: round, user_id: 'me-uid', display_name: 'Mirage', lane, amount, auto_cashout: null, riding: amount, locked: 0, cashouts: [], done: false }; s.bets.push(row); }
      emitBet(row.id ? 'INSERT' : 'UPDATE', row); return { ...row };
    },
  };
});

import { initFair } from '../src/fair.js';
import { resetAccount, state } from '../src/state.js';
import { confirmAge } from '../src/rg.js';
import { render as renderCrash } from '../src/views/crash.js';
import { render as renderDouble } from '../src/views/double.js';

const { s, round2, emitBet, emitRound } = srv;
const noop = (): void => {};
const ctx2d = new Proxy({}, { get: (_t, p) => (p === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop), set: () => true });
(HTMLCanvasElement.prototype as any).getContext = () => ctx2d;
(globalThis as any).ResizeObserver ??= class { observe(): void {} disconnect(): void {} unobserve(): void {} };

let el: HTMLElement, leave: (() => void) | undefined, rid = 100;
const mkRound = (game: string, status: string, o: { endsIn?: number; startedAgo?: number; result?: any; finishedAgo?: number } = {}): any => {
  const ends = o.startedAgo != null ? Date.now() - o.startedAgo : Date.now() + (o.endsIn ?? 7000);
  return { id: ++rid, game, status, created_at: new Date().toISOString(), betting_ends_at: new Date(ends).toISOString(), finished_at: status === 'finished' ? new Date(Date.now() - (o.finishedAgo ?? 0)).toISOString() : null, server_hash: 'abc123', result: o.result ?? null };
};
const friend = (round: number, o: any = {}): any => ({ id: s.nextId++, round_id: round, user_id: 'friend-uid', display_name: 'Nova', lane: '', amount: 25, auto_cashout: null, riding: 25, locked: 0, cashouts: [], done: false, ...o });
const mount = async (renderer: (e: HTMLElement) => any): Promise<void> => { el = document.createElement('div'); document.body.append(el); leave = renderer(el); await vi.advanceTimersByTimeAsync(100); };
const rows = (): string[] => [...el.querySelectorAll('#plist .prow')].map(r => r.textContent!.replace(/\s+/g, ' ').trim());
const click = (sel: string): void => { (el.querySelector(sel) as HTMLElement).click(); };
const tick = (ms = 60): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

beforeAll(async () => { await initFair(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.body.innerHTML = '<div id="toasts"></div>';
  Object.assign(s, { round: null, bets: [], nextId: 1, mult: 1.5, failBet: false });
  s.roundWatchers.clear(); s.betWatchers.clear(); Object.assign(s.calls, { cashout: [], cancel: [], settleLater: [], bet: [] });
  resetAccount(); confirmAge(state.rg); state.name = 'Mirage'; state.liveSettled = []; state.liveCredit = {};
});
afterEach(() => { leave?.(); leave = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });

describe('crash: everyone in the same round', () => {
  it("shows a friend's bet on the right, with no simulated players", async () => {
    s.round = mkRound('crash', 'betting'); s.bets.push(friend(s.round.id));
    await mount(renderCrash);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Nova');
    expect(rows()[0]).toContain('25');
    expect(el.querySelector('#pcount')!.textContent).toBe('1 playing');
  });

  it("shows a bet the moment a friend places it, and their cash-out when it happens", async () => {
    s.round = mkRound('crash', 'betting');
    await mount(renderCrash);
    expect(rows()).toHaveLength(0);
    const row = friend(s.round.id, { amount: 40, riding: 40 }); s.bets.push(row); emitBet('INSERT', row);
    await tick();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Nova');
    s.round = { ...s.round, status: 'running', betting_ends_at: new Date(Date.now() - 3000).toISOString() }; emitRound(); await tick();
    Object.assign(row, { cashouts: [2.2], locked: 88, riding: 0, done: true }); emitBet('UPDATE', row); await tick();
    expect(rows()[0]).toContain('2.2');
    expect(rows()[0]).toContain('88');
  });

  it('takes my bet from the stake, shows me in the list, and cancelling gives it back', async () => {
    s.round = mkRound('crash', 'betting');
    await mount(renderCrash);
    (el.querySelector('#amt') as HTMLInputElement).value = '5';
    click('#actBtn'); await tick();
    expect(state.balance).toBe(95);
    expect(rows().some(r => r.includes('Mirage') && r.includes('5'))).toBe(true);
    expect(el.querySelector('#actBtn')!.textContent).toBe('Cancel bet');
    click('#actBtn'); await tick();
    expect(state.balance).toBe(100);
    expect(rows()).toHaveLength(0);
  });

  it('refunds the stake when the server refuses the bet', async () => {
    s.round = mkRound('crash', 'betting'); s.failBet = true;
    await mount(renderCrash);
    (el.querySelector('#amt') as HTMLInputElement).value = '5';
    click('#actBtn'); await tick();
    expect(state.balance).toBe(100);
    expect(document.querySelector('#toasts')!.textContent).toMatch(/closed/);
  });

  it('cashes out at the server multiplier and pays once, even when the update arrives again', async () => {
    s.round = mkRound('crash', 'running', { startedAgo: 3000 });
    const mine = { id: s.nextId++, round_id: s.round.id, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount: 10, auto_cashout: null, riding: 10, locked: 0, cashouts: [], done: false };
    s.bets.push(mine); state.balance = 90;
    await mount(renderCrash);
    expect(el.querySelector('#actBtn')!.textContent).toMatch(/Cash out/);
    s.mult = 1.5;
    click('#actBtn'); await tick();
    expect(s.calls.cashout).toEqual([[s.round.id, 1]]);
    expect(state.balance).toBeCloseTo(90 + 15, 2);
    emitBet('UPDATE', mine); emitBet('UPDATE', mine); await tick();                      // duplicate realtime events
    expect(state.balance).toBeCloseTo(105, 2);
    click('#actBtn'); await tick();
    expect(s.calls.cashout).toHaveLength(1);                                             // nothing left to cash out
  });

  it('pays what the server settled when the round ends (an auto cash-out), once, and records the crash', async () => {
    s.round = mkRound('crash', 'running', { startedAgo: 2000 });
    const mine = { id: s.nextId++, round_id: s.round.id, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount: 10, auto_cashout: 1.5, riding: 10, locked: 0, cashouts: [], done: false };
    s.bets.push(mine); state.balance = 90;
    await mount(renderCrash);
    s.round = { ...s.round, status: 'finished', finished_at: new Date().toISOString(), result: { point: 3.2 } };
    Object.assign(mine, { riding: 0, locked: 15, cashouts: [1.5], done: true });        // the server applied the auto cash-out at the crash
    emitRound(); emitBet('UPDATE', mine); await tick();
    expect(state.balance).toBeCloseTo(105, 2);
    emitRound(); emitBet('UPDATE', mine); await tick(300);
    expect(state.balance).toBeCloseTo(105, 2);
    expect(el.querySelector('#hist')!.textContent).toContain('3.2');
    expect(state.liveCredit[String(mine.id)]).toBe(15);
  });

  it('a lost bet pays nothing', async () => {
    s.round = mkRound('crash', 'running', { startedAgo: 1000 });
    const mine = { id: s.nextId++, round_id: s.round.id, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount: 10, auto_cashout: null, riding: 10, locked: 0, cashouts: [], done: false };
    s.bets.push(mine); state.balance = 90;
    await mount(renderCrash);
    s.round = { ...s.round, status: 'finished', finished_at: new Date().toISOString(), result: { point: 1.1 } };
    Object.assign(mine, { done: true }); emitRound(); emitBet('UPDATE', mine); await tick(300);
    expect(state.balance).toBe(90);
  });

  it('leaving takes back a bet that has not started, cashes out a running one, and follows the round if that fails', async () => {
    s.round = mkRound('crash', 'betting');
    await mount(renderCrash);
    (el.querySelector('#amt') as HTMLInputElement).value = '5'; click('#actBtn'); await tick();
    leave?.(); leave = undefined; await tick();
    expect(s.calls.cancel).toEqual([s.round.id]);
    expect(state.balance).toBe(100);

    s.bets.length = 0; s.round = mkRound('crash', 'running', { startedAgo: 2000 });
    const mine = { id: s.nextId++, round_id: s.round.id, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount: 10, auto_cashout: null, riding: 10, locked: 0, cashouts: [], done: false };
    s.bets.push(mine); state.balance = 90; s.mult = 2;
    await mount(renderCrash);
    leave?.(); leave = undefined; await tick();
    expect(s.calls.cashout).toEqual([[s.round.id, 1]]);
    expect(state.balance).toBeCloseTo(110, 2);
  });
});

describe('double: everyone in the same round', () => {
  const lane = (k: string): HTMLElement => el.querySelector(`.lane-${k}`) as HTMLElement;
  const bet = (round: number, laneName: string, o: any = {}): any => ({ id: s.nextId++, round_id: round, user_id: 'friend-uid', display_name: 'Nova', lane: laneName, amount: 10, auto_cashout: null, riding: 10, locked: 0, cashouts: [], done: false, ...o });

  it("shows a friend's bet in its lane, live", async () => {
    s.round = mkRound('double', 'betting', { endsIn: 9000 }); s.bets.push(bet(s.round.id, 'purple', { amount: 12 }));
    await mount(renderDouble);
    expect(lane('purple').querySelector('.lane-list')!.textContent).toContain('Nova');
    expect(lane('purple').querySelector('.lane-sum')!.textContent).toContain('1 user');
    expect(lane('green').querySelector('.lane-list')!.textContent).toContain('No bets yet');
    const row = bet(s.round.id, 'green', { amount: 3 }); s.bets.push(row); emitBet('INSERT', row); await tick();
    expect(lane('green').querySelector('.lane-list')!.textContent).toContain('Nova');
  });

  it('takes my bet from the stake, lists me in the lane, refuses purple with gray, and refunds a refused bet', async () => {
    s.round = mkRound('double', 'betting', { endsIn: 9000 });
    await mount(renderDouble);
    (el.querySelector('#amt') as HTMLInputElement).value = '4';
    click('[data-bet="purple"]'); await tick();
    expect(state.balance).toBe(96);
    expect(lane('purple').querySelector('.lane-list')!.textContent).toContain('Mirage');
    click('[data-bet="gray"]'); await tick();
    expect(state.balance).toBe(96);                                       // not both sides
    s.failBet = true; click('[data-bet="green"]'); await tick();
    expect(state.balance).toBe(96);                                       // refused and refunded
  });

  it('rolls to the server tile, then pays my winning lane once and marks the lanes', async () => {
    s.round = mkRound('double', 'betting', { endsIn: 9000 });
    const mine = bet(s.round.id, 'green', { user_id: 'me-uid', display_name: 'Mirage', amount: 2, riding: 2 });
    const pal = bet(s.round.id, 'purple', { amount: 6, riding: 6 });
    s.bets.push(mine, pal); state.balance = 98;
    await mount(renderDouble);
    s.round = { ...s.round, status: 'running', betting_ends_at: new Date(Date.now() - 500).toISOString(), result: { n: 0 } }; emitRound(); await tick();
    expect(state.balance).toBe(98);                                       // nothing is paid while the reel rolls
    s.round = { ...s.round, status: 'finished', finished_at: new Date().toISOString() };
    Object.assign(mine, { locked: 28, done: true }); Object.assign(pal, { locked: 0, done: true });   // green pays 14x
    emitRound(); emitBet('UPDATE', mine); emitBet('UPDATE', pal); await tick(300);
    expect(state.balance).toBeCloseTo(126, 2);
    expect(lane('green').classList.contains('won')).toBe(true);
    expect(lane('purple').classList.contains('lost')).toBe(true);
    emitRound(); emitBet('UPDATE', mine); await tick(300);
    expect(state.balance).toBeCloseTo(126, 2);
  });

  it('a player who arrives mid-roll or after it ends still sees the right result without errors', async () => {
    s.round = mkRound('double', 'running', { startedAgo: 2500, result: { n: 7 } });
    await mount(renderDouble);
    expect(lane('purple')).not.toBeNull();
    s.round = { ...s.round, status: 'finished', finished_at: new Date().toISOString() }; emitRound(); await tick(300);
    expect(el.querySelector('#reel')!.classList.contains('settled')).toBe(true);
    expect(lane('purple').classList.contains('won')).toBe(true);          // tile 7 is odd: purple
    expect(lane('gray').classList.contains('lost')).toBe(true);
  });

  it('leaving with bets in the round follows it in the background so it is paid when it ends', async () => {
    s.round = mkRound('double', 'betting', { endsIn: 9000 });
    s.bets.push(bet(s.round.id, 'green', { user_id: 'me-uid', display_name: 'Mirage', amount: 2, riding: 2 }));
    await mount(renderDouble);
    leave?.(); leave = undefined; await tick();
    expect(s.calls.settleLater).toEqual([['double', s.round.id]]);
  });
});

describe('paying a bet', () => {
  it('pays only the part of the winnings that has not been paid yet', async () => {
    const { payBet } = await import('../src/rounds.js');
    const row: any = { id: 9001, round_id: 1, user_id: 'me-uid', display_name: 'Mirage', lane: '', amount: 10, auto_cashout: null, riding: 5, locked: 7, cashouts: [1.4], done: false };
    expect(payBet(row)).toBe(7);
    expect(state.balance).toBe(107);
    expect(payBet(row)).toBe(0);
    expect(payBet({ ...row, locked: 5 })).toBe(0);                        // a stale, smaller row never takes money back
    expect(payBet({ ...row, locked: 15.5, riding: 0, done: true })).toBe(8.5);
    expect(state.balance).toBeCloseTo(115.5, 2);
    expect(round2(state.liveCredit['9001'] ?? 0)).toBe(15.5);
  });
});
