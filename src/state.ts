// Player state (play money only), persisted in localStorage. In production this lives on the server.
import type { GameState, InvEntry, Item } from './types.js';
import { betBlockReason, defaultRg, recordSettled, recordStake } from './rg.js';
import { defaultKyc } from './kyc.js';
import { activeId, stateKeyFor } from './accounts.js';

let KEY = stateKeyFor(activeId());         // guests use the original key; each signed-in account (browser or cloud) has its own
/** Storage key of the account whose state is loaded now (used by backup import). */
export const stateKey = (): string => KEY;
export const START_BALANCE = 100;
// The free rewards. With a backend these follow the admin site's reward settings (migration 0023, loaded by src/rewards-sync.ts at start-up);
// they are live bindings, so every page that imported them sees the loaded values.
export let FREE_COINS = 25;
export let FREE_COINS_EVERY_MS = 10 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;

// Rakeback rates (share of every wager returned to the player) and the 7-day login calendar.
export const RAKEBACK = { instant: 0.004, daily: 0.003, weekly: 0.003 };
export const CALENDAR: number[] = [1, 2, 3, 5, 8, 12, 25];
/** Use the reward numbers the database pays (called by rewards-sync). Arrays and objects are changed in place. */
export function applyRewardSettings(s: { faucet_amount: number; faucet_minutes: number; rakeback: { instant: number; daily: number; weekly: number }; calendar: number[] }): void {
  FREE_COINS = Number(s.faucet_amount); FREE_COINS_EVERY_MS = Number(s.faucet_minutes) * 60_000;
  RAKEBACK.instant = Number(s.rakeback.instant); RAKEBACK.daily = Number(s.rakeback.daily); RAKEBACK.weekly = Number(s.rakeback.weekly);
  CALENDAR.splice(0, CALENDAR.length, ...s.calendar.map(Number));
}
export const XP_PER_COIN = 10;

/** People who ask their system for less motion start with visual effects off and the fastest reels. They can change both in Settings. */
function prefersReducedMotion(): boolean { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }

export const newGameState = (): GameState => ({
  name: 'You', avatar: '', balance: START_BALANCE, inv: [], lastClaim: 0, muted: false, speed: prefersReducedMotion() ? 'turbo' : 'normal',
  stats: { wagered: 0, won: 0, bets: 0 },
  xp: 0, keysUsed: [],                      // level-case tiers already opened
  rakeback: { instant: 0, daily: 0, weekly: 0, lastDaily: 0, lastWeekly: 0 },
  lastDailyCase: 0, welcomeLeft: 1, promos: [], favs: [],
  calendar: { streak: 0, last: '' },
  race: { date: '', wagered: 0 }, racePaid: '',
  history: [], excludedUntil: 0,
  ui: { chat: true, levelPopup: true, streamer: false, anonymous: false, fx: !prefersReducedMotion(), notify: true, fastOpen: false },
  legal: { termsAt: 0, termsVersion: '' }, gameStats: {}, liveSettled: [], liveCredit: {}, bestDrop: null,
  blocked: [], tx: [], betSeq: 0,
  rg: defaultRg(), kyc: defaultKyc(), aml: { alerts: [], payouts: [], seq: 0 },
});
const defaults = newGameState;

