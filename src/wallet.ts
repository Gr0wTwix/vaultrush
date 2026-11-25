// The server wallet, client side. With a cloud account on a database that has supabase/migrations/0008 to 0012, the balance, the items, the rewards
// state and every game's stake and payout live in the database. This file keeps the page's copy of them fresh (state.balance, state.inv, XP, rakeback,
// streak ...) and wraps the database calls that move coins and items. Nothing here (or anywhere in the browser) can change a balance: the page asks,
// the database decides, the answer comes back with the new balance.
//
// A payout is revealed at the right moment: when a game's result is known before its animation ends (a plinko ball, a coinflip, a battle), the page
// calls holdPayout(); the shown balance leaves that amount out until the animation ends and credit() (see state.ts) reveals it.
import { backendEnabled, call, explain, getClient } from './backend.js';
import { emit, isServerWallet, on, round2, save, setServerWallet, state } from './state.js';
import { ITEM } from './data.js';
import { ensureItems } from './catalogue.js';
import { watchTable } from './live.js';
import { refreshLimits, resetServerLimits } from './rg-server.js';
import type { HistoryBet, InvEntry } from './types.js';
import { toast } from './ui.js';

export const serverWallet = isServerWallet;

export interface Snapshot {
  balance: number; wagered: number; won: number; xp: number; now: number; inventory: InvEntry[] | null;
  rewards: {
    rb_instant: number; rb_daily: number; rb_weekly: number; last_daily: number | null; last_weekly: number | null; calendar_streak: number; calendar_last: string | null;
    promos: string[]; keys_used: number[]; faucet_at: number | null; welcome_at: number | null; daily_case_at: number | null;
  };
}

// ---- the shown balance: what the server says, minus payouts the page is holding back until their animation ends -----------------------------------
let serverBalance = 0, stamp = 0;
const holds: { amount: number; timer: ReturnType<typeof setTimeout> }[] = [];
const pending = (): number => round2(holds.reduce((s, h) => s + h.amount, 0));
let frozen: number | null = null, freezeTimer: ReturnType<typeof setTimeout> | undefined;
function show(): void {
  if (!isServerWallet()) return;                                            // browser-only accounts keep their own balance
  const computed = round2(Math.max(0, serverBalance - pending()));
  const v = frozen === null ? computed : Math.min(frozen, computed);       // while frozen a win stays hidden, a stake (a lower balance) does not
  if (v !== state.balance) { state.balance = v; emit('state', state); }
}
/** The server's answer to something I did. Always newer than any poll that was already on its way. */
export function applyBalance(b: number): void { stamp++; serverBalance = round2(Number(b)); show(); }
/** Keep `amount` out of the shown balance until releasePayout() (or two minutes, whichever comes first, so a lost animation can never hide coins for long). */
export function holdPayout(amount: number, ms = 120_000): void {
  if (!(amount > 0) || !isServerWallet()) return;
  const h = { amount: round2(amount), timer: setTimeout(() => drop(h), ms) };
  holds.push(h); show();
}
function drop(h: (typeof holds)[number]): void { const i = holds.indexOf(h); if (i < 0) return; holds.splice(i, 1); clearTimeout(h.timer); show(); }
export function releasePayout(amount: number): void {
  let left = round2(amount);
  while (left > 0 && holds.length) {
    const h = holds[0] as (typeof holds)[number];
    if (h.amount <= left + 1e-9) { left = round2(left - h.amount); drop(h); } else { h.amount = round2(h.amount - left); left = 0; show(); }
  }
}
export const heldPayouts = (): number => pending();
/** A battle has started and the database may already have paid me: keep the shown balance at what it was after my stake (`spent` = a stake the page has not shown yet) until the animation ends. */
export function freezeBalance(spent = 0, ms = 120_000): void {
  if (frozen !== null || !isServerWallet()) return;
  frozen = round2(Math.max(0, state.balance - spent));
  clearTimeout(freezeTimer); freezeTimer = setTimeout(unfreezeBalance, ms);
  show();
}
export function unfreezeBalance(): void { if (frozen === null) return; frozen = null; clearTimeout(freezeTimer); show(); }

