// Player state (play money only), persisted in localStorage. In production this lives on the server.
const KEY = 'vaultrush.state.v1';
export const START_BALANCE = 100;
export const FREE_COINS = 25;
export const FREE_COINS_EVERY_MS = 10 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;

// Rakeback rates (share of every wager returned to the player).
export const RAKEBACK = { instant: 0.004, daily: 0.003, weekly: 0.003 };
export const XP_PER_COIN = 10;

const defaults = () => ({
  name: 'You', balance: START_BALANCE, inv: [], lastClaim: 0, muted: false, speed: 'normal',
  stats: { wagered: 0, won: 0, bets: 0 },
  xp: 0, keysUsed: [],                      // level-case tiers already opened
  rakeback: { instant: 0, daily: 0, weekly: 0, lastDaily: 0, lastWeekly: 0 },
  lastDailyCase: 0, welcomeLeft: 3, promos: [], favs: [],
  calendar: { streak: 0, last: '' },
  race: { date: '', wagered: 0 }, racePaid: '',
  history: [], excludedUntil: 0,
  ui: { chat: true, levelPopup: true, streamer: false },
  blocked: [], tx: [], betSeq: 0,
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);
    const d = defaults();
    return { ...d, ...saved, rakeback: { ...d.rakeback, ...saved.rakeback }, stats: { ...d.stats, ...saved.stats }, calendar: { ...d.calendar, ...saved.calendar }, race: { ...d.race, ...saved.race }, ui: { ...d.ui, ...saved.ui } };
  } catch { return defaults(); }
}

export const state = load();
/** One-off values passed between pages (e.g. "Upgrade win" carries battle winnings to the upgrader). */
export const handoff = {};
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => { const h = e => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); };

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep in memory */ }
  emit('state', state);
}

export const round2 = n => Math.round(n * 100) / 100;
export const canAfford = n => state.balance + 1e-9 >= n;
export const todayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// ---- levels ------------------------------------------------------------------------------------
export const levelFromXp = xp => Math.floor(Math.sqrt(xp / 10));
export const xpForLevel = lvl => lvl * lvl * 10;
export const level = () => levelFromXp(state.xp);

export function isExcluded() { return state.excludedUntil > Date.now(); }

/** Take a wager. Returns false if the balance is too low or the player is self-excluded. */
export function debit(amount) {
  amount = round2(amount);
  if (!(amount > 0) || !canAfford(amount) || isExcluded()) return false;
  const before = level();
  state.balance = round2(state.balance - amount);
  state.stats.wagered = round2(state.stats.wagered + amount);
  state.stats.bets++;
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
export const debitError = amount => (isExcluded() ? 'Self-exclusion is active. Betting is paused.' : !canAfford(amount) ? 'Not enough coins. Claim free coins at the top.' : 'Invalid amount');

export function credit(amount) {
  if (!(amount > 0)) return;
  state.balance = round2(state.balance + amount);
  state.stats.won = round2(state.stats.won + amount);
  save();
}

/** Bonus money (rewards, promo codes) doesn't count as winnings. */
export function grant(amount, type = 'Bonus') {
  if (!(amount > 0)) return;
  state.balance = round2(state.balance + amount);
  logTx(type, amount);
  save();
}

/** Coin and item movements that are not bets: shown on the Transactions tab. `note` is free text (e.g. the item won). */
export function logTx(type, amount, note = '') {
  state.tx.unshift({ id: (state.tx[0]?.id ?? 1000) + 1, type, amount: round2(amount), note, at: Date.now() });
  state.tx.length = Math.min(state.tx.length, 300);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export function addItems(items) {
  const entries = items.map(it => ({ uid: uid(), id: it.id, at: Date.now() }));
  state.inv.unshift(...entries);
  save();
  return entries;
}

export function removeItems(uids) {
  const set = new Set(uids);
  state.inv = state.inv.filter(e => !set.has(e.uid));
  save();
}

export function recordBet(b) {
  state.history.unshift({ id: ++state.betSeq, game: b.game, amount: b.amount, multi: b.multi, payout: b.payout, at: Date.now() });
  state.history.length = Math.min(state.history.length, 500);
  save();
}

export function resetAccount() {
  Object.assign(state, defaults());
  save();
}
