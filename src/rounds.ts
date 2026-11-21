// Shared Crash and Double rounds (client side). The server (supabase/migrations/0005_rounds.sql) runs one round per game by the clock and
// every player bets into it; this file wraps the calls, keeps a clock that agrees with the server, watches changes in real time, and
// pays this browser what the server says its bets are worth, once. Stakes and payouts stay in the browser (play money).
import { call, getClient } from './backend.js';
import { state, save, credit, round2, isServerWallet } from './state.js';
import { liveMe, onReconcile, settleOnce, tellBalance, watchTable } from './live.js';
import { emit } from './state.js';
import { pushBet } from './feed.js';
import { fmt, toast } from './ui.js';

export interface Round {
  id: number; game: 'crash' | 'double'; status: 'betting' | 'running' | 'finished'; created_at: string; betting_ends_at: string;
  finished_at: string | null; server_hash: string; result: { point?: number; n?: number } | null;
}
export interface RoundBet {
  id: number; round_id: number; user_id: string; display_name: string; lane: string; amount: number; auto_cashout: number | null;
  riding: number; locked: number; cashouts: number[]; done: boolean;
}
export interface CashoutResult { mult: number; take: number; got: number; riding: number; locked: number; done: boolean; bet: RoundBet }

// ---- a clock that agrees with the server's -----------------------------------------------------------------------------
let offset = 0;                                              // server time minus this browser's time, in ms
export const serverNow = (): number => Date.now() + offset;
let confirmedAt = 0;                                          // the server's own time in its latest answer: up to then the round was certainly still running
export const confirmedNow = (): number => confirmedAt;
/** How far behind the server's clock the Crash number is shown. */
export const DISPLAY_LAG_MS = 400;
/**
 * Milliseconds of a running Crash round to show (the multiplier is e^(CRASH_GROWTH x this)). The page only learns that a round crashed some moments after it
 * happened (the server decides when somebody asks), so the number is shown a little behind the server's clock, and NEVER beyond the last moment the server
 * confirmed the round was still running. That way it can fall behind for a moment, but it can never climb past the number the round then crashes at.
 */
export const liveElapsed = (now: number, confirmed: number, start: number): number => Math.max(0, Math.min(now - DISPLAY_LAG_MS, confirmed) - start);

/** Do whatever is due on the server (open, start or finish a round) and return the current round. Safe to call as often as needed. */
export async function advanceRound(game: 'crash' | 'double'): Promise<Round> {
  const t0 = Date.now();
  const r = await call<{ round: Round; now: string }>('advance_round', { p_game: game });
  offset = Date.parse(r.now) - (t0 + Date.now()) / 2;       // assume the reply took the same time each way
  confirmedAt = Math.max(confirmedAt, Date.parse(r.now));
  return r.round;
}

// ---- bets --------------------------------------------------------------------------------------------------------------------
const anon = (): boolean => !!state.ui.anonymous;
export const crashBet = (round: number, amount: number, auto: number | null) => call<RoundBet & { balance?: number }>('crash_place_bet', { p_round: round, p_amount: amount, p_auto: auto, p_anon: anon() }).then(tellBalance);
export const crashCancel = (round: number) => call<number>('crash_cancel_bet', { p_round: round }).then(a => { emit('wallet:refresh'); return a; });
export const crashCashout = (round: number, frac: number) => call<CashoutResult & { balance?: number }>('crash_cashout', { p_round: round, p_frac: frac }).then(tellBalance);
export const doubleBet = (round: number, lane: string, amount: number) => call<RoundBet & { balance?: number }>('double_place_bet', { p_round: round, p_lane: lane, p_amount: amount, p_anon: anon() }).then(tellBalance);

