// Daily race: simulated rivals with deterministic totals per day, so standings are stable on reload.
import { BOTS } from './data.js';
import { state, grant, save, todayKey, DAY } from './state.js';

export const PRIZES = [400, 200, 120, 80, 60, 50, 35, 25, 20, 10];

function seeded(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}

const dayStart = key => Date.parse(`${key}T00:00:00Z`);

/** Rival totals for a day at a given fraction of the day (0–1). */
export function rivals(key, progress) {
  const rnd = seeded(key);
  return BOTS.map(name => {
    const final = Math.round((40 + Math.pow(rnd(), 2.2) * 2600) * 100) / 100;
    const curve = Math.pow(progress, 0.85 + rnd() * 0.3);
    return { name, wagered: Math.round(final * curve * 100) / 100 };
  });
}

export function standings(key = todayKey(), now = Date.now()) {
  const progress = Math.min(1, Math.max(0, (now - dayStart(key)) / DAY));
  const mine = state.race.date === key ? state.race.wagered : 0;
  const list = [...rivals(key, progress), { name: state.name, wagered: mine, me: true }];
  list.sort((a, b) => b.wagered - a.wagered);
  return list.map((p, i) => ({ ...p, rank: i + 1, prize: PRIZES[i] || 0 }));
}

export const msToReset = (now = Date.now()) => dayStart(todayKey(now)) + DAY - now;

/** Pay yesterday's prize once, if the player finished in the top 10. Returns the prize or 0. */
export function settlePastRace() {
  const key = state.race.date;
  if (!key || key === todayKey() || state.racePaid === key) return 0;
  state.racePaid = key;
  const me = standings(key, dayStart(key) + DAY).find(p => p.me);
  if (me && me.prize && me.wagered > 0) { grant(me.prize, 'Race prize'); return { prize: me.prize, rank: me.rank }; }
  save();
  return 0;
}
