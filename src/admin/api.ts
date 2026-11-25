// Everything the admin site asks of the outside world, behind one interface so the screens can be tested with a fake.
// The real implementation uses the same Supabase client and Steam sign-in as the game site (src/backend.ts); every admin action is a
// checked database function (see supabase/migrations/0006_admin.sql). There is no service key here and none must ever be added.
import { backendEnabled, call, confirm2fa, currentUser, enroll2fa, finishSteamLogin, getClient, list2fa, onAuthChange, remove2fa, signOut, startSteamLogin, steamEnabled } from '../backend.js';

export interface Status {
  is_admin: boolean; role?: string; label?: string; rank?: number; mfa?: boolean; password_set?: boolean; unlocked?: boolean;
  expires_at?: string | null; locked_until?: string | null;
}
export interface Matrix {
  roles: { role: string; rank: number; label: string; description: string }[];
  permissions: { key: string; area: string; label: string; sensitive: boolean }[];
  grants: { role: string; permission: string }[];
}
export interface Admin { user_id: string; name: string; role: string; rank: number; granted_at: string }
export interface Found { id: string; name: string; created_at: string; role: string | null }
export interface AuditRow { id: number; at: string; actor: string | null; actor_name: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; before: unknown; after: unknown; reason: string | null; meta: Record<string, unknown> }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; error?: string }
export interface UnlockResult { ok: boolean; reason?: 'wrong_password' | 'locked' | 'no_password'; remaining?: number; until?: string; expires_at?: string }
export interface Factor { id: string; status: string }
export interface Controls {
  maintenance_on: boolean; maintenance_message: string; notice_on: boolean; notice_text: string; notice_kind: 'info' | 'warn'; signups_open: boolean;
  games_off: string[]; blocked_countries: string[]; games: string[]; updated_at: string; updated_by: string | null;
}

/** The wallet tools (migration 0019). Money amounts arrive as numbers; times as ISO strings. */
export interface BetsSum { count: number; staked: number; paid: number }
export interface WalletTotals {
  coins_in_wallets: number; wallets: number; wallets_with_coins: number; top_balance: number; bets_today: BetsSum; bets_7d: BetsSum;
  adjustments_30d: { count: number; credited: number; debited: number }; now: number;
}
export interface WalletFound { id: string; name: string; balance: number; wagered: number; created_at: string }
export interface WalletOverview {
  player: { id: string; name: string; created_at: string; closed: boolean; staff_role: string | null };
  wallet: { balance: number; wagered: number; won: number; updated_at: string };
  ledger: { rows: number; sum: number; difference: number; by_kind: { kind: string; count: number; sum: number }[] };
  bets: BetsSum & { last_at: string | null };
  inventory: { items: number; value: number };
  responsible: null | {
    limits: { max_bet: number | null; loss_daily: number | null; loss_weekly: number | null; loss_monthly: number | null; wager_daily: number | null; time_daily_min: number | null };
    usage: { staked_today: number; loss_1: number; loss_7: number; loss_30: number; active_minutes: number };
    excluded_until: string | null; cool_off_until: string | null; kyc_tier: number;
  };
}
export interface LedgerRow { id: number; kind: string; amount: number; balance_after: number; bet_id: number | null; at: string }
export interface BetRow { id: number; game: string; amount: number; payout: number; multiplier: number; nonce: number; at: string }
export interface AdjustResult { user_id: string; amount: number; balance_before: number; balance_after: number; ledger_id?: number; replayed: boolean }