// ---- items ----
// An item the database has just given me is already in the inventory (a refresh or the Inventory page shows it at once), but the counter in the top bar
// leaves it out until the animation that reveals it has ended: holdItems() when the answer arrives, releaseItems() when the reel has stopped.
const heldItems = new Map<string, ReturnType<typeof setTimeout>>();
export function holdItems(uids: string[], ms = 120_000): void {
  if (!isServerWallet()) return;
  for (const u of uids) { clearTimeout(heldItems.get(u)); heldItems.set(u, setTimeout(() => releaseItems([u]), ms)); }
}
export function releaseItems(uids: string[]): void {
  let any = false;
  for (const u of uids) if (heldItems.has(u)) { clearTimeout(heldItems.get(u)); heldItems.delete(u); any = true; }
  if (any) emit('state', state);
}
/** How many items the top bar shows: everything in the inventory except items whose reveal animation has not ended yet. */
export const visibleInventoryCount = (): number => (heldItems.size ? state.inv.reduce((n, e) => n + (heldItems.has(e.uid) ? 0 : 1), 0) : state.inv.length);
export function addInventory(entries: InvEntry[]): void { state.inv = [...entries, ...state.inv]; save(); }
export function dropInventory(uids: string[]): void { const s = new Set(uids); state.inv = state.inv.filter(e => !s.has(e.uid)); save(); }

// ---- the snapshot ---------------------------------------------------------------------------------------------------------------------------------
export function applySnapshot(s: Snapshot, balanceToo = true): void {
  const skew = s.now - Date.now(), local = (t: number | null): number => (t == null ? 0 : t - skew);
  if (balanceToo) { serverBalance = round2(Number(s.balance)); }
  state.stats.wagered = Number(s.wagered); state.stats.won = Number(s.won); state.xp = Number(s.xp);
  const r = s.rewards;
  state.rakeback = { instant: Number(r.rb_instant), daily: Number(r.rb_daily), weekly: Number(r.rb_weekly), lastDaily: local(r.last_daily), lastWeekly: local(r.last_weekly) };
  state.calendar = { streak: r.calendar_streak, last: r.calendar_last ?? '' };
  state.promos = [...r.promos]; state.keysUsed = [...r.keys_used];
  state.welcomeLeft = r.welcome_at ? 0 : 1; state.lastDailyCase = local(r.daily_case_at); state.lastClaim = local(r.faucet_at);
  if (s.inventory) {
    state.inv = s.inventory.map(e => ({ uid: e.uid, id: e.id, at: e.at }));
    // Items from an upgrade are not bundled with the page: fetch the ones the inventory holds, then tell the pages showing them.
    if (state.inv.some(e => !ITEM[e.id])) void ensureItems(state.inv.map(e => e.id)).then(ok => { if (ok) emit('items:loaded'); });
  }
  show(); save();
}

let seq = 0, applied = 0;
/** Ask the server for the current numbers. `full` also loads the inventory (heavier: used at start, after items change and now and then). */
export async function refreshWallet(full = false): Promise<void> {
  if (!isServerWallet()) return;
  const mine = ++seq, was = stamp;
  const s = await call<Snapshot>('wallet_me', { p_inventory: full });
  if (!isServerWallet() || mine < applied) return;                    // signed out meanwhile, or a newer answer has already been applied
  applied = mine;
  applySnapshot(s, stamp === was);                                    // an answer to one of my own calls arrived meanwhile: its balance is newer
}
let refreshTimer = 0, wantFull = false;
export function scheduleRefresh(full = false): void {
  wantFull = wantFull || full;
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => { const f = wantFull; wantFull = false; void refreshWallet(f).catch(() => {}); }, 350);
}

