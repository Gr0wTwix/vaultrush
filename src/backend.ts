// Optional Supabase backend. Without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY nothing here loads and the site stays fully
// local. When configured, the player signs in with an email link and bets run on the server (see supabase/migrations).
// supabase-js is imported lazily so it is a separate chunk that only downloads when the backend is actually used.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerBetRow } from './server-bets.js';

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
  daily_loss_limit: 'This bet could pass your daily loss limit.', weekly_loss_limit: 'This bet could pass your weekly loss limit.', monthly_loss_limit: 'This bet could pass your monthly loss limit.',
  wager_daily_limit: 'This bet would pass your daily wager limit.', time_limit: 'You have used your daily play-time limit.',
  unknown_limit: 'That limit does not exist.', invalid_limit: 'Enter a number of zero or more (whole minutes for the time limit, up to 2 decimals for coins).', invalid_duration: 'That break length is not allowed.',
  insufficient_funds: 'Not enough coins.', chat_too_fast: 'You are sending messages too fast. Wait a moment.', too_many_attempts: 'Too many wrong codes. Try again in a few minutes.',
  account_banned: 'Your account is suspended. Contact support if you think this is a mistake.', betting_banned: 'Betting is suspended on your account. Contact support if you think this is a mistake.',
  chat_muted: 'You are muted in chat for now.', chat_locked: 'The chat is closed for a moment. Only staff can write.', chat_slow: 'Slow mode is on. Wait a little before your next message.',
  rain_closed: 'This coin rain has ended.', giveaway_closed: 'This giveaway is not open for entries.',
  bet_below_min: 'That stake is below the smallest one this game allows.', bet_above_max: 'That stake is above the largest one this game allows.',
  bots_off: 'House bots are switched off for this game right now. Wait for another player.',
  chat_no_links: 'Links are not allowed in chat right now.', chat_blocked_word: 'That message contains a word that is not allowed here.', message_not_found: 'That message is no longer there.',
  adult_required: 'Confirm that you are at least 18 years old.', terms_required: 'Accept the Terms of Service first.', name_taken: 'That username is already taken.',
  invalid_name: 'Use 2 to 20 letters, numbers, spaces, _ or -.', account_closed: 'This account has been closed.',
  invalid_amount: 'Enter a valid amount (up to 2 decimals).', invalid_target: 'The cash-out target must be between 1.01 and 1000.', unsupported_game: 'That game is not available on the server yet.',
  battle_not_found: 'That battle no longer exists.', battle_not_open: 'That battle has already started or was cancelled.', battle_expired: 'That battle has been waiting too long. Create a new one.',
  already_seated: 'You are already in this battle.', battle_full: 'That battle is full.', seat_taken: 'Someone just took that seat.', invalid_seat: 'That seat is not available.',
  too_many_open: 'You already have the maximum number of open games. Finish or cancel one first.', already_started: 'The battle has already started.', not_in_battle: 'You are not in that battle.',
  not_creator: 'Only the creator can do that.', invalid_format: 'Unknown battle format.', invalid_mode: 'That mode is not allowed for this format.', invalid_cases: 'Pick between 1 and 20 cases.',
  flip_not_found: 'That coinflip no longer exists.', flip_not_open: 'Someone already joined that coinflip, or it was cancelled.', flip_expired: 'That coinflip has been waiting too long.', own_flip: 'You cannot join your own coinflip.', invalid_side: 'Pick bolt or star.', invalid_claim: 'That reward cannot be claimed.', betting_closed: 'Betting is closed for this round.', already_bet: 'You already have a bet in this round.', no_bet: 'You have no bet in this round.',
  not_started: 'The round has not started yet.',
  item_not_found: 'One of those items is no longer in your inventory.', invalid_count: 'Open between 1 and 10 cases at once.', case_not_found: 'That case is not available.', too_many_items: 'Stake at most 4 items.',
  unknown_item: 'That item does not exist.', target_too_low: 'Pick a target worth more than your stake.', game_in_progress: 'Finish your current game first.', game_over: 'That game is already over.',
  game_not_found: 'That game was not found.', invalid_tile: 'That tile cannot be picked.', no_picks: 'Reveal a tile before cashing out.', has_picks: 'You already revealed a tile: cash out instead.',
  duplicate_request: 'That request was already handled.', nothing_to_claim: 'Nothing to claim yet.', not_ready: 'Not ready yet. Come back later.', already_claimed: 'Already claimed today.',
  invalid_code: 'That code is not valid.', code_used: 'You already used that code.', code_used_up: 'That code has been used up.', level_too_low: 'Reach the level first.', catalogue_gap: 'Something is wrong with that case. Try another.', too_late: 'Too late: the round is over.', round_over: 'That round is over.', invalid_game: 'Unknown game.', invalid_lane: 'Pick a lane.', both_sides: "You can't back both Purple and Gray.",
  maintenance: 'Vaultrush is under maintenance. Please try again soon.', country_blocked: 'Vaultrush is not available in your country.', game_off: 'This game is paused right now.', signups_closed: 'Sign-ups are closed for now. Existing players can still log in.',
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