/** Step B (migration 0021): dashboard, players, account actions, chat moderation, live rooms, rounds. */
export interface Dashboard {
  players: { total: number; new_today: number; new_7d: number; active_15m: number; active_today: number };
  bets_15m: { count: number; staked: number }; chat_15m: number;
  rooms: { battles_waiting: number; coinflips_waiting: number; stuck: number };
  rounds: { game: string; id: number; status: string; betting_ends_at: string; bets: number; staked: number }[];
  flags: { mute: number; warn: number; bet_ban: number; site_ban: number }; reports_open: number;
  site: { maintenance_on: boolean; notice_on: boolean; games_off: string[]; signups_open: boolean };
  chat: { locked: boolean; slow_seconds: number };
  signups_7d: { day: string; count: number }[]; bets_24h: { hour: string; count: number; staked: number }[]; now: number;
}
export type FlagKind = 'mute' | 'warn' | 'bet_ban' | 'site_ban';
export interface PlayerRow { id: string; name: string; created_at: string; closed: boolean; staff_role: string | null; balance: number | null; wagered: number | null; last_seen: string | null; flags: FlagKind[]; tags: string[]; excluded: boolean }
export interface Flag { id: number; kind: FlagKind; until: string | null; message: string; reason: string; at: string; by: string | null; seen_at: string | null; lifted_at: string | null; lift_reason: string | null; active: boolean }
export interface PlayerProfile {
  player: { id: string; name: string; created_at: string; closed: boolean; closed_at: string | null; age_confirmed_at: string | null; terms_version: string | null; staff_role: string | null;
            sign_in: { provider: string | null; last_sign_in_at: string | null; banned_until: string | null } | null };
  wallet: { balance: number; wagered: number; won: number } | null;
  flags: Flag[]; notes: { id: number; body: string; author: string | null; at: string }[]; tags: string[];
  chat: { id: number; body: string; at: string; removed_at: string | null }[] | null;
  bets: { id: number; game: string; amount: number; payout: number; at: string }[] | null;
  games: { battles: number; coinflips: number; round_bets: number };
  claims: { kind: string; at: string }[];
  controls: { excluded_until: string | null; cool_off_until: string | null; kyc_tier: number } | null;
  actions: { id: number; at: string; action: string; actor: string | null; reason: string | null }[] | null;
}
export interface ChatMsg { id: number; user_id: string; name: string; body: string; at: string; is_staff: boolean; removed_at: string | null; removed_by: string | null; reports: number }
export interface ChatSettings { slow_seconds: number; locked: boolean; links_allowed: boolean; blocked_words: string[]; pinned_id: number | null; updated_at: string; updated_by: string | null }
export interface ChatReport { id: number; message_id: number; body: string; author: string; author_id: string; removed: boolean; reporter: string | null; reason: string; at: string; resolved_at: string | null; outcome: string | null }
export interface RoomFlag { flag: 'suspicious' | 'void'; reason: string; at: string }
export interface BattleRoom { id: string; format: string; mode: string; cases: string[]; seats: ({ uid?: string; name: string; bot?: boolean } | null)[]; status: string; cost: number; creator: string | null; created_at: string; started_at: string | null; server_hash: string; seed: string | null; stuck: boolean; flags: RoomFlag[] }
export interface FlipRoom { id: number; creator: string; side: string; amount: number; joiner: string | null; bot: boolean; status: string; result: string | null; winner: string | null; created_at: string; finished_at: string | null; server_hash: string; seed: string | null; stuck: boolean; flags: RoomFlag[] }
export interface RoundRow { id: number; status: string; created_at: string; betting_ends_at: string; finished_at: string | null; server_hash: string; result: { point?: number; n?: number } | null; seed: string | null; bets: number; staked: number; paid: number | null; flags: RoomFlag[] }
export interface RoundBet { id: number; user_id: string; name: string; lane: string; amount: number; auto_cashout: number | null; cashouts: number[]; paid: number; done: boolean; at: string }
export interface RoundCheck { id: number; game: string; hash_ok: boolean; result_ok: boolean; recorded: unknown; recomputed: unknown }

/** Step C (migration 0022): the case catalogue editor. Chances are tickets out of 100,000. */
export interface CatCase { id: string; name: string; price: number; reward: boolean; active: boolean; hue: number | null; tag: string | null; art: string | null; sort: number; version: number; updated_at: string | null; items: number; ev: number; opens_7d: number; in_use: boolean }
export interface CatEntry { item: string; name: string; rarity: string; value: number; tickets: number; from: number; to: number }
export interface CatCaseFull extends Omit<CatCase, 'items' | 'opens_7d'> { entries: CatEntry[]; history: { version: number; at: string; by: string | null; reason: string | null; price: number; items: number }[] }
export interface CatItem { id: string; name: string; rarity: string; value: number }
export interface CatSave { id: string; name: string; price: number; hue: number | null; tag: string | null; art: string | null; sort: number; entries: { item: string; tickets: number }[] }

