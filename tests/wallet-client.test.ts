// The server wallet from the page's side, against a fake server: the page mirrors what the server says, can mint nothing by itself, holds a payout back until
// its animation ends, and Cases / Inventory / Upgrade / Rewards / Mines ask the server instead of changing coins and items in the browser.
// The database rules themselves are tested in wallet-db.test.ts and wallet-live-db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({ calls: [] as [string, any][], handlers: {} as Record<string, (a: any) => any>, watchers: {} as Record<string, (ev: string, row: any) => void> }));
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
  watchTable: async (table: string, cb: (ev: string, row: any) => void) => { srv.watchers[table] = cb; return () => { delete srv.watchers[table]; }; },
}));

import { CASE, ITEM, ITEMS } from '../src/data.js';

// Items of the cases (the page knows them without fetching anything), standing in for what a player might hold.
const [I_P1, I_P2, I_R1, I_K1, I_K4] = [ITEMS[2]!.id, ITEMS[5]!.id, ITEMS[12]!.id, ITEMS[60]!.id, ITEMS[ITEMS.length - 1]!.id];
import { addItems, credit, debit, debitError, emit, grant, removeItems, resetAccount, setServerWallet, state } from '../src/state.js';
import { applyBalance, claimFaucet, freezeBalance, heldPayouts, holdItems, holdPayout, initWallet, minesStart, openCases, openFreeCase, plinkoDrop, refreshWallet, releaseItems, releasePayout, sellItems, stopWallet, unfreezeBalance, upgradeItem, visibleInventoryCount } from '../src/wallet.js';
import { renderCase } from '../src/views/cases.js';
import * as inventory from '../src/views/inventory.js';
import * as rewards from '../src/views/rewards.js';

const ME = 'user-1';
/** A tiny server: one account. Snapshot shape = wallet_me(). */
const acct = { balance: 100, wagered: 0, won: 0, inv: [] as { uid: string; id: string; at: number }[], promos: [] as string[], faucetAt: null as number | null };
const snapshot = (inv = true) => ({
  balance: acct.balance, wagered: acct.wagered, won: acct.won, xp: Math.round(acct.wagered * 10), now: Date.now(), inventory: inv ? acct.inv : null,
  rewards: { rb_instant: 1.5, rb_daily: 1, rb_weekly: 0.5, last_daily: null, last_weekly: null, calendar_streak: 2, calendar_last: '2026-11-20', promos: acct.promos, keys_used: [10], faucet_at: acct.faucetAt, welcome_at: null, daily_case_at: null },
});
let uidSeq = 0;
const give = (id: string) => { const e = { uid: `u${++uidSeq}`, id, at: Date.now() }; acct.inv.unshift(e); return e; };

beforeEach(() => {
  vi.useFakeTimers();
  srv.calls.length = 0; for (const k of Object.keys(srv.watchers)) delete srv.watchers[k];
  Object.assign(acct, { balance: 100, wagered: 0, won: 0, inv: [], promos: [], faucetAt: null }); uidSeq = 0;
  srv.handlers = {
    wallet_ready: () => true,
    wallet_me: () => snapshot(),
    open_cases: ({ p_case, p_count }: any) => {
      const c = CASE[p_case]!, cost = Math.round(c.price * p_count * 100) / 100;
      if (acct.balance < cost) throw new Error('Not enough coins.');
      acct.balance = Math.round((acct.balance - cost) * 100) / 100; acct.wagered += cost;
      const opened = Array.from({ length: p_count }, (_, i) => { const it = c.entries[c.entries.length - 1]!.item, e = give(it.id); return { uid: e.uid, item: it.id, ticket: 90000 + i, value: it.value, nonce: i, bet_id: i + 1 }; });
      return { balance: acct.balance, cost, opened };
    },
    sell_items: ({ p_uids }: any) => {
      const gone = acct.inv.filter(e => !p_uids || p_uids.includes(e.uid));
      if (!gone.length || (p_uids && gone.length !== p_uids.length)) throw new Error('One of those items is no longer in your inventory.');
      const total = Math.round(gone.reduce((s, e) => s + ITEM[e.id]!.value, 0) * 100) / 100;
      acct.inv = acct.inv.filter(e => !gone.includes(e)); acct.balance = Math.round((acct.balance + total) * 100) / 100;
      return { balance: acct.balance, sold: gone.length, total };
    },
  };
  document.body.innerHTML = '<div id="toasts"></div>';
  resetAccount(); setServerWallet(false); stopWallet(); state.speed = 'turbo';
});
afterEach(() => { stopWallet(); setServerWallet(false); vi.useRealTimers(); document.body.innerHTML = ''; });

