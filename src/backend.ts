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
  adult_required: 'Confirm that you are at least 18 years old.', terms_required: 'Accept the Terms of Service first.', name_taken: 'That username is already taken.',
  invalid_name: 'Use 2 to 20 letters, numbers, spaces, _ or -.', account_closed: 'This account has been closed.',
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

export interface Account { display_name: string; balance: number; created: boolean }
/** Creates the profile on first use (age and terms are checked by the database); returns the existing one afterwards. */
export const completeSignup = (name: string, termsVersion: string, adult: boolean) => call<Account>('complete_signup', { p_name: name, p_terms_version: termsVersion, p_adult: adult });
export const exportMyData = () => call<Record<string, unknown>>('export_my_data');
/** Anonymises the profile on the database, then asks the close-login Edge Function to ban the login. */
export async function deleteAccount(): Promise<void> {
  await call<void>('delete_account');
  const c = await getClient();
  const { error } = await c.functions.invoke('close-login');
  await c.auth.signOut();
  if (error) throw new Error('Your data was erased, but closing the login failed. Contact support.');
}

// ---- sign-in methods ----------------------------------------------------------------------------------------------
const here = (): string => window.location.origin + window.location.pathname;
export type OAuthProvider = 'google';
export interface SignUpMeta { display_name: string; terms_version: string; adult: boolean }

/** With email confirmation switched on in Supabase, no session exists until the link in the email is clicked. */
export async function signUp(email: string, password: string, meta: SignUpMeta): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await (await getClient()).auth.signUp({ email, password, options: { data: meta, emailRedirectTo: here() } });
  if (error) throw new Error(explain(error));
  return { needsConfirmation: !data.session };
}
export async function signInPassword(email: string, password: string): Promise<{ needs2fa: boolean }> {
  const c = await getClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(/invalid login/i.test(error.message) ? 'Wrong email or password.' : explain(error));
  const { data } = await c.auth.mfa.getAuthenticatorAssuranceLevel();
  return { needs2fa: data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2' };
}
export async function verifyLogin2fa(code: string): Promise<void> {
  const c = await getClient();
  const factors = await c.auth.mfa.listFactors();
  const f = factors.data?.totp[0];
  if (!f) throw new Error('No authenticator is set up for this account.');
  const { error } = await c.auth.mfa.challengeAndVerify({ factorId: f.id, code: code.trim() });
  if (error) throw new Error('That code is not correct.');
}
export const signInOAuth = async (provider: OAuthProvider): Promise<void> => {
  const { error } = await (await getClient()).auth.signInWithOAuth({ provider, options: { redirectTo: here() } });
  if (error) throw new Error(explain(error));
};
export const resendSignup = async (email: string): Promise<void> => {
  const { error } = await (await getClient()).auth.resend({ type: 'signup', email, options: { emailRedirectTo: here() } });
  if (error) throw new Error(explain(error));
};
export const resetPassword = async (email: string): Promise<void> => {
  const { error } = await (await getClient()).auth.resetPasswordForEmail(email, { redirectTo: here() });
  if (error) throw new Error(explain(error));
};
export const changePassword = async (password: string): Promise<void> => {
  const { error } = await (await getClient()).auth.updateUser({ password });
  if (error) throw new Error(explain(error));
};
export const signOutEverywhere = async (): Promise<void> => { await (await getClient()).auth.signOut({ scope: 'global' }); };

/** Steam is handled by the steam-login Edge Function (see supabase/functions). */
export const steamEnabled = (): boolean => backendEnabled() && (import.meta.env?.VITE_STEAM_LOGIN ?? '') === 'on';
export function startSteamLogin(): void { window.location.href = `${BACKEND_URL}/functions/v1/steam-login?action=start&site=${encodeURIComponent(here())}`; }
/** Call on page load: turns `#steam_token=...` (from the Edge Function) into a real session. Returns an error text, or null. */
export async function finishSteamLogin(): Promise<string | null> {
  const hash = new URLSearchParams(window.location.hash.replace(/^#\/?\??/, '').replace(/^#/, ''));
  const raw = window.location.hash.slice(1);
  const params = new URLSearchParams(raw.includes('steam_') ? raw : '');
  const token = params.get('steam_token'), err = params.get('steam_error');
  void hash;
  if (!token && !err) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search + '#/');
  if (err) return err === 'cancelled' ? 'Steam sign-in was cancelled.' : 'Steam sign-in failed. Try again.';
  const { error } = await (await getClient()).auth.verifyOtp({ token_hash: token as string, type: 'magiclink' });
  return error ? 'Steam sign-in failed. Try again.' : null;
}

// ---- two-factor authentication (TOTP) --------------------------------------------------------------------------------
export async function list2fa(): Promise<{ id: string; status: string }[]> {
  const { data } = await (await getClient()).auth.mfa.listFactors();
  return (data?.all ?? []).filter(f => f.factor_type === 'totp').map(f => ({ id: f.id, status: f.status }));
}
export async function enroll2fa(): Promise<{ id: string; qr: string; secret: string }> {
  const { data, error } = await (await getClient()).auth.mfa.enroll({ factorType: 'totp', friendlyName: `Vaultrush ${Date.now()}` });
  if (error || !data) throw new Error(explain(error));
  return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}
export async function confirm2fa(factorId: string, code: string): Promise<void> {
  const { error } = await (await getClient()).auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error) throw new Error('That code is not correct.');
}
export const remove2fa = async (factorId: string): Promise<void> => { const { error } = await (await getClient()).auth.mfa.unenroll({ factorId }); if (error) throw new Error(explain(error)); };

/** Fires on sign-in and sign-out (including the return from Google/Steam/email links). */
export async function onAuthChange(cb: (event: string, signedIn: boolean) => void): Promise<void> {
  (await getClient()).auth.onAuthStateChange((event, session) => cb(event, !!session));
}
export const hasProfile = async (): Promise<boolean> => {
  const { data } = await (await getClient()).from('profiles').select('id').maybeSingle();
  return !!data;
};
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