/** Step E part 1 (migration 0023): reward settings, promo codes, announcements. */
export interface RewardSettings { faucet_amount: number; faucet_minutes: number; rakeback: { instant: number; daily: number; weekly: number }; calendar: number[]; race_prizes: number[]; updated_at?: string; updated_by?: string | null }
export interface RewardStats { kinds: { kind: string; today_count: number; today_sum: number; week_count: number; week_sum: number }[]; crates: { kind: string; week: number }[] }
export interface Promo { code: string; amount: number; max_uses: number | null; uses: number; active: boolean; expires_at: string | null; note: string | null; created_at: string; by: string | null; live: boolean }
export interface AnnouncementRow { id: number; kind: 'banner' | 'popup'; style: 'info' | 'warn' | 'win'; body: string; starts_at: string; ends_at: string | null; ended_at: string | null; by: string | null; state: 'showing' | 'scheduled' | 'ended' }

/** Step E part 2 (migration 0024): races, coin rain, giveaways. */
export interface AdminRace { id: number; name: string; starts_at: string; ends_at: string; prizes: number[]; games: string[]; state: 'upcoming' | 'running' | 'ended' | 'paid' | 'cancelled'; pool: number;
  top: { rank: number; name: string; wagered: number; prize: number }[]; paid_at: string | null; by: string | null; payouts: { rank: number; name: string; prize: number }[] }
export interface AdminRain { id: number; pot: number; min_level: number; starts_at: string; ends_at: string; settled_at: string | null; cancelled_at: string | null; share: number | null; joiners: number; by: string | null }
export interface AdminGiveaway { id: number; title: string; prize: number; winners: number; min_level: number; starts_at: string; ends_at: string; server_hash: string;
  state: 'upcoming' | 'open' | 'ended' | 'drawn' | 'cancelled'; entries: number; seed: string | null; drawn: { place: number; entry_no: number; name: string }[] | null; by: string | null }

/** Step E part 3 (migration 0025): game settings and house bots. */
export interface GameSettings { crash_bet_seconds: number; double_bet_seconds: number; lobby_minutes: number; battle_lobbies_max: number; flip_lobbies_max: number;
  bots_battles: boolean; bots_coinflip: boolean; simulated_activity: boolean; bot_names: string[]; limits: Record<string, { min: number; max: number }>;
  games?: string[]; updated_at?: string; updated_by?: string | null }