const on = async (): Promise<void> => { await initWallet(ME); };

describe('switching the server wallet on', () => {
  it('mirrors the account: balance, items, XP, rakeback, streak, promos, level keys, faucet timer', async () => {
    acct.balance = 42.5; acct.wagered = 200; give(I_P1); give(I_R1); acct.promos = ['VAULT10']; acct.faucetAt = Date.now() - 60_000;
    const seen: boolean[] = []; const off = (await import('../src/state.js')).on<boolean>('wallet', v => seen.push(v));
    expect(await initWallet(ME)).toBe(true);
    expect(state.balance).toBe(42.5); expect(state.inv.map(e => e.id)).toEqual([I_R1, I_P1]); expect(state.xp).toBe(2000); expect(state.stats.wagered).toBe(200);
    expect(state.rakeback).toMatchObject({ instant: 1.5, daily: 1, weekly: 0.5 }); expect(state.calendar).toEqual({ streak: 2, last: '2026-11-20' });
    expect(state.promos).toEqual(['VAULT10']); expect(state.keysUsed).toEqual([10]); expect(state.lastClaim).toBeGreaterThan(Date.now() - 120_000); expect(state.welcomeLeft).toBe(1);
    expect(seen).toEqual([true]); off();
  });
  it('stays in browser mode when the database has no server wallet yet', async () => {
    srv.handlers['wallet_ready'] = () => { throw new Error('function not found'); };
    state.balance = 7;
    expect(await initWallet(ME)).toBe(false);
    expect(state.balance).toBe(7);
    expect(srv.calls.map(c => c[0])).toEqual(['wallet_ready']);
    credit(5); expect(state.balance).toBe(12);                                       // browser coins keep working as before
  });
  it('only asks once for the same player, and stops cleanly', async () => {
    await on(); await on();
    expect(srv.calls.filter(c => c[0] === 'wallet_ready')).toHaveLength(1);
    stopWallet(); credit(5);
    expect(state.balance).toBe(105);                                                  // back to browser rules: nothing is held in a half-state
  });
});

describe('the browser can mint nothing', () => {
  it('credit, grant, addItems and removeItems change nothing; debit only refuses what cannot be afforded', async () => {
    acct.balance = 50; await on();
    credit(1000); grant(1000, 'Bonus'); expect(state.balance).toBe(50);
    expect(addItems([ITEM[I_K4]!])).toEqual([]); expect(state.inv).toEqual([]);
    give(I_P1); await refreshWallet(true); expect(state.inv).toHaveLength(1);
    removeItems([state.inv[0]!.uid]); expect(state.inv).toHaveLength(1);
    expect(debit(10)).toBe(true); expect(state.balance).toBe(50);                     // the stake is taken by the server when the game is played
    expect(debit(60)).toBe(false); expect(debitError(60)).toMatch(/Not enough coins/);
    expect(debit(0)).toBe(false);
  });
  it('a balance edited in the page or its storage is put right at the next sync', async () => {
    acct.balance = 50; await on();
    state.balance = 999999; state.inv = [{ uid: 'fake', id: I_K4, at: 1 }];
    await refreshWallet(true);
    expect(state.balance).toBe(50); expect(state.inv).toEqual([]);
  });
});

