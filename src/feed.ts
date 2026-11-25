// Live drops + live bets. Simulated bots stand in for the WebSocket feed a real backend would push.
import { CASES, ITEM, randomBot } from './data.js';
import { ensureItems } from './catalogue.js';
import { listenFeed, shareBet, shareDrop } from './live.js';
import { emit, recordBet, save, state } from './state.js';
import type { Drop, Item, LiveBet } from './types.js';
import { GS } from './game-settings.js';

export const drops: Drop[] = [];
export const bets: LiveBet[] = [];

/** Anonymous mode hides the player's own name in everything other players can see. */
export const shownName = (user: string): string => (user === state.name && state.ui.anonymous ? 'Anonymous' : user);

export function pushDrop(d: { user: string; item: Item; source: string }): void {
  if (d.user === state.name && (!state.bestDrop || d.item.value > state.bestDrop.value)) { state.bestDrop = { id: d.item.id, source: d.source, value: d.item.value }; save(); }
  if (d.user === state.name) shareDrop({ user: shownName(d.user), itemId: d.item.id, source: d.source });   // other players see it when live games are on
  d = { ...d, user: shownName(d.user) };
  drops.unshift({ ...d, at: Date.now() });
  drops.length = Math.min(drops.length, 30);
  emit('drop', drops[0]);
}

export function pushBet(b: Omit<LiveBet, 'at'>): void {
  if (b.mine) { recordBet(b); shareBet({ user: shownName(b.user), game: b.game, amount: b.amount, multi: b.multi, payout: b.payout }); }
  bets.unshift({ ...b, user: shownName(b.user), at: Date.now() });
  bets.length = Math.min(bets.length, 40);
  emit('bet', bets[0]);
}

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
function pickBy<T extends Record<K, number>, K extends string>(entries: T[], key: K): T {
  const sum = entries.reduce((s, e) => s + e[key], 0);
  let x = Math.random() * sum;
  for (const e of entries) { if ((x -= e[key]) < 0) return e; }
  return entries[0] as T;
}

function simDrop(): void {
  if (!GS.simulated) return;                                       // the admin site can switch the made-up activity off (0025)
  const c = pickBy(CASES.map(c => ({ c, w: 1 / Math.sqrt(c.price) })), 'w').c;
  const e = pickBy(c.entries, 'weight');
  pushDrop({ user: randomBot(), item: e.item, source: c.name });
}

function simBet(): void {
  if (!GS.simulated) return;
  const games = ['Crash', 'Mines', 'Upgrade', 'Cases', 'Battles', 'Double', 'Plinko', 'Coinflip'];
  const game = games[Math.floor(Math.random() * games.length)] as string;
  const amount = Math.round(Math.exp(rnd(-1.5, 5)) * 100) / 100;
  const lost = Math.random() < 0.5;
  const multi = lost ? 0 : Math.round((1 + Math.pow(Math.random(), 3) * (Math.random() < 0.05 ? 60 : 6)) * 100) / 100;
  pushBet({ user: randomBot(), game, amount, multi, payout: Math.round(amount * multi * 100) / 100 });
}

export function startFeed(): void {
  // Real players' bets and drops (live games only): shown like any other, never re-shared and never counted as mine.
  listenFeed(b => pushBet({ ...b, mine: false }), d => {
    const show = (): void => { const item = ITEM[d.itemId]; if (item) pushDrop({ user: d.user, item, source: d.source }); };
    if (ITEM[d.itemId]) show(); else void ensureItems([d.itemId]).then(show);       // an item from an upgrade is not bundled: fetch it first
  });
  for (let i = 0; i < 16; i++) simDrop();
  for (let i = 0; i < 14; i++) simBet();
  setInterval(simDrop, 2300);
  setInterval(simBet, 1600);
}