export interface AdminApi {
  configured(): boolean;
  steamAvailable(): boolean;
  startSteam(): void;
  finishSteam(): Promise<string | null>;
  user(): Promise<{ id: string } | null>;
  onAuth(cb: () => void): Promise<void>;
  signOut(): Promise<void>;
  status(): Promise<Status>;
  factors(): Promise<Factor[]>;
  enroll(): Promise<{ id: string; qr: string; secret: string }>;
  removeFactor(id: string): Promise<void>;
  verify(factorId: string, code: string): Promise<void>;
  setPassword(next: string, current?: string): Promise<{ ok: boolean; reason?: string; until?: string }>;
  unlock(password: string): Promise<UnlockResult>;
  lock(): Promise<void>;
  touch(): Promise<string>;
  myPermissions(): Promise<string[]>;
  listAdmins(): Promise<Admin[]>;
  findPlayer(q: string): Promise<Found[]>;
  setRole(user: string, role: string | null, reason: string): Promise<void>;
  matrix(): Promise<Matrix>;
  setPermission(role: string, permission: string, allowed: boolean, reason: string): Promise<void>;
  audit(f: { action?: string; actor?: string; before?: number; limit?: number }): Promise<AuditRow[]>;
  query(sql: string, limit?: number): Promise<QueryResult>;
  controls(): Promise<Controls>;
  setMaintenance(on: boolean, message: string, reason: string): Promise<Controls>;
  setNotice(on: boolean, text: string, kind: 'info' | 'warn', reason: string): Promise<Controls>;
  setGame(game: string, off: boolean, reason: string): Promise<Controls>;
  setSignups(open: boolean, reason: string): Promise<Controls>;
  setCountries(codes: string[], reason: string): Promise<Controls>;
  walletTotals(): Promise<WalletTotals>;
  walletSearch(q: string): Promise<WalletFound[]>;
  walletOverview(user: string): Promise<WalletOverview>;
  walletLedger(user: string, before?: number): Promise<LedgerRow[]>;
  walletBets(user: string, before?: number): Promise<BetRow[]>;
  /** A positive amount credits, a negative one debits. `key` makes a repeat of the same request harmless (the same key is paid once). */
  walletAdjust(user: string, amount: number, reason: string, key: string): Promise<AdjustResult>;
  dashboard(): Promise<Dashboard>;
  players(q: string, filter: string, offset?: number): Promise<PlayerRow[]>;
  player(id: string): Promise<PlayerProfile>;
  note(user: string, body: string): Promise<void>;
  tag(user: string, tag: string, on: boolean): Promise<string[]>;
  /** minutes: null = until lifted. message: what the player is told (required for a warning). */
  flag(user: string, kind: FlagKind, minutes: number | null, message: string, reason: string): Promise<{ id: number; until: string | null; signed_out: boolean | null }>;
  liftFlag(id: number, reason: string): Promise<void>;
  signOutPlayer(user: string, reason: string): Promise<{ signed_out: boolean }>;
  rename(user: string, name: string, reason: string): Promise<void>;
  resetClaim(user: string, kind: string, reason: string): Promise<void>;
  closeAccount(user: string, confirmName: string, reason: string): Promise<{ name: string; balance_removed: number; signed_out: boolean }>;
  chat(f: { before?: number; q?: string; removed?: boolean }): Promise<{ messages: ChatMsg[]; settings: ChatSettings }>;
  chatRemove(id: number, reason: string): Promise<void>;
  chatClear(minutes: number, reason: string): Promise<{ removed: number }>;
  chatSettings(slow: number, locked: boolean, links: boolean, words: string[], reason: string): Promise<ChatSettings>;
  chatPin(id: number | null, reason: string): Promise<void>;
  chatPost(body: string): Promise<void>;
  chatReports(open: boolean): Promise<ChatReport[]>;
  chatDismiss(report: number, reason: string): Promise<void>;
  battles(status?: string): Promise<BattleRoom[]>;
  coinflips(status?: string): Promise<FlipRoom[]>;
  roomCancel(kind: 'battle' | 'coinflip', id: string, reason: string): Promise<{ refunded: number; each: number }>;
  roomFlag(kind: 'battle' | 'coinflip' | 'round', id: string, flag: 'suspicious' | 'void', reason: string): Promise<void>;
  rounds(game: 'crash' | 'double', before?: number): Promise<RoundRow[]>;
  roundBets(id: number): Promise<RoundBet[]>;
  roundVerify(id: number): Promise<RoundCheck>;
  catalogueCases(): Promise<CatCase[]>;
  catalogueCase(id: string): Promise<CatCaseFull>;
  catalogueItems(q: string, min?: number, max?: number | null): Promise<CatItem[]>;
  /** version: the one the editor loaded (0 for a new case). */
  catalogueSave(c: CatSave, version: number, reason: string): Promise<{ id: string; version: number; ev: number; rtp: number | null; created: boolean }>;
  catalogueSetActive(id: string, active: boolean, reason: string): Promise<void>;
  catalogueRestore(id: string, version: number, reason: string): Promise<{ version: number }>;
  rewardSettings(): Promise<RewardSettings>;
  saveRewardSettings(s: RewardSettings, reason: string): Promise<RewardSettings>;
  rewardStats(): Promise<RewardStats>;
  promos(): Promise<Promo[]>;
  promoUsers(code: string): Promise<{ id: string; name: string }[]>;
  savePromo(p: { code: string; amount: number; max_uses: number | null; expires_at: string | null; active: boolean; note: string | null }, reason: string): Promise<void>;
  announcements(): Promise<AnnouncementRow[]>;
  announce(a: { kind: 'banner' | 'popup'; style: 'info' | 'warn' | 'win'; body: string; starts_at: string | null; ends_at: string | null }, reason: string): Promise<void>;
  endAnnouncement(id: number, reason: string): Promise<void>;
  races(): Promise<AdminRace[]>;
  saveRace(r: { id: number | null; name: string; starts_at: string; ends_at: string; prizes: number[]; games: string[] }, reason: string): Promise<void>;
  payRace(id: number, reason: string): Promise<{ winners: number; paid: number }>;
  cancelRace(id: number, reason: string): Promise<void>;
  rains(): Promise<AdminRain[]>;
  startRain(pot: number, seconds: number, minLevel: number, reason: string): Promise<void>;
  cancelRain(id: number, reason: string): Promise<void>;
  giveaways(): Promise<AdminGiveaway[]>;
  createGiveaway(g: { title: string; prize: number; winners: number; min_level: number; starts_at: string | null; ends_at: string }, reason: string): Promise<void>;
  drawGiveaway(id: number, reason: string): Promise<{ winners: number; paid: number }>;
  cancelGiveaway(id: number, reason: string): Promise<void>;
  gameSettings(): Promise<GameSettings>;
  saveGameSettings(s: GameSettings, reason: string): Promise<GameSettings>;
}