export async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
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
  return { needs2fa: await needs2fa() };
}
/** True when the account has an authenticator but this session has not entered its code yet. That happens after a password,
 *  Google or Steam sign-in and on a restored session. The project ends such sessions after 15 minutes ("Limit duration of AAL1 sessions"). */
export async function needs2fa(): Promise<boolean> {
  const { data } = await (await getClient()).auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
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
export async function onAuthChange(cb: (event: string, signedIn: boolean, userId: string) => void): Promise<void> {
  (await getClient()).auth.onAuthStateChange((event, session) => cb(event, !!session, session?.user?.id ?? ''));
}
/** The signed-in player's profile name, or null when no profile exists yet. */
export const profileName = async (): Promise<string | null> => {
  const { data } = await (await getClient()).from('profiles').select('display_name').maybeSingle();
  return (data as { display_name?: string } | null)?.display_name ?? null;
};
export const hasProfile = async (): Promise<boolean> => (await profileName()) !== null;
/** Same bet the local Crash game would make, but drawn and settled by the database. `idem` makes a retry safe. */
export const serverBet = (amount: number, target: number, idem: string = crypto.randomUUID()) =>
  call<ServerBet>('place_bet', { p_game: 'crash', p_amount: amount, p_params: { target }, p_idem: idem });
export const rotateServerSeed = () => call<{ server_seed: string; server_hash: string; client_seed: string; nonces: number }>('rotate_seed');
export const setServerClientSeed = (seed: string) => call<void>('set_client_seed', { p_seed: seed });
export type ServerLimitName = 'max_bet' | 'loss_daily' | 'loss_weekly' | 'loss_monthly' | 'wager_daily' | 'time_daily_min';
/** The names of the limits the database holds (migration 0018), and what it answers when asked for them (src/rg-server.ts makes the calls). */
export interface ServerLimits {
  limits: Record<ServerLimitName, number | string | null>;
  pending: { key: ServerLimitName; value: number | string | null; effective_at: number }[];
  usage: { staked_today: number | string; loss_1: number | string; loss_7: number | string; loss_30: number | string; active_minutes: number };
  excluded_until: number | null; cool_off_until: number | null; kyc_tier: number; now: number;
}

/** True when this browser holds a saved cloud sign-in (so the real chat and live games are about to switch on after a refresh). Reads storage only: no request. */
export function hasStoredSession(): boolean {
  try { return backendEnabled() && Object.keys(localStorage).some(k => /^sb-.+-auth-token$/.test(k) && !!localStorage.getItem(k)); } catch { return false; }
}

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
export async function dailyRacePrev(): Promise<RaceRow[]> {
  const { data, error } = await (await getClient()).from('daily_race_prev').select('*');
  if (error) throw new Error(explain(error));
  return (data as RaceRow[]).map(r => ({ ...r, wagered: Number(r.wagered) }));
}
/** The player's most recent bets of every game (the database made them; row-level security shows only the player's own). */
export async function myBets(limit = 20): Promise<ServerBetRow[]> {
  const { data, error } = await (await getClient()).from('bets').select('id, game, amount, payout, multiplier, nonce, client_seed, server_hash, params, result, created_at').order('id', { ascending: false }).limit(limit);
  if (error) throw new Error(explain(error));
  return (data as ServerBetRow[]).map(b => ({ ...b, amount: Number(b.amount), payout: Number(b.payout), multiplier: Number(b.multiplier) }));
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