// ---- start and stop -------------------------------------------------------------------------------------------------------------------------------
let stops: (() => void)[] = [], poll = 0, started = '', visibility: (() => void) | null = null, offCredit: (() => void) | null = null, offBalance: (() => void) | null = null, offRefresh: (() => void) | null = null;
/** Hear the pages' messages: a reveal of a held payout ('wallet:credit'), a new balance from an answer ('wallet:balance'), a request to re-sync ('wallet:refresh'). */
export function listenWallet(): void {
  offCredit ??= on<number>('wallet:credit', amount => { releasePayout(amount); scheduleRefresh(); });
  offBalance ??= on<number>('wallet:balance', b => applyBalance(b));
  offRefresh ??= on('wallet:refresh', () => scheduleRefresh());
}
/** After a cloud sign-in: switch the server wallet on if the database has it, load the numbers, and keep them fresh. Resolves true when it is on. */
export async function initWallet(userId: string): Promise<boolean> {
  if (!backendEnabled() || !userId) return false;
  if (started === userId) return isServerWallet();
  started = userId;
  let ok = false;
  try { ok = (await call<boolean>('wallet_ready')) === true; } catch { ok = false; }
  if (started !== userId) return false;                                // signed out (or someone else signed in) while asking
  setServerWallet(ok);
  if (!ok) return false;
  emit('wallet:quiet');                                                   // the first numbers from the server are an account being loaded, not a gain: no glow
  listenWallet();
  try { await refreshWallet(true); } catch { /* the poll below retries */ }
  void refreshLimits().catch(() => {});                                   // the limits and breaks the database holds (older databases without 0018 just fail quietly)
  void loadHistory().catch(() => {});
  void claimRacePrize().then(r => { if (r.paid) toast(`You finished #${r.rank} in yesterday's race: +${r.prize}`, 'win'); }).catch(() => {});
  try {
    stops.push(await watchTable<{ user_id: string; balance: number; wagered: number; won: number }>('wallets', (_ev, row) => {
      if (row.user_id !== userId) return;
      applyBalance(Number(row.balance)); state.stats.wagered = Number(row.wagered); state.stats.won = Number(row.won); state.xp = Math.round(Number(row.wagered) * 10); emit('state', state);
    }));
    stops.push(await watchTable('inventory', () => scheduleRefresh(true)));
  } catch { /* realtime is a bonus: the poll below keeps things fresh */ }
  let n = 0;
  poll = window.setInterval(() => { n++; void refreshWallet(n % 3 === 0).catch(() => {}); }, 20_000);
  visibility = () => { if (document.visibilityState === 'visible') void refreshWallet(false).catch(() => {}); };
  document.addEventListener('visibilitychange', visibility);
  emit('wallet', true);
  return true;
}
export function stopWallet(): void {
  started = ''; stops.forEach(s => s()); stops = []; clearInterval(poll); clearTimeout(refreshTimer); wantFull = false;
  if (visibility) document.removeEventListener('visibilitychange', visibility); visibility = null;
  offCredit?.(); offCredit = null; offBalance?.(); offBalance = null; offRefresh?.(); offRefresh = null;
  holds.splice(0).forEach(h => clearTimeout(h.timer)); heldItems.forEach(t => clearTimeout(t)); heldItems.clear(); frozen = null; clearTimeout(freezeTimer); serverBalance = 0; seq = applied = 0;
  resetServerLimits();
  if (isServerWallet()) { setServerWallet(false); emit('wallet', false); }
}