describe('showing a payout at the right moment', () => {
  it('a held payout stays out of the shown balance until credit() reveals it', async () => {
    await on();
    holdPayout(20); applyBalance(120);
    expect(state.balance).toBe(100); expect(heldPayouts()).toBe(20);
    credit(20);                                                                        // the animation ended
    expect(state.balance).toBe(120); expect(heldPayouts()).toBe(0);
  });
  it('releases part of a hold, oldest first, and never below zero', async () => {
    await on(); applyBalance(100);
    holdPayout(10); holdPayout(5);
    releasePayout(12); expect(heldPayouts()).toBe(3); expect(state.balance).toBe(97);
    releasePayout(100); expect(heldPayouts()).toBe(0); expect(state.balance).toBe(100);
  });
  it('a hold that is never released ends by itself after two minutes', async () => {
    await on(); applyBalance(100); holdPayout(30);
    expect(state.balance).toBe(70);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(state.balance).toBe(100);
  });
  it('a frozen balance hides a win but not a stake, and thaws when the animation ends', async () => {
    await on(); applyBalance(100); freezeBalance(0);
    applyBalance(140); expect(state.balance).toBe(100);
    applyBalance(95); expect(state.balance).toBe(95);
    applyBalance(140); unfreezeBalance(); expect(state.balance).toBe(140);
    freezeBalance(10); expect(state.balance).toBe(130);                                // a stake the page has not shown yet
    unfreezeBalance();
  });
  it('an old poll answer never overwrites a newer answer to my own call', async () => {
    await on();
    let release: () => void = () => {};
    srv.handlers['wallet_me'] = () => new Promise(res => { release = () => res({ ...snapshot(), balance: 100 }); });
    const poll = refreshWallet(false);
    applyBalance(80);                                                                  // my own call answered while the poll was on its way
    release(); await poll;
    expect(state.balance).toBe(80);
  });
  it('listens to realtime changes of its own wallet row and of the inventory', async () => {
    await on();
    srv.watchers['wallets']!('UPDATE', { user_id: ME, balance: 77.25, wagered: 10, won: 3 });
    expect(state.balance).toBe(77.25); expect(state.stats.wagered).toBe(10); expect(state.xp).toBe(100);
    srv.watchers['wallets']!('UPDATE', { user_id: 'someone-else', balance: 1, wagered: 0, won: 0 });
    expect(state.balance).toBe(77.25);
    give(I_K1); srv.calls.length = 0;
    srv.watchers['inventory']!('INSERT', {});
    await vi.advanceTimersByTimeAsync(400);
    expect(srv.calls.map(c => c[0])).toEqual(['wallet_me']); expect(srv.calls[0]![1]).toEqual({ p_inventory: true });
    expect(state.inv).toHaveLength(1);
  });
  it('polls the light snapshot every 20 seconds and the full one every third time', async () => {
    await on(); srv.calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_100);
    expect(srv.calls.map(c => c[1].p_inventory)).toEqual([false, false, true]);
  });
});

describe('the wallet calls', () => {
  it('open cases: items arrive in the inventory, the balance is after the stake', async () => {
    await on();
    const r = await openCases('starter', 2);
    expect(r.opened).toHaveLength(2); expect(state.inv).toHaveLength(2); expect(state.balance).toBeCloseTo(100 - CASE['starter']!.price * 2, 2);
  });
  it('sell: one, or everything with null', async () => {
    await on(); await openCases('starter', 3);
    const first = state.inv[0]!;
    await sellItems([first.uid]); expect(state.inv).toHaveLength(2);
    await sellItems(null); expect(state.inv).toEqual([]);
    expect(state.balance).toBeCloseTo(100 - CASE['starter']!.price * 3 + ITEM[first.id]!.value * 3, 2);
  });
  it('upgrade: staked items leave, the target arrives on a win', async () => {
    await on(); give(I_P1); give(I_P2); await refreshWallet(true);
    const [a, b] = state.inv.map(e => e.uid) as [string, string];
    srv.handlers['upgrade_item'] = ({ p_uids }: any) => { acct.inv = acct.inv.filter(e => !p_uids.includes(e.uid)); const t = give(I_K1); return { balance: 100, win: true, roll: 0.1, chance: 0.4, stake: 0.23, item: I_K1, uid: t.uid, from_item: I_P2, nonce: 1, bet_id: 1 }; };
    const r = await upgradeItem([a, b], 0, I_K1, false);
    expect(r.win).toBe(true); expect(state.inv.map(e => e.id)).toEqual([I_K1]);
  });
  it('plinko: the payout is held until the page reveals it', async () => {
    await on();
    srv.handlers['plinko_drop'] = () => { acct.balance = 100 - 10 + 50; return { balance: acct.balance, payout: 50, mult: 5, bucket: 1, path: [0, 1], nonce: 0, bet_id: 1 }; };
    const r = await plinkoDrop(12, 'normal', 10);
    expect(r.payout).toBe(50); expect(state.balance).toBe(90);                          // the stake is gone, the win is not shown yet
    credit(50); expect(state.balance).toBe(140);
  });
  it('mines: starting takes the stake', async () => {
    await on();
    srv.handlers['mines_start'] = () => { acct.balance = 80; return { game: 5, balance: 80, amount: 20, grid: 25, mines: 3, nonce: 0, server_hash: 'h' }; };
    await minesStart(20, 25, 3); expect(state.balance).toBe(80);
  });
  it('the faucet shows the new balance and the cooldown', async () => {
    await on();
    srv.handlers['claim_faucet'] = () => { acct.balance = 125; acct.faucetAt = Date.now(); return { claimed: true, amount: 25, balance: 125, next_at: Date.now() + 600_000 }; };
    const r = await claimFaucet();
    expect(r.claimed).toBe(true); expect(state.balance).toBe(125); expect(Date.now() - state.lastClaim).toBeLessThan(5000);
  });
});

