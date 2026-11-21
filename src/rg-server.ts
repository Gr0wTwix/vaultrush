// Responsible-play limits that live in the database (migration 0018). With the server wallet on, the database is the only thing that refuses a stake:
// the loss, wager and play-time limits, the maximum bet, cool-offs and self-exclusion are all kept and enforced there, so a reloaded, edited or second browser
// cannot get around them. This file asks the database to change a limit or start a break, reads back what it holds (and how much of each limit is used),
// and mirrors it into state.rg so the rest of the page shows the same thing. Without the server wallet nothing here does anything: rg.ts keeps the browser's rules.
import { call } from './backend.js';
import type { ServerLimitName, ServerLimits } from './backend.js';
import { HOUR, startCoolOff } from './rg.js';
import { isServerWallet, save, state } from './state.js';
import type { RgLimitKey } from './types.js';

/** The page's names for the limits the database holds, and the database's names for them (the other limit, the reality check, only exists in the page). */
export const SERVER_NAME = { lossDaily: 'loss_daily', lossWeekly: 'loss_weekly', lossMonthly: 'loss_monthly', wagerDaily: 'wager_daily', maxBet: 'max_bet', timeDailyMin: 'time_daily_min' } as const satisfies Record<string, ServerLimitName>;
export type ServerLimitKey = keyof typeof SERVER_NAME;
const KEYS = Object.keys(SERVER_NAME) as ServerLimitKey[];
const PAGE_KEY = Object.fromEntries(KEYS.map(k => [SERVER_NAME[k], k])) as Record<ServerLimitName, ServerLimitKey>;
export const isServerLimit = (key: RgLimitKey): key is ServerLimitKey => key in SERVER_NAME;

export interface LimitUsage { stakedToday: number; loss1: number; loss7: number; loss30: number; activeMinutes: number }
let usage: LimitUsage | null = null, fetchedAt = 0, adopted = false;
/** What the database counted for this player when it was last asked, or null before the first answer (and always null without the server wallet). */
export const serverUsage = (): LimitUsage | null => (isServerWallet() ? usage : null);
export const limitsFetchedAt = (): number => fetchedAt;
/** Forget everything (signing out). */
export function resetServerLimits(): void { usage = null; fetchedAt = 0; adopted = false; }

const num = (v: number | string | null): number | null => (v === null || v === undefined ? null : Number(v));
const serverLimits = () => call<ServerLimits>('my_limits');
const requestServerLimit = (key: ServerLimitName, value: number | null) => call<'applied' | 'pending' | 'same'>('request_limit_change', { p_key: key, p_value: value });
const serverSelfExclude = (hours: number) => call<string>('self_exclude', { p_hours: hours });
const serverCoolOff = (hours: number) => call<string>('start_cool_off', { p_hours: hours });

/** Put the database's limits, pending changes, break dates and usage into the page's state. Times are shifted by the difference between the two clocks. */
export function applyServerLimits(s: ServerLimits): void {
  const rg = state.rg, skew = s.now - Date.now(), local = (t: number | null): number => (t == null ? 0 : t - skew);
  for (const k of KEYS) (rg.limits as unknown as Record<string, number | null>)[k] = num(s.limits[SERVER_NAME[k]]);
  rg.pending = [
    ...rg.pending.filter(p => !isServerLimit(p.key)),                                    // the reality check is not on the server: its own pending change stays
    ...s.pending.map(p => ({ key: PAGE_KEY[p.key], value: num(p.value), effectiveAt: local(p.effective_at) })),
  ];
  rg.coolOffUntil = local(s.cool_off_until); state.excludedUntil = local(s.excluded_until);
  usage = { stakedToday: Number(s.usage.staked_today), loss1: Number(s.usage.loss_1), loss7: Number(s.usage.loss_7), loss30: Number(s.usage.loss_30), activeMinutes: Number(s.usage.active_minutes) };
  fetchedAt = Date.now();
  save();
}

/** Limits and breaks this browser kept before the database knew about them (an account that played in the browser, or before migration 0018): copy the stricter
 *  ones over once, so switching to the database never loosens anything. A looser local value is ignored. Failures are ignored too: the next load tries again. */
async function adoptLocal(s: ServerLimits): Promise<boolean> {
  const rg = state.rg, skew = s.now - Date.now(), now = Date.now();
  let changed = false;
  for (const k of KEYS) {
    const mine = rg.limits[k], theirs = num(s.limits[SERVER_NAME[k]]);
    if (mine !== null && (theirs === null || mine < theirs)) { try { await requestServerLimit(SERVER_NAME[k], mine); changed = true; } catch { /* try again next time */ } }
  }
  const hours = (until: number, max: number): number => Math.min(max, Math.ceil((until - now) / HOUR));
  const serverExcl = s.excluded_until == null ? 0 : s.excluded_until - skew, serverCool = s.cool_off_until == null ? 0 : s.cool_off_until - skew;
  if (state.excludedUntil > Math.max(now, serverExcl) + 60_000) { try { await serverSelfExclude(Math.max(1, hours(state.excludedUntil, 24 * 365))); changed = true; } catch { /* next time */ } }
  if (rg.coolOffUntil > Math.max(now, serverCool) + 60_000) { try { await serverCoolOff(Math.max(1, hours(rg.coolOffUntil, 24 * 30))); changed = true; } catch { /* next time */ } }
  return changed;
}

/** Read the database's view of this player's limits into the page. Does nothing without the server wallet. Throws when the database cannot be reached. */
export async function refreshLimits(): Promise<void> {
  if (!isServerWallet()) return;
  let s = await serverLimits();
  if (!isServerWallet()) return;                                                         // signed out meanwhile
  if (!adopted) { adopted = true; if (await adoptLocal(s)) s = await serverLimits(); }
  if (isServerWallet()) applyServerLimits(s);
}

/** Change a limit. Tighter applies now; looser or off waits 24 hours (the database decides, and says which). Throws with a readable message when refused. */
export async function setServerLimit(key: ServerLimitKey, value: number | null): Promise<'applied' | 'pending' | 'same'> {
  const r = await requestServerLimit(SERVER_NAME[key], value === null ? null : Math.round(value * 100) / 100);
  await refreshLimits().catch(() => {});
  return r;
}
/** Cancel a change that is waiting: asking for the value the limit has now. */
export async function cancelServerLimit(key: ServerLimitKey): Promise<void> {
  await requestServerLimit(SERVER_NAME[key], state.rg.limits[key]);
  await refreshLimits().catch(() => {});
}

/** A cool-off or a self-exclusion for `ms` (at least an hour). With the server wallet the database keeps it (and can only ever lengthen it); otherwise the browser does.
 *  Resolves to the moment it ends. */
export async function takeBreak(kind: 'cool-off' | 'self-exclusion', ms: number): Promise<number> {
  const hours = Math.max(1, Math.ceil(ms / HOUR));
  if (!isServerWallet()) {
    if (kind === 'cool-off') return startCoolOff(state.rg, ms);
    state.excludedUntil = Math.max(state.excludedUntil, Date.now() + ms); save(); return state.excludedUntil;
  }
  const until = Date.parse(kind === 'cool-off' ? await serverCoolOff(hours) : await serverSelfExclude(hours));         // when the database says it ends
  await refreshLimits().catch(() => {});
  return Number.isFinite(until) ? until : kind === 'cool-off' ? state.rg.coolOffUntil : state.excludedUntil;
}