// ---- history and transactions (the account window) ---------------------------------------------------------------------------------------------
const TX_LABEL: Record<string, string> = { bonus: 'Bonus', faucet: 'Free coins', rakeback: 'Rakeback', calendar: 'Login calendar', promo: 'Promo code', race: 'Race prize', sell: 'Item sale', refund: 'Refund', adjustment: 'Adjustment', crate: 'Crate' };
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export async function loadHistory(): Promise<void> {
  const c = await getClient();
  const bets = await c.from('bets').select('id, game, amount, payout, multiplier, created_at').order('id', { ascending: false }).limit(500);
  const rows = (bets.data as { id: number; game: string; amount: number; payout: number; multiplier: number; created_at: string }[] | null) ?? [];
  state.history = rows.map((b): HistoryBet => ({ id: b.id, game: title(b.game), amount: Number(b.amount), multi: Number(b.multiplier), payout: Number(b.payout), at: Date.parse(b.created_at) }));
  const gs: typeof state.gameStats = {};
  for (const h of state.history) {
    const g = (gs[h.game] ??= { bets: 0, wagered: 0, paid: 0, bestPayout: 0, bestMulti: 0 });
    g.bets++; g.wagered = round2(g.wagered + h.amount); g.paid = round2(g.paid + h.payout); g.bestPayout = Math.max(g.bestPayout, h.payout); g.bestMulti = Math.max(g.bestMulti, h.multi);
  }
  state.gameStats = gs; state.stats.bets = rows.length;
  const led = await c.from('ledger').select('id, kind, amount, created_at').not('kind', 'in', '(bet,win)').order('id', { ascending: false }).limit(150);
  state.tx = (((led.data as { id: number; kind: string; amount: number; created_at: string }[] | null) ?? []).map(t => ({ id: t.id, type: TX_LABEL[t.kind] ?? title(t.kind), amount: Number(t.amount), note: '', at: Date.parse(t.created_at) })));
  save();
}

// ---- the games ---------------------------------------------------------------------------------------------------------------------------------------
export interface OpenedCase { uid: string; item: string; ticket: number; value: number; nonce: number; bet_id: number }
/** Open 1 to 10 cases. The items are in the inventory when this returns; the balance is after the stake. */
export async function openCases(caseId: string, count: number): Promise<{ balance: number; cost: number; opened: OpenedCase[] }> {
  const r = await call<{ balance: number; cost: number; opened: OpenedCase[] }>('open_cases', { p_case: caseId, p_count: count });
  holdItems(r.opened.map(o => o.uid));                                  // in the inventory now, but not counted in the top bar until the reels stop
  addInventory(r.opened.map(o => ({ uid: o.uid, id: o.item, at: Date.now() })));
  applyBalance(r.balance); scheduleRefresh();
  return r;
}
export async function sellItems(uids: string[] | null): Promise<{ balance: number; sold: number; total: number }> {
  const all = uids ?? state.inv.map(e => e.uid);
  const r = await call<{ balance: number; sold: number; total: number }>('sell_items', { p_uids: uids });
  dropInventory(all); applyBalance(r.balance);
  return r;
}
export interface UpgradeResult { balance: number; win: boolean; roll: number; chance: number; stake: number; item: string; uid: string | null; from_item: string | null; nonce: number; bet_id: number }
export async function upgradeItem(uids: string[], coins: number, target: string, over: boolean): Promise<UpgradeResult> {
  const r = await call<UpgradeResult>('upgrade_item', { p_uids: uids, p_coins: coins, p_target: target, p_over: over });
  dropInventory(uids);
  if (r.win && r.uid) { holdItems([r.uid]); addInventory([{ uid: r.uid, id: r.item, at: Date.now() }]); }
  applyBalance(r.balance); scheduleRefresh();
  return r;
}
export interface PlinkoResult { balance: number; payout: number; mult: number; bucket: number; path: number[]; nonce: number; bet_id: number }
/** Drop one ball. The payout is held out of the shown balance until the ball lands (the page calls credit(payout) then). */
export async function plinkoDrop(rows: number, risk: string, amount: number): Promise<PlinkoResult> {
  const r = await call<PlinkoResult>('plinko_drop', { p_rows: rows, p_risk: risk, p_amount: amount });
  holdPayout(Number(r.payout)); applyBalance(r.balance); scheduleRefresh();
  return r;
}