// ============================ pages ========================================================================================
let el: HTMLElement, leave: (() => void) | void;
const mount = (fn: (el: HTMLElement, ...a: any[]) => (() => void) | void, ...args: any[]): void => { el = document.createElement('div'); document.body.append(el); leave = fn(el, ...args); };
afterEach(() => { if (typeof leave === 'function') leave(); leave = undefined; });
const settle = async (ms = 20_000): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

describe('Cases page with the server wallet', () => {
  it('opens through the server, shows the winner on the reel, and has no result panel (items are sold from the Inventory page)', async () => {
    await on(); mount(renderCase, 'starter');
    expect(el.querySelector('#result')).toBeNull();
    (el.querySelector('#openBtn') as HTMLElement).click(); await settle();
    const call = srv.calls.find(c => c[0] === 'open_cases')!;
    expect(call[1]).toEqual({ p_case: 'starter', p_count: 1 });
    expect(state.inv).toHaveLength(1);
    expect(state.balance).toBeCloseTo(100 - CASE['starter']!.price, 2);
    expect(el.querySelector('.reel-won')).not.toBeNull();                                  // the reel itself shows what was won
    expect(el.textContent).not.toContain('You unboxed'); expect(el.querySelector('#sellAll, #again, .sell')).toBeNull();
    expect((el.querySelector('#openBtn') as HTMLButtonElement).disabled).toBe(false);      // ready to open again
    expect(srv.calls.some(c => c[0] === 'sell_items')).toBe(false);
  });
  it('shows the server\'s refusal and changes nothing', async () => {
    acct.balance = 0.01; await on(); mount(renderCase, 'starter');
    (el.querySelector('#openBtn') as HTMLElement).click(); await settle(100);
    expect(srv.calls.some(c => c[0] === 'open_cases')).toBe(false);                       // the page does not even ask: it cannot be afforded
    expect(document.querySelector('.toast.error, #toasts .toast')?.textContent ?? '').toMatch(/Not enough coins/);
    expect(state.inv).toEqual([]);
  });
  it('shows an error from the server and lets the player try again', async () => {
    await on(); mount(renderCase, 'starter');
    srv.handlers['open_cases'] = () => { throw new Error('This game is paused right now.'); };
    (el.querySelector('#openBtn') as HTMLElement).click(); await settle(100);
    expect(document.getElementById('toasts')!.textContent).toMatch(/paused/);
    expect((el.querySelector('#openBtn') as HTMLButtonElement).disabled).toBe(false);
    expect(state.balance).toBe(100);
  });
});

describe('Inventory page with the server wallet', () => {
  it('sells one item and everything through the server, with no reset button', async () => {
    await on(); await openCases('starter', 3);
    mount(inventory.render);
    expect(el.querySelector('#reset')).toBeNull();
    (el.querySelector('.sell') as HTMLElement).click(); await settle(100);
    expect(state.inv).toHaveLength(2);
    (el.querySelector('#sellAll') as HTMLElement).click(); await settle(100);
    expect(state.inv).toHaveLength(0);
    expect(srv.calls.filter(c => c[0] === 'sell_items').map(c => c[1].p_uids)).toEqual([[expect.any(String)], null]);
  });
});