export const realApi: AdminApi = {
  configured: backendEnabled,
  steamAvailable: steamEnabled,
  startSteam: startSteamLogin,
  finishSteam: finishSteamLogin,
  user: () => currentUser().catch(() => null),
  onAuth: async cb => { await onAuthChange(() => cb()); },
  signOut,
  status: () => call<Status>('admin_status'),
  factors: async () => (await list2fa()).map(f => ({ id: f.id, status: f.status })),
  enroll: enroll2fa,
  removeFactor: remove2fa,
  verify: confirm2fa,
  setPassword: (next, current) => call('admin_set_password', { p_new: next, p_current: current ?? null }),
  unlock: password => call<UnlockResult>('admin_unlock', { p_password: password }),
  lock: () => call<void>('admin_lock'),
  touch: async () => (await call<{ expires_at: string }>('admin_touch')).expires_at,
  myPermissions: () => call<string[]>('admin_my_permissions'),
  listAdmins: () => call<Admin[]>('admin_list_admins'),
  findPlayer: q => call<Found[]>('admin_find_player', { p_query: q }),
  setRole: async (user, role, reason) => { await call('admin_set_role', { p_user: user, p_role: role, p_reason: reason }); },
  matrix: () => call<Matrix>('admin_permission_matrix'),
  setPermission: async (role, permission, allowed, reason) => { await call('admin_set_permission', { p_role: role, p_permission: permission, p_allowed: allowed, p_reason: reason }); },
  audit: async f => {
    let q = (await getClient()).from('admin_audit_log').select('*').order('id', { ascending: false }).limit(f.limit ?? 100);
    if (f.action) q = q.ilike('action', `%${f.action.replace(/[%_]/g, '')}%`);
    if (f.actor) q = q.ilike('actor_name', `%${f.actor.replace(/[%_]/g, '')}%`);
    if (f.before) q = q.lt('id', f.before);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data as AuditRow[]) ?? [];
  },
  query: (sql, limit = 200) => call<QueryResult>('admin_query', { p_sql: sql, p_limit: limit }),
  controls: () => call<Controls>('admin_get_controls'),
  setMaintenance: (on, message, reason) => call<Controls>('admin_set_maintenance', { p_on: on, p_message: message, p_reason: reason }),
  setNotice: (on, text, kind, reason) => call<Controls>('admin_set_notice', { p_on: on, p_text: text, p_kind: kind, p_reason: reason }),
  setGame: (game, off, reason) => call<Controls>('admin_set_game', { p_game: game, p_off: off, p_reason: reason }),
  setSignups: (open, reason) => call<Controls>('admin_set_signups', { p_open: open, p_reason: reason }),
  setCountries: (codes, reason) => call<Controls>('admin_set_countries', { p_codes: codes, p_reason: reason }),
  walletTotals: () => call<WalletTotals>('admin_wallet_totals'),
  walletSearch: q => call<WalletFound[]>('admin_wallet_search', { p_query: q }),
  walletOverview: user => call<WalletOverview>('admin_wallet_overview', { p_user: user }),
  walletLedger: (user, before) => call<LedgerRow[]>('admin_wallet_ledger', { p_user: user, p_before: before ?? null, p_limit: 50 }),
  walletBets: (user, before) => call<BetRow[]>('admin_wallet_bets', { p_user: user, p_before: before ?? null, p_limit: 50 }),
  walletAdjust: (user, amount, reason, key) => call<AdjustResult>('admin_wallet_adjust', { p_user: user, p_amount: amount, p_reason: reason, p_key: key }),
  dashboard: () => call<Dashboard>('admin_dashboard'),
  players: (q, filter, offset = 0) => call<PlayerRow[]>('admin_players', { p_query: q, p_filter: filter, p_limit: 50, p_offset: offset }),
  player: id => call<PlayerProfile>('admin_player', { p_user: id }),
  note: async (user, body) => { await call('admin_player_note', { p_user: user, p_body: body }); },
  tag: (user, tag, on) => call<string[]>('admin_player_tag', { p_user: user, p_tag: tag, p_on: on }),
  flag: (user, kind, minutes, message, reason) => call('admin_flag_player', { p_user: user, p_kind: kind, p_minutes: minutes, p_message: message, p_reason: reason }),
  liftFlag: async (id, reason) => { await call('admin_lift_flag', { p_flag: id, p_reason: reason }); },
  signOutPlayer: (user, reason) => call('admin_sign_out', { p_user: user, p_reason: reason }),
  rename: async (user, name, reason) => { await call('admin_rename', { p_user: user, p_name: name, p_reason: reason }); },
  resetClaim: async (user, kind, reason) => { await call('admin_reset_claim', { p_user: user, p_kind: kind, p_reason: reason }); },
  closeAccount: (user, confirmName, reason) => call('admin_close_account', { p_user: user, p_confirm: confirmName, p_reason: reason }),
  chat: f => call('admin_chat', { p_before: f.before ?? null, p_query: f.q ?? '', p_only_removed: !!f.removed }),
  chatRemove: async (id, reason) => { await call('admin_chat_remove', { p_message: id, p_reason: reason }); },
  chatClear: (minutes, reason) => call('admin_chat_clear', { p_minutes: minutes, p_reason: reason }),
  chatSettings: (slow, locked, links, words, reason) => call<ChatSettings>('admin_chat_settings', { p_slow: slow, p_locked: locked, p_links: links, p_words: words, p_reason: reason }),
  chatPin: async (id, reason) => { await call('admin_chat_pin', { p_message: id, p_reason: reason }); },
  chatPost: async body => { await call('admin_chat_post', { p_body: body }); },
  chatReports: open => call<ChatReport[]>('admin_chat_reports', { p_open: open }),
  chatDismiss: async (report, reason) => { await call('admin_chat_dismiss', { p_report: report, p_reason: reason }); },
  battles: status => call<BattleRoom[]>('admin_rooms', { p_kind: 'battles', p_status: status ?? null, p_limit: 100 }),
  coinflips: status => call<FlipRoom[]>('admin_rooms', { p_kind: 'coinflips', p_status: status ?? null, p_limit: 100 }),
  roomCancel: (kind, id, reason) => call('admin_room_cancel', { p_kind: kind, p_id: id, p_reason: reason }),
  roomFlag: async (kind, id, flag, reason) => { await call('admin_room_flag', { p_kind: kind, p_id: id, p_flag: flag, p_reason: reason }); },
  rounds: (game, before) => call<RoundRow[]>('admin_rounds', { p_game: game, p_before: before ?? null, p_limit: 30 }),
  roundBets: id => call<RoundBet[]>('admin_round_bets', { p_round: id }),
  roundVerify: id => call<RoundCheck>('admin_round_verify', { p_round: id }),
  catalogueCases: () => call<CatCase[]>('admin_catalogue_cases'),
  catalogueCase: id => call<CatCaseFull>('admin_catalogue_case', { p_id: id }),
  catalogueItems: (q, min = 0, max = null) => call<CatItem[]>('admin_catalogue_items', { p_query: q, p_min: min, p_max: max, p_limit: 60 }),
  catalogueSave: (c, version, reason) => call('admin_catalogue_save', { p_id: c.id, p_version: version, p_name: c.name, p_price: c.price, p_hue: c.hue, p_tag: c.tag, p_art: c.art, p_sort: c.sort, p_entries: c.entries, p_reason: reason }),
  catalogueSetActive: async (id, active, reason) => { await call('admin_catalogue_set_active', { p_id: id, p_active: active, p_reason: reason }); },
  catalogueRestore: (id, version, reason) => call('admin_catalogue_restore', { p_id: id, p_version: version, p_reason: reason }),
  rewardSettings: () => call<RewardSettings>('admin_reward_settings'),
  saveRewardSettings: (s, reason) => call<RewardSettings>('admin_reward_settings_save', { p_faucet_amount: s.faucet_amount, p_faucet_minutes: s.faucet_minutes, p_rb_instant: s.rakeback.instant,
    p_rb_daily: s.rakeback.daily, p_rb_weekly: s.rakeback.weekly, p_calendar: s.calendar, p_race_prizes: s.race_prizes, p_reason: reason }),
  rewardStats: () => call<RewardStats>('admin_reward_stats'),
  promos: () => call<Promo[]>('admin_promos'),
  promoUsers: code => call('admin_promo_users', { p_code: code }),
  savePromo: async (p, reason) => { await call('admin_promo_save', { p_code: p.code, p_amount: p.amount, p_max_uses: p.max_uses, p_expires_at: p.expires_at, p_active: p.active, p_note: p.note, p_reason: reason }); },
  announcements: () => call<AnnouncementRow[]>('admin_announcements'),
  announce: async (a, reason) => { await call('admin_announce', { p_kind: a.kind, p_style: a.style, p_body: a.body, p_starts_at: a.starts_at, p_ends_at: a.ends_at, p_reason: reason }); },
  endAnnouncement: async (id, reason) => { await call('admin_announce_end', { p_id: id, p_reason: reason }); },
  races: () => call<AdminRace[]>('admin_races'),
  saveRace: async (r, reason) => { await call('admin_race_save', { p_id: r.id, p_name: r.name, p_starts: r.starts_at, p_ends: r.ends_at, p_prizes: r.prizes, p_games: r.games, p_reason: reason }); },
  payRace: (id, reason) => call('admin_race_pay', { p_id: id, p_reason: reason }),
  cancelRace: async (id, reason) => { await call('admin_race_cancel', { p_id: id, p_reason: reason }); },
  rains: () => call<AdminRain[]>('admin_rains'),
  startRain: async (pot, seconds, minLevel, reason) => { await call('admin_rain_start', { p_pot: pot, p_seconds: seconds, p_min_level: minLevel, p_reason: reason }); },
  cancelRain: async (id, reason) => { await call('admin_rain_cancel', { p_id: id, p_reason: reason }); },
  giveaways: () => call<AdminGiveaway[]>('admin_giveaways'),
  createGiveaway: async (g, reason) => { await call('admin_giveaway_create', { p_title: g.title, p_prize: g.prize, p_winners: g.winners, p_min_level: g.min_level, p_starts: g.starts_at, p_ends: g.ends_at, p_reason: reason }); },
  drawGiveaway: (id, reason) => call('admin_giveaway_draw', { p_id: id, p_reason: reason }),
  cancelGiveaway: async (id, reason) => { await call('admin_giveaway_cancel', { p_id: id, p_reason: reason }); },
  gameSettings: () => call<GameSettings>('admin_game_settings'),
  saveGameSettings: (s, reason) => call<GameSettings>('admin_game_settings_save', { p_crash: s.crash_bet_seconds, p_double: s.double_bet_seconds, p_lobby: s.lobby_minutes,
    p_battles_max: s.battle_lobbies_max, p_flips_max: s.flip_lobbies_max, p_bots_battles: s.bots_battles, p_bots_coinflip: s.bots_coinflip, p_simulated: s.simulated_activity,
    p_bot_names: s.bot_names, p_limits: s.limits, p_reason: reason }),
};