export interface MinesStart { game: number; balance: number; amount: number; grid: number; mines: number; nonce: number; server_hash: string }
export interface MinesPick { bomb: boolean; tile: number; picks?: number[]; mult?: number; next?: number; done?: boolean; status?: 'won' | 'lost'; payout?: number; bombs?: number[]; balance?: number }
export interface MinesEnd { balance: number; payout: number; bombs: number[]; status: 'won' | 'lost' | 'cancelled'; mult?: number }
export interface MinesActive { game: number; amount: number; grid: number; mines: number; picks: number[]; mult: number | null }
export async function minesStart(amount: number, grid: number, mines: number): Promise<MinesStart> {
  const r = await call<MinesStart>('mines_start', { p_amount: amount, p_grid: grid, p_mines: mines });
  applyBalance(r.balance); scheduleRefresh();
  return r;
}
export async function minesPick(game: number, tile: number): Promise<MinesPick> {
  const r = await call<MinesPick>('mines_pick', { p_game: game, p_tile: tile });
  if (r.balance != null) { applyBalance(r.balance); scheduleRefresh(); }
  return r;
}
export async function minesCashout(game: number): Promise<MinesEnd> {
  const r = await call<MinesEnd>('mines_cashout', { p_game: game });
  applyBalance(r.balance); scheduleRefresh();
  return r;
}
export async function minesCancel(game: number): Promise<MinesEnd> {
  const r = await call<MinesEnd>('mines_cancel', { p_game: game });
  applyBalance(r.balance);
  return r;
}
export const minesActive = (): Promise<MinesActive | null> => call<MinesActive | null>('mines_active');

// ---- rewards -----------------------------------------------------------------------------------------------------------------------------------------
export async function claimFaucet(): Promise<{ claimed: boolean; amount?: number; next_at: number; balance: number }> {
  const r = await call<{ claimed: boolean; amount?: number; next_at: number; balance: number }>('claim_faucet');
  applyBalance(r.balance); await refreshWallet(false).catch(() => {});
  return r;
}
export async function claimRakeback(kind: 'instant' | 'daily' | 'weekly'): Promise<{ amount: number; balance: number }> {
  const r = await call<{ amount: number; balance: number }>('claim_rakeback', { p_kind: kind });
  applyBalance(r.balance); await refreshWallet(false).catch(() => {});
  return r;
}
export async function claimCalendar(): Promise<{ day: number; amount: number; balance: number }> {
  const r = await call<{ day: number; amount: number; balance: number }>('claim_calendar');
  applyBalance(r.balance); await refreshWallet(false).catch(() => {});
  return r;
}
export async function redeemPromo(code: string): Promise<{ code: string; amount: number; balance: number }> {
  const r = await call<{ code: string; amount: number; balance: number; error?: string }>('redeem_promo', { p_code: code });
  if (r?.error) throw new Error(explain({ message: r.error }));          // a wrong code is answered (and counted, see 0020), not raised
  applyBalance(r.balance); await refreshWallet(false).catch(() => {});
  return r;
}
export interface FreeCase { claimed: boolean; item?: string; uid?: string; ticket?: number; value?: number; case?: string; label?: string; next?: string | null; nonce?: number }
/** Open a free crate ('welcome', 'daily_case', 'level_10' ...). The item is in the inventory when this returns. */
export async function openFreeCase(kind: string): Promise<FreeCase> {
  const r = await call<FreeCase>('open_free_case', { p_kind: kind });
  if (r.claimed && r.uid && r.item) { holdItems([r.uid]); addInventory([{ uid: r.uid, id: r.item, at: Date.now() }]); }
  await refreshWallet(false).catch(() => {});
  return r;
}
export async function claimRacePrize(): Promise<{ paid: boolean; rank?: number; prize?: number; balance?: number }> {
  const r = await call<{ paid: boolean; rank?: number; prize?: number; balance?: number }>('claim_race_prize');
  if (r.paid && r.balance != null) applyBalance(r.balance);
  return r;
}