function load(): GameState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<GameState> | null;
    if (!parsed || typeof parsed !== 'object') return defaults();
    const d = defaults();
    // A damaged or hand-edited save must not break the games: every list that is not a list, and a balance that is not a number, falls back to the default.
    const saved: Partial<GameState> = { ...parsed };
    for (const k of Object.keys(d) as (keyof GameState)[]) if (Array.isArray(d[k]) && k in saved && !Array.isArray(saved[k])) delete saved[k];
    if (saved.balance !== undefined && !Number.isFinite(saved.balance)) delete saved.balance;
    const real = (e: { id?: unknown } | null | undefined): boolean => typeof e?.id === 'string' && e.id.startsWith('skin-');       // items of the old invented catalogue no longer exist
    const welcomeLeft = Math.min(1, typeof saved.welcomeLeft === 'number' ? saved.welcomeLeft : 1);   // one welcome crate per account (older saves had three)
    return { ...d, ...saved, inv: (saved.inv ?? d.inv).filter(real), bestDrop: real(saved.bestDrop) ? saved.bestDrop! : null, welcomeLeft, rakeback: { ...d.rakeback, ...saved.rakeback }, stats: { ...d.stats, ...saved.stats }, calendar: { ...d.calendar, ...saved.calendar }, race: { ...d.race, ...saved.race }, ui: { ...d.ui, ...saved.ui }, legal: { ...d.legal, ...saved.legal }, gameStats: { ...saved.gameStats },
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
  try { if (authed) localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep in memory */ }
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

// ---- the server wallet --------------------------------------------------------------------------------------------------
// With a cloud account on a database that has the server wallet (supabase/migrations/0008 to 0012), the balance and the items live in the database and
// state.balance / state.inv are only a mirror of it (src/wallet.ts keeps it fresh). While it is on, the functions below that used to change coins and
// items in the browser change NOTHING: the server does it, so nothing can be minted by editing the page or its storage. debit() only refuses what the
// server would certainly refuse. credit() announces 'wallet:credit' so the page can reveal a payout it was holding back until the animation ended.
let walletServer = false;
export const isServerWallet = (): boolean => walletServer;
export function setServerWallet(on: boolean): void { walletServer = on; }

// Visitors can browse without an account but cannot wager or claim anything. auth.ts sets the real value at start-up and runs the hook
// that opens the login/register popup. The default is "signed in" so code that never starts the UI (the tests) is unaffected.
let authed = true;
let loginHook: (reason: string) => void = () => {};
export const LOGIN_REASON = 'Log in or create a free account to place bets.';
/** Signed out = a blank, throw-away state (no balance, items, seeds or history) that is never written to storage. Signing in loads the real one. */
export function setAuthed(on: boolean, id: string = activeId()): void {
  const next = stateKeyFor(id);
  if (on === authed && (!on || next === KEY)) return;   // signing in as someone else must reload that person's state
  authed = on; if (on) KEY = next;
  Object.assign(state, on ? load() : { ...newGameState(), balance: 0 });
  emit('state', state);
}
export const isAuthed = (): boolean => authed;
export const onLoginRequired = (fn: (reason: string) => void): void => { loginHook = fn; };
/** True when signed in. Otherwise opens the login/register popup and returns false. */
export function requireLogin(reason: string = LOGIN_REASON): boolean { if (!authed) loginHook(reason); return authed; }

/** Take a wager. Returns false if the balance is too low or the player is self-excluded. */
export function debit(amount: number): boolean {
  amount = round2(amount);
  if (!requireLogin()) return false;
  if (walletServer) return amount > 0 && canAfford(amount);        // the server takes the stake (and runs the limits) when the game is played
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
export const debitError = (amount: number): string => (!authed ? LOGIN_REASON : !(amount > 0) ? 'Invalid amount' : (walletServer ? null : betBlockReason(state, amount)) ?? (!canAfford(amount) ? 'Not enough coins. Claim free coins at the top.' : 'Invalid amount'));

export function credit(amount: number): void {
  if (!(amount > 0)) return;
  if (walletServer) { emit('wallet:credit', amount); return; }     // the server already paid it; this only reveals it
  state.balance = round2(state.balance + amount);
  state.stats.won = round2(state.stats.won + amount);
  save();
}

/** Bonus money (rewards, promo codes) doesn't count as winnings. */
export function grant(amount: number, type = 'Bonus'): void {
  if (!(amount > 0) || !requireLogin('Log in or create a free account to claim rewards.')) return;
  if (walletServer) return;                                        // rewards are claimed from the server (src/wallet.ts)
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
  if (walletServer) return [];                                     // items are given by the server only
  const entries = items.map(it => ({ uid: uid(), id: it.id, at: Date.now() }));
  state.inv.unshift(...entries);
  save();
  return entries;
}

export function removeItems(uids: string[]): void {
  if (walletServer) return;
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
