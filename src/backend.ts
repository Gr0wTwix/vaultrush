// Optional Supabase backend. Without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY nothing here loads and the site stays fully
// local. When configured, the player signs in with an email link and bets run on the server (see supabase/migrations).
// supabase-js is imported lazily so it is a separate chunk that only downloads when the backend is actually used.
import type { SupabaseClient } from '@supabase/supabase-js';

export const BACKEND_URL: string = import.meta.env?.VITE_SUPABASE_URL ?? '';
const KEY: string = import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '';
export const backendEnabled = (): boolean => /^https:\/\/.+/.test(BACKEND_URL) && KEY.length > 20;

let client: Promise<SupabaseClient> | null = null;
export function getClient(): Promise<SupabaseClient> {
  if (!backendEnabled()) return Promise.reject(new Error('The backend is not configured.'));
  client ??= import('@supabase/supabase-js').then(m => m.createClient(BACKEND_URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }));
  return client;
}

/** Server error codes (raised by the SQL functions) and what to tell the player. */
export const ERROR_TEXT: Record<string, string> = {
  not_authenticated: 'Sign in first.', no_account: 'Create your cloud account first.', age_not_confirmed: 'Confirm that you are 18 or older first.',
  self_excluded: 'Self-exclusion is active. Betting is paused.', cool_off: 'A cool-off is active. Betting is paused.',
  max_bet_exceeded: 'That is above your maximum bet limit.', tier_cap_exceeded: 'Bets this large need a higher verification level.',
  daily_loss_limit: 'This bet could pass your daily loss limit.', insufficient_funds: 'Not enough coins.',
  invalid_amount: 'Enter a valid amount (up to 2 decimals).', invalid_target: 'The cash-out target must be between 1.01 and 1000.', unsupported_game: 'That game is not available on the server yet.',
};
/** Turn a Postgres/PostgREST error into plain language. */
export function explain(error: { message?: string } | null | undefined): string {
  const msg = error?.message ?? 'Something went wrong.';
  const code = Object.keys(ERROR_TEXT).find(k => msg.includes(k));
  return code ? (ERROR_TEXT[code] as string) : msg;
}

export interface ServerBet { bet_id: number; amount: number; target: number; crash_point: number; win: boolean; payout: number; balance: number; nonce: number; client_seed: string; server_hash: string; float: number; replayed?: boolean }
export interface SeedRow { id: number; server_hash: string; client_seed: string; nonce: number; status: 'active' | 'next' | 'revealed'; server_seed: string | null; created_at: string }
export interface RaceRow { display_name: string; wagered: number; bets: number }

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (await getClient()).rpc(fn, args);
  if (error) throw new Error(explain(error));
  return data as T;
}

export const signInWithEmail = async (email: string): Promise<void> => {
  const { error } = await (await getClient()).auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
  if (error) throw new Error(explain(error));
};
export const signOut = async (): Promise<void> => { await (await getClient()).auth.signOut(); };
export const currentUser = async (): Promise<{ id: string; email?: string } | null> => (await (await getClient()).auth.getUser()).data.user;

export const ensureAccount = (name?: string) => call<{ display_name: string; balance: number }>('ensure_account', { p_name: name ?? null });
export const confirmAgeOnServer = () => call<void>('confirm_age');
/** Same bet the local Crash game would make, but drawn and settled by the database. `idem` makes a retry safe. */
export const serverBet = (amount: number, target: number, idem: string = crypto.randomUUID()) =>
  call<ServerBet>('place_bet', { p_game: 'crash', p_amount: amount, p_params: { target }, p_idem: idem });
export const rotateServerSeed = () => call<{ server_seed: string; server_hash: string; client_seed: string; nonces: number }>('rotate_seed');
export const setServerClientSeed = (seed: string) => call<void>('set_client_seed', { p_seed: seed });
export const requestServerLimit = (key: 'max_bet' | 'loss_daily', value: number | null) => call<'applied' | 'pending' | 'same'>('request_limit_change', { p_key: key, p_value: value });
export const serverSelfExclude = (hours: number) => call<string>('self_exclude', { p_hours: hours });

export async function mySeeds(): Promise<SeedRow[]> {
  const { data, error } = await (await getClient()).from('my_seeds').select('*').order('id', { ascending: false });
  if (error) throw new Error(explain(error));
  return data as SeedRow[];
}
export async function dailyRace(): Promise<RaceRow[]> {
  const { data, error } = await (await getClient()).from('daily_race').select('*');
  if (error) throw new Error(explain(error));
  return (data as RaceRow[]).map(r => ({ ...r, wagered: Number(r.wagered) }));
}
export async function myBets(limit = 20): Promise<{ id: number; amount: number; payout: number; nonce: number; client_seed: string; server_hash: string; result: ServerBet }[]> {
  const { data, error } = await (await getClient()).from('bets').select('id, amount, payout, nonce, client_seed, server_hash, result').order('id', { ascending: false }).limit(limit);
  if (error) throw new Error(explain(error));
  return data as never;
}
export const postChat = async (body: string): Promise<void> => {
  const { error } = await (await getClient()).from('chat_messages').insert({ body });
  if (error) throw new Error(explain(error));
};
/** Realtime chat: calls `onMessage` for every new message. Returns an unsubscribe function. */
export async function subscribeChat(onMessage: (m: { display_name: string; body: string; created_at: string }) => void): Promise<() => void> {
  const c = await getClient();
  const ch = c.channel('chat').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, p => onMessage(p.new as never)).subscribe();
  return () => { void c.removeChannel(ch); };
}
