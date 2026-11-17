// Live drops + live bets. Simulated bots stand in for the WebSocket feed a real backend would push.
import { CASES, randomBot } from './data.js';
import { emit, recordBet } from './state.js';

export const drops = [];
export const bets = [];

export function pushDrop(d) {
  drops.unshift({ ...d, at: Date.now() });
  drops.length = Math.min(drops.length, 30);
  emit('drop', drops[0]);
}

export function pushBet(b) {
  if (b.mine) recordBet(b);
  bets.unshift({ ...b, at: Date.now() });
  bets.length = Math.min(bets.length, 40);
  emit('bet', bets[0]);
}

const rnd = (a, b) => a + Math.random() * (b - a);
const pickBy = (entries, key) => {
  const sum = entries.reduce((s, e) => s + e[key], 0);
  let x = Math.random() * sum;
  for (const e of entries) { if ((x -= e[key]) < 0) return e; }
  return entries[0];
};

function simDrop() {
  const c = pickBy(CASES.map(c => ({ c, w: 1 / Math.sqrt(c.price) })), 'w').c;
  const e = pickBy(c.entries, 'weight');
  pushDrop({ user: randomBot(), item: e.item, source: c.name });
}

function simBet() {
  const games = ['Crash', 'Mines', 'Upgrade', 'Cases', 'Battles', 'Double', 'Plinko', 'Coinflip'];
  const game = games[Math.floor(Math.random() * games.length)];
  const amount = Math.round(Math.exp(rnd(-1.5, 5)) * 100) / 100;
  const lost = Math.random() < 0.5;
  const multi = lost ? 0 : Math.round((1 + Math.pow(Math.random(), 3) * (Math.random() < 0.05 ? 60 : 6)) * 100) / 100;
  pushBet({ user: randomBot(), game, amount, multi, payout: Math.round(amount * multi * 100) / 100 });
}

export function startFeed() {
  for (let i = 0; i < 16; i++) simDrop();
  for (let i = 0; i < 14; i++) simBet();
  setInterval(simDrop, 2300);
  setInterval(simBet, 1600);
}
