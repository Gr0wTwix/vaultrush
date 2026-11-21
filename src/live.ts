// Live multiplayer client: shared lobbies for case battles and coinflip, realtime chat and the shared bet feed.
// It only runs for a signed-in cloud player whose Supabase project has supabase/migrations/0002_live.sql applied.
// Everywhere else the site keeps its simulated opponents, so nothing here is required for the demo to work.
//
// Trust model (play money): the server seats players and draws the shared random result from a secret seed. Stakes are not held
// by the server: each browser takes its own stake and pays itself out, once per game (state.liveSettled remembers which).
import { backendEnabled, call, getClient } from './backend.js';
import { emit, state, save, credit, isServerWallet } from './state.js';

export interface LiveSeat { uid: string | null; name: string; bot: boolean }
/** With the server wallet every call that moves coins answers with the new balance. */
export interface WithBalance { balance?: number }
export interface LiveBattle extends WithBalance {
  id: string; creator: string; case_ids: string[]; format: string; mode: string; seats: (LiveSeat | null)[]; player_ids: string[];
  status: 'waiting' | 'running' | 'cancelled'; server_hash: string; client_seed: string; created_at: string; started_at: string | null;
  outcome?: { winners: number[]; totals: number[]; pot: number; points?: number[] } | null;      // set by the server when the battle has run (it pays the winners at that moment)
}
export interface LiveFlip extends WithBalance {
  id: number; creator: string; creator_name: string; side: 'bolt' | 'star'; amount: number; joiner: string | null; joiner_name: string | null; joiner_bot?: boolean;
  status: 'waiting' | 'done' | 'cancelled'; result: 'bolt' | 'star' | null; winner: string | null; server_hash: string; created_at: string; finished_at: string | null;
}

// ---- are live games switched on? -----------------------------------------------------------------------------------
let me = '';                                           // the signed-in player's user id
let live = false;
export const liveMe = (): string => me;
/** True when this browser should use real lobbies instead of the simulated ones. */
export const isLive = (): boolean => live;
let roundsAvailable = false;                            // migration 0005 (shared Crash and Double rounds) is applied
/** True when Crash and Double should use the server's shared rounds. */
export const roundsOn = (): boolean => live && roundsAvailable;

/** Called by the sign-in code. Probes the server once; emits 'live' when the answer changes so pages redraw. */
let probing: Promise<void> | null = null, probedFor = '';
export function initLive(userId: string): Promise<void> {
  if (probing && probedFor === userId) return probing;          // sign-in events can arrive twice
  probedFor = userId;
  probing = (async () => {
    me = userId;
    let ok = false;
    if (userId && backendEnabled()) { try { ok = (await call<boolean>('live_ready')) === true; } catch { ok = false; } }
    let rounds = false;
    if (ok) { try { rounds = (await call<boolean>('rounds_ready')) === true; } catch { rounds = false; } }
    const changed = ok !== live || rounds !== roundsAvailable;
    live = ok; roundsAvailable = rounds;
    if (changed) emit('live', ok);
    void syncClaims().then(() => { if (claimsOn) emit('state', state); });
    if (ok) { void startPresence(); await reconcileAll(); }
  })();
  return probing;
}
export function stopLive(): void {
  me = ''; claimsOn = false; roundsAvailable = false; probing = null; probedFor = '';
  if (live) { live = false; emit('live', false); }
  const ch = presence; presence = null;
  if (ch) void getClient().then(c => c.removeChannel(ch)).catch(() => {});
}

// ---- settled games ------------------------------------------------------------------------------------------------
export const isSettled = (key: string): boolean => state.liveSettled.includes(key);
/** Remember a game as paid out / refunded. Returns false when it already was (so the caller must not pay again). */
export function settleOnce(key: string): boolean {
  if (isSettled(key)) return false;
  state.liveSettled.push(key);
  if (state.liveSettled.length > 300) state.liveSettled.splice(0, state.liveSettled.length - 300);
  save();
  return true;
}
/** Give a stake back exactly once. */
export function refundOnce(key: string, amount: number): boolean { if (!settleOnce(key)) return false; if (!isServerWallet()) credit(amount); return true; }       // with the server wallet the server already refunded it

