// Daily race: simulated rivals with deterministic totals per day, so standings are stable on reload.
import { BOTS } from './data.js';
import { state, grant, save, todayKey, DAY, isAuthed, isServerWallet } from './state.js';

export interface RaceRow { name: string; wagered: number; me?: boolean }
export interface RankedRow extends RaceRow { rank: number; prize: number }

export const PRIZES = [400, 200, 120, 80, 60, 50, 35, 25, 20, 10];

function seeded(str: string): () => number {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}

const dayStart = (key: string): number => Date.parse(`${key}T00:00:00Z`);

/** Rival totals for a day at a given fraction of the day (0–1). */
export function rivals(key: string, progress: number): RaceRow[] {
  const rnd = seeded(key);
  return BOTS.map(name => {
    const final = Math.round((40 + Math.pow(rnd(), 2.2) * 2600) * 100) / 100;
    const curve = Math.pow(progress, 0.85 + rnd() * 0.3);
    return { name, wagered: Math.round(final * curve * 100) / 100 };
  });
}

/** With the server wallet the board is made of real players: today's and yesterday's standings as the database counts them (wagered coins of every game). */
let real: { today: { name: string; wagered: number }[]; prev: { name: string; wagered: number }[] } | null = null;
export const setRealRace = (r: typeof real): void => { real = r; };

export function standings(key: string = todayKey(), now: number = Date.now()): RankedRow[] {
  if (real && isServerWallet()) {
    const rows = key === todayKey() ? real.today : key === todayKey(Date.parse(`${todayKey()}T00:00:00Z`) - DAY) ? real.prev : [];
    const list: RaceRow[] = rows.map(r => ({ name: r.name, wagered: r.wagered, me: isAuthed() && r.name === state.name }));
    if (key === todayKey() && isAuthed() && !list.some(p => p.me)) list.push({ name: state.name, wagered: 0, me: true });
    list.sort((a, b) => b.wagered - a.wagered);
    return list.map((p, i) => ({ ...p, rank: i + 1, prize: PRIZES[i] ?? 0 }));
  }
  const progress = Math.min(1, Math.max(0, (now - dayStart(key)) / DAY));
  const mine = state.race.date === key ? state.race.wagered : 0;
  const list: RaceRow[] = [...rivals(key, progress), ...(isAuthed() ? [{ name: state.name, wagered: mine, me: true }] : [])];
  list.sort((a, b) => b.wagered - a.wagered);
  return list.map((p, i) => ({ ...p, rank: i + 1, prize: PRIZES[i] ?? 0 }));
}

export const msToReset = (now: number = Date.now()): number => dayStart(todayKey(now)) + DAY - now;

/** Pay yesterday's prize once, if the player finished in the top 10. Returns the prize or 0. */
export function settlePastRace(): 0 | { prize: number; rank: number } {
  const key = state.race.date;
  if (!key || key === todayKey() || state.racePaid === key) return 0;
  state.racePaid = key;
  const me = standings(key, dayStart(key) + DAY).find(p => p.me);
  if (me && me.prize && me.wagered > 0) { grant(me.prize, 'Race prize'); return { prize: me.prize, rank: me.rank }; }
  save();
  return 0;
}
