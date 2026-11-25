// Staff events on the game site (admin step E part 2, migration 0024): races with their own window and prizes, real coin rain, and giveaways
// with a checkable draw. Everything here asks the database; without a backend (or before 0024) the calls fail quietly and nothing is shown.
import { call, getClient } from './backend.js';

export interface RaceTop { rank: number; name: string; wagered: number; prize: number }
export interface Race { id: number; name: string; starts_at: string; ends_at: string; prizes: number[]; games: string[]; state: 'upcoming' | 'running' | 'ended' | 'paid' | 'cancelled'; pool: number; top: RaceTop[]; me: { rank: number; wagered: number } | null }
export interface RainOpen { id: number; pot: number; ends_at: string; min_level: number; joiners: number; joined: boolean }
export interface RainLast { id: number; pot: number; joiners: number; share: number; mine: boolean }
export interface RainNow { open: RainOpen | null; last: RainLast | null; now: number }
export interface Giveaway { id: number; title: string; prize: number; winners: number; min_level: number; starts_at: string; ends_at: string; server_hash: string; state: 'upcoming' | 'open' | 'ended' | 'drawn' | 'cancelled'; entries: number; entered: boolean; seed: string | null; drawn: { place: number; entry_no: number; name: string }[] | null }

export const races = (): Promise<Race[]> => call<Race[]>('races_public').catch(() => []);
export const rainNow = (): Promise<RainNow | null> => call<RainNow>('rain_now').catch(() => null);
export const joinRain = (id: number): Promise<{ joined: boolean; joiners: number }> => call('join_rain', { p_id: id });
export const giveaways = (): Promise<Giveaway[]> => call<Giveaway[]>('giveaways_public').catch(() => []);
export const enterGiveaway = (id: number): Promise<{ entered: boolean; entries: number }> => call('enter_giveaway', { p_id: id });
export const giveawayEntries = (id: number): Promise<{ entry_no: number; name: string }[]> => call<{ entry_no: number; name: string }[]>('giveaway_entries_public', { p_id: id }).catch(() => []);

/** Tells the page when a rain starts, ends or is cancelled (the rains table is in the realtime feed). Returns a stop function. */
export async function watchRains(cb: () => void): Promise<() => void> {
  const c = await getClient();
  const ch = c.channel(`rains-${Math.random().toString(36).slice(2, 8)}`).on('postgres_changes', { event: '*', schema: 'public', table: 'rains' }, () => cb()).subscribe();
  return () => { void c.removeChannel(ch); };
}

/** How a giveaway's winners are picked, for anyone checking a draw: the entries with the lowest SHA-256("<seed>:<entry number>") win. */
export async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function drawOrder(seed: string, entryNos: number[]): Promise<number[]> {
  const scored = await Promise.all(entryNos.map(async n => ({ n, h: await sha256Hex(`${seed}:${n}`) })));
  return scored.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.n - b.n)).map(x => x.n);
}