// ---- free claims: the welcome crate (once per account) and the daily crate (once per 24 h), enforced by the server ------------------
// The browser alone cannot enforce "once per player": the same account on two browsers, or on localhost and the live site, has two
// separate storages. With a cloud account the server records each claim; browser-only accounts keep the local rule.
let claimsOn = false;
export type ClaimKind = 'welcome' | 'daily_case';
export const claimsEnabled = (): boolean => claimsOn;
interface ClaimAnswer { claimed: boolean; last: string | null; next: string | null }
const applyClaim = (kind: ClaimKind, last: string | null): void => {
  if (kind === 'welcome') { if (last) state.welcomeLeft = 0; }
  else if (last) state.lastDailyCase = Math.max(state.lastDailyCase, Date.parse(last) || 0);
};
/** After sign-in: learn what this account has already claimed anywhere, and switch server-side claims on if the database supports them. */
export async function syncClaims(): Promise<void> {
  if (!backendEnabled() || !me) { claimsOn = false; return; }
  try {
    const s = await call<{ welcome: string | null; daily_case: string | null }>('claim_status');
    claimsOn = true;
    applyClaim('welcome', s.welcome); applyClaim('daily_case', s.daily_case);
    save();
  } catch { claimsOn = false; }                       // migration 0004 not applied (or offline): keep the browser-only rule
}
/** Ask permission to open a free crate. 'ok' = go ahead, 'taken' = already opened (local state is updated), 'error' = could not ask. */
export async function takeFreeClaim(kind: ClaimKind): Promise<'ok' | 'taken' | 'error'> {
  if (!claimsOn) return 'ok';
  try {
    const r = await call<ClaimAnswer>('claim_free', { p_kind: kind });
    applyClaim(kind, r.last); save();
    return r.claimed ? 'ok' : 'taken';
  } catch { return 'error'; }
}

const reconcilers: (() => Promise<void>)[] = [];
/** Game modules register how to settle their own unfinished games after a reload or an offline spell. */
export const onReconcile = (fn: () => Promise<void>): void => { reconcilers.push(fn); };
export async function reconcileAll(): Promise<void> { for (const fn of reconcilers) { try { await fn(); } catch { /* retried at the next sign-in */ } } }

// ---- realtime helpers ---------------------------------------------------------------------------------------------
type Change<T> = (event: 'INSERT' | 'UPDATE' | 'DELETE', row: T) => void;
/** Subscribe to every change of a table (row-level security still decides what this player may see). */
export const watchTable = <T>(table: string, cb: Change<T>): Promise<() => void> => watch<T>(table, cb);
async function watch<T>(table: string, cb: Change<T>): Promise<() => void> {
  const c = await getClient();
  const ch = c.channel(`live-${table}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, (p: any) => cb(p.eventType, (p.new && Object.keys(p.new).length ? p.new : p.old) as T))
    .subscribe();
  return () => { void c.removeChannel(ch); };
}

// ---- case battles -------------------------------------------------------------------------------------------------
const SINCE = (): string => new Date(Date.now() - 30 * 60_000).toISOString();
/** Tell the wallet the balance the server just answered with (only when the server wallet is on). */
export const tellBalance = <T extends WithBalance>(r: T): T => { if (isServerWallet() && typeof r?.balance === 'number') emit('wallet:balance', r.balance); return r; };
export const createLiveBattle = (cases: string[], format: string, mode: string) => call<LiveBattle>('create_live_battle', { p_cases: cases, p_format: format, p_mode: mode }).then(tellBalance);
export const joinLiveBattle = (id: string, seat: number | null = null) => call<LiveBattle>('join_live_battle', { p_id: id, p_seat: seat });
export const callLiveBot = (id: string, seat: number, name: string) => call<LiveBattle>('call_live_bot', { p_id: id, p_seat: seat, p_name: name });
export const leaveLiveBattle = (id: string) => call<LiveBattle>('leave_live_battle', { p_id: id }).then(tellBalance);
export async function getLiveBattle(id: string): Promise<LiveBattle | null> {
  const { data } = await (await getClient()).from('live_battles').select('*').eq('id', id).maybeSingle();
  return (data as LiveBattle | null) ?? null;
}
export async function openLiveBattles(): Promise<LiveBattle[]> {
  const { data } = await (await getClient()).from('live_battles').select('*').eq('status', 'waiting').gt('created_at', SINCE()).order('created_at', { ascending: false }).limit(50);
  return (data as LiveBattle[] | null) ?? [];
}
/** My battles that are not settled yet (waiting, running or cancelled in the last week). */
export async function myLiveBattles(): Promise<LiveBattle[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await (await getClient()).from('live_battles').select('*').contains('player_ids', [me]).gt('created_at', since).order('created_at', { ascending: false }).limit(60);
  return (data as LiveBattle[] | null) ?? [];
}
export async function liveBattleSeed(id: string): Promise<string | null> {
  const { data } = await (await getClient()).from('live_battle_seeds').select('server_seed').eq('battle_id', id).maybeSingle();
  return (data as { server_seed?: string } | null)?.server_seed ?? null;
}
export const watchBattles = (cb: Change<LiveBattle>): Promise<() => void> => watch<LiveBattle>('live_battles', cb);

// ---- coinflip -----------------------------------------------------------------------------------------------------
export const createLiveFlip = (side: string, amount: number) => call<LiveFlip>('create_live_coinflip', { p_side: side, p_amount: amount }).then(tellBalance);
export const joinLiveFlip = (id: number) => call<LiveFlip>('join_live_coinflip', { p_id: id });
export const cancelLiveFlip = (id: number) => call<LiveFlip>('cancel_live_coinflip', { p_id: id }).then(tellBalance);
/** The creator fills the other seat with a house bot; if the bot's side wins, nobody is paid. */
export const callLiveFlipBot = (id: number, name: string) => call<LiveFlip>('call_live_coinflip_bot', { p_id: id, p_name: name });
export async function openLiveFlips(): Promise<LiveFlip[]> {
  const { data } = await (await getClient()).from('live_coinflips').select('*').eq('status', 'waiting').gt('created_at', SINCE()).order('created_at', { ascending: false }).limit(50);
  return (data as LiveFlip[] | null) ?? [];
}
export async function myLiveFlips(): Promise<LiveFlip[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await (await getClient()).from('live_coinflips').select('*').or(`creator.eq.${me},joiner.eq.${me}`).gt('created_at', since).order('id', { ascending: false }).limit(60);
  return (data as LiveFlip[] | null) ?? [];
}
export async function liveFlipSeed(id: number): Promise<string | null> {
  const { data } = await (await getClient()).from('live_coinflip_seeds').select('server_seed').eq('flip_id', id).maybeSingle();
  return (data as { server_seed?: string } | null)?.server_seed ?? null;
}
export const watchFlips = (cb: Change<LiveFlip>): Promise<() => void> => watch<LiveFlip>('live_coinflips', cb);

// ---- chat ---------------------------------------------------------------------------------------------------------
export interface ChatRow { id: number; display_name: string; body: string; created_at: string }
export async function recentChat(limit = 30): Promise<ChatRow[]> {
  const { data } = await (await getClient()).from('chat_messages').select('id, display_name, body, created_at').order('id', { ascending: false }).limit(limit);
  return ((data as ChatRow[] | null) ?? []).reverse();
}
export async function sendChat(body: string): Promise<void> {
  const { error } = await (await getClient()).from('chat_messages').insert({ body });
  if (error) throw new Error(error.message);
}
export const watchChat = async (cb: (m: ChatRow) => void): Promise<() => void> => {
  const c = await getClient();
  const ch = c.channel(`live-chat-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (p: any) => cb(p.new as ChatRow)).subscribe();
  return () => { void c.removeChannel(ch); };
};