export async function roundBets(roundId: number): Promise<RoundBet[]> {
  const { data } = await (await getClient()).from('round_bets').select('*').eq('round_id', roundId).order('id');
  return ((data as RoundBet[] | null) ?? []).map(norm);
}
/** The latest finished rounds' results (newest first), for the history strip. */
/** The last finished rounds, newest first, with their round ids (so a page can tell which ones it has already shown). */
export async function recentRounds(game: 'crash' | 'double', n: number): Promise<{ id: number; v: number }[]> {
  const { data } = await (await getClient()).from('game_rounds').select('id, result').eq('game', game).eq('status', 'finished').order('id', { ascending: false }).limit(n);
  return ((data as { id: number; result: { point?: number; n?: number } | null }[] | null) ?? []).map(r => ({ id: r.id, v: game === 'crash' ? r.result?.point : r.result?.n })).filter((r): r is { id: number; v: number } => typeof r.v === 'number');
}
export async function recentResults(game: 'crash' | 'double', n: number): Promise<number[]> {
  return (await recentRounds(game, n)).map(r => r.v);
}
export async function roundSeed(roundId: number): Promise<string | null> {
  const { data } = await (await getClient()).from('game_round_seeds').select('server_seed').eq('round_id', roundId).maybeSingle();
  return (data as { server_seed?: string } | null)?.server_seed ?? null;
}
const norm = (b: RoundBet): RoundBet => ({ ...b, amount: Number(b.amount), riding: Number(b.riding), locked: Number(b.locked), auto_cashout: b.auto_cashout == null ? null : Number(b.auto_cashout), cashouts: Array.isArray(b.cashouts) ? b.cashouts.map(Number) : [] });
export const normBet = norm;

type Change<T> = (event: 'INSERT' | 'UPDATE' | 'DELETE', row: T) => void;
export const watchRounds = (cb: Change<Round>): Promise<() => void> => watchTable<Round>('game_rounds', cb);
export const watchRoundBets = (cb: Change<RoundBet>): Promise<() => void> => watchTable<RoundBet>('round_bets', (ev, row) => cb(ev, norm(row)));

// ---- paying this browser what the server says it is owed ----------------------------------------------------------------------
/** Credit whatever the server says a bet has won that this browser has not been paid yet. Idempotent: a repeat or a stale row pays nothing. */
export function payBet(b: RoundBet): number {
  const key = String(b.id), paid = state.liveCredit[key] ?? 0, owed = round2(b.locked);
  const delta = round2(owed - paid);
  if (delta <= 0) return 0;
  if (isServerWallet()) { state.liveCredit[key] = owed; return 0; }    // the server pays the bets itself; nothing to credit here
  state.liveCredit[key] = owed;
  const keys = Object.keys(state.liveCredit);
  if (keys.length > 300) for (const k of keys.map(Number).sort((a, c) => a - c).slice(0, keys.length - 300)) delete state.liveCredit[String(k)];
  credit(delta);                                             // credit() saves
  return delta;
}
/** Once per finished bet: show it in the live feed and the player's own history. */
export function recordFinished(b: RoundBet, game: 'Crash' | 'Double'): void {
  if (!b.done || !settleOnce(`rbf:${b.id}`)) return;
  pushBet({ user: state.name, game, amount: b.amount, multi: b.amount ? round2(b.locked / b.amount) : 0, payout: b.locked, mine: true });
}

// ---- finishing a bet after the page is gone -----------------------------------------------------------------------------------
const settling = new Set<number>();
/** The page was closed with a bet still in play: keep checking the round until it ends, then pay the bet. */
export function settleLater(game: 'crash' | 'double', roundId: number): void {
  if (settling.has(roundId)) return;
  settling.add(roundId);
  const started = Date.now();
  const step = async (): Promise<void> => {
    try {
      const r = await advanceRound(game);
      if (r.id !== roundId || r.status === 'finished') {
        for (const b of await roundBets(roundId)) if (b.user_id === liveMe()) { payBet(b); recordFinished(b, game === 'crash' ? 'Crash' : 'Double'); }
        settling.delete(roundId); return;
      }
    } catch { /* try again */ }
    if (Date.now() - started > 120_000) { settling.delete(roundId); return; }     // the next sign-in catches up
    setTimeout(() => void step(), 1000);
  };
  void step();
}

// After a reload: pay every finished bet of mine that has not been paid yet.
onReconcile(async () => {
  const me = liveMe(); if (!me) return;
  for (const g of ['crash', 'double'] as const) { try { await advanceRound(g); } catch { /* the rounds feature may be off */ } }   // finish anything that is due
  const { data } = await (await getClient()).from('round_bets').select('*').eq('user_id', me).eq('done', true).order('id', { ascending: false }).limit(100);
  let total = 0;
  for (const raw of ((data as RoundBet[] | null) ?? []).reverse()) { const b = norm(raw); total += payBet(b); }
  if (total > 0) { save(); toast(`Crash and Double rounds that finished while you were away: +${fmt(total)}`, 'win'); }
});