/** What to tell a person when an admin call fails (the database raises short codes). */
export const ADMIN_ERRORS: Record<string, string> = {
  admin_denied: 'You do not have access to that.',
  admin_mfa_required: 'Enter your authenticator code first.',
  admin_session_required: 'The admin session is locked. Enter your admin password.',
  weak_password: 'Use at least 14 characters, with at least 3 of: lower case, upper case, numbers, symbols. No obvious words, no repeated letters, and not your name.',
  reason_required: 'Write a short reason (at least 3 characters).',
  not_allowed_self: 'You cannot change your own role.',
  owner_by_sql_only: 'The Owner role can only be given by SQL.',
  owner_is_fixed: 'The Owner role is fixed and cannot be restricted.',
  rank_too_low: 'You can only change people and roles below your own rank.',
  cannot_grant_what_you_lack: 'You cannot grant a permission you do not hold yourself.',
  unknown_role: 'Unknown role.', unknown_permission: 'Unknown permission.',
  read_only_only: 'Only SELECT, WITH, TABLE and VALUES queries are allowed.',
  one_statement_only: 'One statement at a time (no semicolons inside).',
  invalid_query: 'Write a query first.',
  invalid_value: 'That value is not allowed.', text_too_long: 'That text is too long.', text_required: 'Write the text to show first.',
  unknown_game: 'Unknown game.', invalid_country: 'Use two-letter country codes such as US or GB (at most 250).',
  adjust_amount_invalid: 'Enter an amount above zero with at most 2 decimals, up to 10,000,000.', debit_exceeds_balance: 'The player does not have that many coins: a debit cannot take the balance below zero.',
  key_reused: 'That request was already used for something else. Close this box and start again.', player_not_found: 'That player has no open account.',
  invalid_name: 'Names are 2 to 20 letters, numbers, spaces, - or _.', name_taken: 'Another player already has that name.',
  staff_account: 'Staff accounts cannot be closed here. Remove the staff role first.', confirm_mismatch: "Type the player's current name exactly to confirm.",
  message_not_found: 'That message no longer exists or was already removed.', battle_not_found: 'That battle no longer exists.', flip_not_found: 'That coinflip no longer exists.',
  already_started: 'That game has already started, so it cannot be cancelled.', flip_not_open: 'That coinflip is no longer waiting, so it cannot be cancelled.',
  round_not_finished: 'Only a finished round can be checked.', invalid_game: 'Unknown game.',
  case_not_found: 'That case does not exist.', case_changed: 'Someone saved this case after you opened it. Open it again to see their version, then make your change.',
  case_in_use: 'A battle that is waiting for players uses this case. Its price cannot change and it cannot be switched off until that battle starts or is cancelled (see Live rooms).',
  invalid_case_id: 'The case id is 2 to 30 lower-case letters, numbers or dashes (for example summer-drop). It cannot be changed later.',
  invalid_case_name: 'The name is 2 to 40 characters.', invalid_price: 'Enter a price above 0 with at most 2 decimals (up to 100,000).',
  invalid_entries: 'A case needs 1 to 60 items, each with at least 1 ticket (0.001%).', duplicate_item: 'The same item is in the case twice.',
  unknown_item: 'One of the items is not in the catalogue (or is retired).', tickets_not_100000: 'The chances must add up to exactly 100%.',
  rtp_out_of_range: 'At this price the case would return less than 70% or more than 98% of its price on average. Change the price or the chances.',
  rakeback_too_high: 'The three rakeback shares together can be at most 5% of every stake.',
  invalid_bot_names: 'Give 3 to 100 bot names, each 2 to 20 letters, numbers, _, - or &.', bot_name_taken: 'A new bot name is a real player\'s name. Bots must never pass for players: pick another.',
  race_not_found: 'That race does not exist.', race_closed: 'That race has ended or was paid or cancelled, so it cannot change.', race_not_ended: 'Prizes can be paid once the race has ended (and only once).',
  rain_active: 'A coin rain is already running. Wait for it to end or cancel it.', rain_closed: 'That coin rain has already ended.',
  giveaway_not_found: 'That giveaway does not exist.', giveaway_not_ended: 'A giveaway can be drawn once its entries have closed (and only once).', giveaway_closed: 'That giveaway was already drawn.',
  invalid_code_format: 'A code is 3 to 20 letters, numbers, - or _ (it is saved in capitals).', invalid_dates: 'The end must be after the start and in the future; the start at most 90 days ahead.',
};
export const errorText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const code = Object.keys(ADMIN_ERRORS).find(k => m.includes(k));
  return code ? (ADMIN_ERRORS[code] as string) : m;
};