// ---- shared bet / drop feed and who is online (Realtime broadcast + presence, no tables) -------------------------------
export interface FeedBet { user: string; game: string; amount: number; multi: number; payout: number }
export interface FeedDrop { user: string; itemId: string; source: string }
let presence: any = null;
let onBet: ((b: FeedBet) => void) | null = null, onDrop: ((d: FeedDrop) => void) | null = null;
const GAMES = new Set(['Crash', 'Mines', 'Upgrade', 'Cases', 'Battles', 'Double', 'Plinko', 'Coinflip']);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : 0);

/** Other players' bets and drops arrive here. Everything is validated: the sender is another browser, not a trusted server. */
export function listenFeed(bet: (b: FeedBet) => void, drop: (d: FeedDrop) => void): void { onBet = bet; onDrop = drop; }
export function shareBet(b: FeedBet): void { if (live && presence) void presence.send({ type: 'broadcast', event: 'bet', payload: b }); }
export function shareDrop(d: FeedDrop): void { if (live && presence) void presence.send({ type: 'broadcast', event: 'drop', payload: d }); }
const onlineListeners = new Set<(n: number) => void>();
export const onOnline = (fn: (n: number) => void): (() => void) => { onlineListeners.add(fn); return () => onlineListeners.delete(fn); };

async function startPresence(): Promise<void> {
  if (presence) return;
  const c = await getClient();
  presence = c.channel('vaultrush-live', { config: { broadcast: { self: false }, presence: { key: me } } })
    .on('broadcast', { event: 'bet' }, ({ payload }: any) => {
      const game = str(payload?.game, 20), user = str(payload?.user, 20);
      if (user && GAMES.has(game)) onBet?.({ user, game, amount: num(payload.amount), multi: num(payload.multi), payout: num(payload.payout) });
    })
    .on('broadcast', { event: 'drop' }, ({ payload }: any) => {
      const user = str(payload?.user, 20), itemId = str(payload?.itemId, 40);
      if (user && itemId) onDrop?.({ user, itemId, source: str(payload.source, 40) });
    })
    .on('presence', { event: 'sync' }, () => { const n = Object.keys(presence.presenceState()).length; onlineListeners.forEach(f => f(n)); })
    .subscribe((status: string) => { if (status === 'SUBSCRIBED') void presence.track({ at: Date.now() }); });
}