describe('Rewards page with the server wallet', () => {
  it('redeems a promo code through the server, and shows its refusal', async () => {
    await on();
    srv.handlers['redeem_promo'] = ({ p_code }: any) => { if (p_code !== 'RUSH5') throw new Error('That code is not valid.'); acct.balance += 5; acct.promos.push('RUSH5'); return { code: 'RUSH5', amount: 5, balance: acct.balance }; };
    mount(rewards.render);
    const form = el.querySelector('#promoForm') as HTMLFormElement;
    (el.querySelector('#promo') as HTMLInputElement).value = 'nope'; form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle(50);
    expect(document.getElementById('toasts')!.textContent).toMatch(/not valid/); expect(state.balance).toBe(100);
    (el.querySelector('#promo') as HTMLInputElement).value = 'rush5'; form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle(50);
    expect(state.balance).toBe(105); expect(srv.calls.filter(c => c[0] === 'redeem_promo').map(c => c[1].p_code)).toEqual(['NOPE', 'RUSH5']);
  });
  it('claims rakeback through the server (the page cannot zero the pool itself)', async () => {
    await on();
    srv.handlers['claim_rakeback'] = () => { acct.balance = 101.5; return { amount: 1.5, balance: 101.5 }; };
    mount(rewards.render);
    (el.querySelector('[data-rb="instant"]') as HTMLElement).click(); await settle(50);
    expect(srv.calls.some(c => c[0] === 'claim_rakeback' && c[1].p_kind === 'instant')).toBe(true);
    expect(state.balance).toBe(101.5);
  });
  it('opens the welcome crate through the server and puts the item where the server put it', async () => {
    await on();
    srv.handlers['open_free_case'] = ({ p_kind }: any) => { const it = CASE['welcome']!.entries[0]!.item, e = give(it.id); return { claimed: true, item: it.id, uid: e.uid, ticket: 5, value: it.value, case: 'welcome', label: 'Welcome gift', next: null, nonce: 0 }; };
    mount(rewards.render);
    (el.querySelector('#welcome') as HTMLElement).click(); await settle(15_000);
    expect(srv.calls.some(c => c[0] === 'open_free_case' && c[1].p_kind === 'welcome')).toBe(true);
    expect(state.inv).toHaveLength(1);
    expect(document.querySelector('.modal-back #freeRes')?.textContent).toContain('Keep in inventory');
  });
});

void emit;

describe('a new item is revealed by its animation, not before', () => {
  it('Cases: the item is in the inventory at once, but the top bar counts it only when the reels have stopped', async () => {
    await on(); mount(renderCase, 'starter');
    (el.querySelector('#openBtn') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(300);       // the reels are still turning
    expect(state.inv).toHaveLength(1);                                                                   // the Inventory page (or a refresh) shows it now...
    expect(visibleInventoryCount()).toBe(0);                                                             // ...the counter beside the balance does not
    mount(inventory.render); expect(el.querySelectorAll('.contents .card, .contents > *').length).toBeGreaterThan(0);
    await settle();
    expect(visibleInventoryCount()).toBe(1);
  });
  it('leaving the page mid-spin counts the item at once', async () => {
    await on(); mount(renderCase, 'starter');
    (el.querySelector('#openBtn') as HTMLElement).click(); await vi.advanceTimersByTimeAsync(300);
    expect(visibleInventoryCount()).toBe(0);
    if (typeof leave === 'function') leave(); leave = undefined;
    expect(visibleInventoryCount()).toBe(1);
  });
  it('a won upgrade and a free crate hold their item the same way, and a hold never lasts more than two minutes', async () => {
    await on();
    srv.handlers['open_free_case'] = () => { const e = give(I_P1); return { claimed: true, item: I_P1, uid: e.uid, ticket: 1, value: 0.08, case: 'daily', label: 'Daily case', next: null, nonce: 0 }; };
    await openFreeCase('daily_case');
    expect(state.inv).toHaveLength(1); expect(visibleInventoryCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(visibleInventoryCount()).toBe(1);
    srv.handlers['upgrade_item'] = () => { const t = give(I_K1); return { balance: 100, win: true, roll: 0.1, chance: 0.4, stake: 1, item: I_K1, uid: t.uid, from_item: null, nonce: 1, bet_id: 1 }; };
    await upgradeItem([], 1, I_K1, false);
    expect(state.inv).toHaveLength(2); expect(visibleInventoryCount()).toBe(1);
    releaseItems([state.inv[0]!.uid]); expect(visibleInventoryCount()).toBe(2);
  });
  it('without the server wallet nothing is held', async () => {
    state.inv = [{ uid: 'a', id: I_P1, at: 1 }];
    holdItems(['a']); expect(visibleInventoryCount()).toBe(1);
  });
});
