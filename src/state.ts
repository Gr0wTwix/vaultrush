// Player state (play money only), persisted in localStorage. In production this lives on the server.
import type { GameState, InvEntry, Item } from './types.js';
import { betBlockReason, defaultRg, recordSettled, recordStake } from './rg.js';
import { defaultKyc } from './kyc.js';
import { activeId, stateKeyFor } from './accounts.js';

const KEY = stateKeyFor(activeId());       // guests use the original key; each signed-in account has its own
export const START_BALANCE = 100;
export const FREE_COINS = 25;
export const FREE_COINS_EVERY_MS = 10 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;

// Rakeback rates (share of every wager returned to the player).
export const RAKEBACK = { instant: 0.004, daily: 0.003, weekly: 0.003 } as const;
export const XP_PER_COIN = 10;

export const newGameState = (): GameState => ({
  name: 'You', balance: START_BALANCE, inv: [], lastClaim: 0, muted: false, speed: 'normal',
  stats: { wagered: 0, won: 0, bets: 0 },
  xp: 0, keysUsed: [],                      // level-case tiers already opened
  rakeback: { instant: 0, daily: 0, weekly: 0, lastDaily: 0, lastWeekly: 0 },
  lastDailyCase: 0, welcomeLeft: 3, promos: [], favs: [],
  calendar: { streak: 0, last: '' },
  race: { date: '', wagered: 0 }, racePaid: '',
  history: [], excludedUntil: 0,
  ui: { chat: true, levelPopup: true, streamer: false, anonymous: false, fx: true, notify: true },
  legal: { termsAt: 0, termsVersion: '' }, gameStats: {}, bestDrop: null,
  blocked: [], tx: [], betSeq: 0,
  rg: defaultRg(), kyc: defaultKyc(), aml: { alerts: [], payouts: [], seq: 0 },
});
const defaults = newGameState;

function load(): GameState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Partial<GameState>;
    const d = defaults();
    return { ...d, ...saved, rakeback: { ...d.rakeback, ...saved.rakeback }, stats: { ...d.stats, ...saved.stats }, calendar: { ...d.calendar, ...saved.calendar }, race: { ...d.race, ...saved.race }, ui: { ...d.ui, ...saved.ui }, legal: { ...d.legal, ...saved.legal }, gameStats: { ...saved.gameStats },
      rg: { ...d.rg, ...saved.rg, limits: { ...d.rg.limits, ...saved.rg?.limits } }, kyc: { ...d.kyc, ...saved.kyc }, aml: { ...d.aml, ...saved.aml } };
  } catch { return defaults(); }
}

export const state: GameState = load();
/** One-off values passed between pages (e.g. "Upgrade win" carries battle winnings to the upgrader). */
export const handoff: Record<string, any> = {};
export const bus = new EventTarget();
export const emit = (type: string, detail?: unknown): boolean => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = <T = any>(type: string, fn: (detail: T) => void): (() => void) => {
  const h = (e: Event) => fn((e as CustomEvent<T>).detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
};

export function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep in memory */ }
  emit('state', state);
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const canAfford = (n: number): boolean => state.balance + 1e-9 >= n;
export const todayKey = (t: number = Date.now()): string => new Date(t).toISOString().slice(0, 10);

// ---- levels ------------------------------------------------------------------------------------
export const levelFromXp = (xp: number): number => Math.floor(Math.sqrt(xp / 10));
export const xpForLevel = (lvl: number): number => lvl * lvl * 10;
export const level = (): number => levelFromXp(state.xp);

export function isExcluded(): boolean { return state.excludedUntil > Date.now(); }

/** Take a wager. Returns false if the balance is too low or the player is self-excluded. */
export function debit(amount: number): boolean {
  amount = round2(amount);
  if (!(amount > 0) || !canAfford(amount) || betBlockReason(state, amount)) return false;
  const before = level();
  state.balance = round2(state.balance - amount);
  state.stats.wagered = round2(state.stats.wagered + amount);
  state.stats.bets++;
  recordStake(state.rg, amount);
  // Every wager feeds XP, rakeback and today's race total.
  state.xp += Math.round(amount * XP_PER_COIN);
  state.rakeback.instant += amount * RAKEBACK.instant;
  state.rakeback.daily += amount * RAKEBACK.daily;
  state.rakeback.weekly += amount * RAKEBACK.weekly;
  const today = todayKey();
  if (state.race.date !== today) state.race = { date: today, wagered: 0 };
  state.race.wagered = round2(state.race.wagered + amount);
  save();
  const after = level();
  if (after > before) emit('levelup', after);
  return true;
}

/** Why a bet was refused, for the toast. */
export const debitError = (amount: number): string => (!(amount > 0) ? 'Invalid amount' : betBlockReason(state, amount) ?? (!canAfford(amount) ? 'Not enough coins. Claim free coins at the top.' : 'Invalid amount'));

export function credit(amount: number): void {
  if (!(amount > 0)) return;
  state.balance = round2(state.balance + amount);
  state.stats.won = round2(state.stats.won + amount);
  save();
}

/** Bonus money (rewards, promo codes) doesn't count as winnings. */
export function grant(amount: number, type = 'Bonus'): void {
  if (!(amount > 0)) return;
  state.balance = round2(state.balance + amount);
  logTx(type, amount);
  save();
}

/** Coin and item movements that are not bets: shown on the Transactions tab. `note` is free text (e.g. the item won). */
export function logTx(type: string, amount: number, note = ''): void {
  state.tx.unshift({ id: (state.tx[0]?.id ?? 1000) + 1, type, amount: round2(amount), note, at: Date.now() });
  state.tx.length = Math.min(state.tx.length, 300);
}

const uid = (): string => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export function addItems(items: Pick<Item, 'id'>[]): InvEntry[] {
  const entries = items.map(it => ({ uid: uid(), id: it.id, at: Date.now() }));
  state.inv.unshift(...entries);
  save();
  return entries;
}

export function removeItems(uids: string[]): void {
  const set = new Set(uids);
  state.inv = state.inv.filter(e => !set.has(e.uid));
  save();
}

export function recordBet(b: { game: string; amount: number; multi: number; payout: number }): void {
  state.history.unshift({ id: ++state.betSeq, game: b.game, amount: b.amount, multi: b.multi, payout: b.payout, at: Date.now() });
  state.history.length = Math.min(state.history.length, 500);
  recordSettled(state.rg, b.amount, b.payout);
  const gs = (state.gameStats[b.game] ??= { bets: 0, wagered: 0, paid: 0, bestPayout: 0, bestMulti: 0 });
  gs.bets++; gs.wagered = round2(gs.wagered + b.amount); gs.paid = round2(gs.paid + b.payout);
  gs.bestPayout = Math.max(gs.bestPayout, b.payout); gs.bestMulti = Math.max(gs.bestMulti, b.multi);
  save();
}

export function resetAccount(): void {
  Object.assign(state, defaults());
  save();
}
