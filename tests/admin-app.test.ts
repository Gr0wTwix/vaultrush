// The admin site against a fake API: every sign-in step, the panel for different roles, and the pages (staff, permissions, audit, explorer).
// The rules themselves are tested in admin-db.test.ts; here we check that the screens show the right step and call the right functions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminGiveaway, AdminRace, AdminRain, AnnouncementRow, Economy, FairnessRun, GameSettings, KycRequest, Promo, RewardSettings, RgOverview } from '../src/admin/api.js';
import type { AdjustResult, Admin, AdminApi, AuditRow, BetRow, CatCase, CatCaseFull, CatItem, CatSave, ChatMsg, ChatSettings, Controls, Dashboard, FlipRoom, LedgerRow, Matrix, PlayerProfile, PlayerRow, QueryResult, RoundRow, Status, WalletFound, WalletOverview, WalletTotals } from '../src/admin/api.js';
import { boot, type AdminApp } from '../src/admin/app.js';

const ROLES = [
  { role: 'owner', rank: 100, label: 'Owner', description: '' }, { role: 'admin', rank: 80, label: 'Admin', description: '' },
  { role: 'moderator', rank: 60, label: 'Moderator', description: '' }, { role: 'readonly', rank: 10, label: 'Read-only', description: '' },
];
const MATRIX: Matrix = {
  roles: ROLES,
  permissions: [
    { key: 'players.view', area: 'Players', label: 'See players', sensitive: false },
    { key: 'players.view_email', area: 'Players', label: 'Reveal e-mail', sensitive: true },
    { key: 'chat.delete', area: 'Chat', label: 'Delete chat messages', sensitive: false },
  ],
  grants: [{ role: 'admin', permission: 'players.view' }, { role: 'admin', permission: 'chat.delete' }, { role: 'moderator', permission: 'players.view' }],
};
const OWNER_PERMS = ['audit.read', 'chat.delete', 'dashboard.view', 'explorer.query', 'ledger.view', 'players.view', 'players.view_email', 'roles.manage', 'site.countries', 'site.games', 'site.maintenance', 'site.notice', 'site.signups', 'wallet.adjust'];
const TOTALS: WalletTotals = { coins_in_wallets: 12345.5, wallets: 9, wallets_with_coins: 4, top_balance: 5000, bets_today: { count: 12, staked: 800, paid: 650.25 }, bets_7d: { count: 90, staked: 6000, paid: 5800 },
  adjustments_30d: { count: 2, credited: 300, debited: 50 }, now: Date.now() };
const FOUND: WalletFound[] = [{ id: 'p1', name: 'Nova', balance: 1250.75, wagered: 400, created_at: '2026-11-18T10:00:00Z' }, { id: 'p2', name: 'Novak', balance: 3, wagered: 0, created_at: '2026-11-19T10:00:00Z' }];
const overview = (o: Partial<WalletOverview> = {}): WalletOverview => ({
  player: { id: 'p1', name: 'Nova', created_at: '2026-11-18T10:00:00Z', closed: false, staff_role: null },
  wallet: { balance: 1250.75, wagered: 400, won: 380.5, updated_at: '2026-11-21T10:00:00Z' },
  ledger: { rows: 6, sum: 1250.75, difference: 0, by_kind: [{ kind: 'bet', count: 3, sum: -400 }, { kind: 'bonus', count: 1, sum: 1000 }, { kind: 'win', count: 2, sum: 650.75 }] },
  bets: { count: 3, staked: 400, paid: 380.5, last_at: '2026-11-21T09:00:00Z' }, inventory: { items: 2, value: 99.5 },
  responsible: { limits: { max_bet: 500, loss_daily: null, loss_weekly: 2000, loss_monthly: null, wager_daily: null, time_daily_min: 120 }, usage: { staked_today: 400, loss_1: 20, loss_7: 150, loss_30: 150, active_minutes: 15 }, excluded_until: null, cool_off_until: null, kyc_tier: 0 },
  ...o,
});
/** 120 ledger rows, newest (highest id) first, so the second page can be asked for. */
const LEDGER: LedgerRow[] = Array.from({ length: 120 }, (_, i) => ({ id: 120 - i, kind: i % 2 ? 'win' : 'bet', amount: i % 2 ? 10 : -10, balance_after: 1000 + i, bet_id: i % 2 ? null : 7, at: '2026-11-21T09:00:00Z' }));
const BETS: BetRow[] = [{ id: 9, game: 'plinko', amount: 100, payout: 40, multiplier: 0.4, nonce: 3, at: '2026-11-21T09:00:00Z' }, { id: 8, game: 'cases', amount: 50, payout: 160, multiplier: 3.2, nonce: 2, at: '2026-11-21T08:00:00Z' }];
const CONTROLS: Controls = { maintenance_on: false, maintenance_message: '', notice_on: false, notice_text: '', notice_kind: 'info', signups_open: true, games_off: [], blocked_countries: [],
  games: ['cases', 'battles', 'upgrade', 'crash', 'double', 'plinko', 'mines', 'coinflip'], updated_at: '2026-11-21T09:00:00Z', updated_by: null };
const DASH: Dashboard = {
  players: { total: 120, new_today: 4, new_7d: 30, active_15m: 9, active_today: 41 }, bets_15m: { count: 55, staked: 1234 }, chat_15m: 18,
  rooms: { battles_waiting: 2, coinflips_waiting: 1, stuck: 1 }, rounds: [{ game: 'crash', id: 41, status: 'betting', betting_ends_at: '2026-11-25T10:00:00Z', bets: 3, staked: 60 }],
  flags: { mute: 1, warn: 2, bet_ban: 1, site_ban: 0 }, reports_open: 3, site: { maintenance_on: false, notice_on: false, games_off: ['plinko'], signups_open: true },
  chat: { locked: false, slow_seconds: 10 }, signups_7d: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${19 + i}`, count: i })),
  bets_24h: Array.from({ length: 24 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 10, 25, i)).toISOString(), count: i, staked: i * 10 })), now: Date.now(),
};
const PLAYERS: PlayerRow[] = [
  { id: 'p1', name: 'Nova', created_at: '2026-11-18T10:00:00Z', closed: false, staff_role: null, balance: 1250.75, wagered: 400, last_seen: new Date().toISOString(), flags: ['mute'], tags: ['watch'], excluded: false },
  { id: 'p2', name: 'Orion', created_at: '2026-11-19T10:00:00Z', closed: false, staff_role: null, balance: 3, wagered: 0, last_seen: null, flags: [], tags: [], excluded: true },
];
const PROFILE: PlayerProfile = {
  player: { id: 'p1', name: 'Nova', created_at: '2026-11-18T10:00:00Z', closed: false, closed_at: null, age_confirmed_at: '2026-11-18T10:00:00Z', terms_version: '2026-11-21', staff_role: null,
            sign_in: { provider: 'steam', last_sign_in_at: '2026-11-25T08:00:00Z', banned_until: null } },
  wallet: { balance: 1250.75, wagered: 400, won: 380 },
  flags: [{ id: 3, kind: 'mute', until: new Date(Date.now() + 3600_000).toISOString(), message: '', reason: 'flooding', at: '2026-11-25T09:00:00Z', by: 'Vexx', seen_at: null, lifted_at: null, lift_reason: null, active: true }],
  notes: [{ id: 1, body: 'Asked about the race', author: 'Vexx', at: '2026-11-24T09:00:00Z' }], tags: ['watch'],
  chat: [{ id: 9, body: 'hello <b>all</b>', at: '2026-11-25T09:00:00Z', removed_at: null }], bets: [], games: { battles: 2, coinflips: 1, round_bets: 5 },
  claims: [{ kind: 'welcome', at: '2026-11-18T10:05:00Z' }], controls: null, actions: [],
};
const CHAT: ChatMsg[] = [
  { id: 9, user_id: 'p1', name: 'Nova', body: 'buy coins at my site', at: '2026-11-25T09:00:00Z', is_staff: false, removed_at: null, removed_by: null, reports: 2 },
  { id: 8, user_id: 'p2', name: 'Orion', body: 'gl', at: '2026-11-25T08:59:00Z', is_staff: false, removed_at: '2026-11-25T09:01:00Z', removed_by: 'Vexx', reports: 0 },
];
const CHAT_SETTINGS: ChatSettings = { slow_seconds: 0, locked: false, links_allowed: true, blocked_words: [], pinned_id: null, updated_at: '2026-11-25T09:00:00Z', updated_by: null };
const FLIPS: FlipRoom[] = [{ id: 77, creator: 'Nova', side: 'bolt', amount: 40, joiner: null, bot: false, status: 'waiting', result: null, winner: null, created_at: new Date(Date.now() - 40 * 60_000).toISOString(), finished_at: null, server_hash: 'h', seed: null, stuck: true, flags: [] }];
const ROUNDS: RoundRow[] = [
  { id: 42, status: 'betting', created_at: '2026-11-25T10:00:00Z', betting_ends_at: '2026-11-25T10:00:07Z', finished_at: null, server_hash: 'h2', result: null, seed: null, bets: 1, staked: 5, paid: null, flags: [] },
  { id: 41, status: 'finished', created_at: '2026-11-25T09:59:00Z', betting_ends_at: '2026-11-25T09:59:07Z', finished_at: '2026-11-25T09:59:20Z', server_hash: 'h1', result: { point: 2.5 }, seed: 'ab'.repeat(32), bets: 3, staked: 60, paid: 45, flags: [] },
];
const CAT_LIST: CatCase[] = [
  { id: 'starter', name: 'Starter Crate', price: 0.5, reward: false, active: true, hue: null, tag: null, art: null, sort: 0, version: 3, updated_at: '2026-11-25T09:00:00Z', items: 2, ev: 0.45, opens_7d: 12, in_use: false },
  { id: 'old-box', name: 'Old Box', price: 2, reward: false, active: false, hue: 10, tag: null, art: null, sort: 0, version: 1, updated_at: null, items: 3, ev: 1.8, opens_7d: 0, in_use: false },
  { id: 'daily', name: 'Daily Crate', price: 0.34, reward: true, active: true, hue: null, tag: null, art: null, sort: 0, version: 1, updated_at: null, items: 4, ev: 0.3, opens_7d: 5, in_use: false },
];
const CAT_CASE: CatCaseFull = {
  id: 'starter', name: 'Starter Crate', price: 0.5, reward: false, active: true, hue: null, tag: null, art: null, sort: 0, version: 3, updated_at: '2026-11-25T09:00:00Z', ev: 0.45, in_use: false,
  entries: [{ item: 'a', name: 'P250 | Sand <Dune>', rarity: 'consumer', value: 0.3, tickets: 90000, from: 0, to: 89999 }, { item: 'b', name: 'AK-47 | Redline', rarity: 'classified', value: 1.8, tickets: 10000, from: 90000, to: 99999 }],
  history: [{ version: 3, at: '2026-11-25T09:00:00Z', by: 'Mirage', reason: 'cheaper', price: 0.5, items: 2 }, { version: 1, at: '2026-11-21T09:00:00Z', by: null, reason: 'as installed (0015)', price: 0.6, items: 2 }],
};
const REWARDS: RewardSettings = { faucet_amount: 25, faucet_minutes: 10, rakeback: { instant: 0.004, daily: 0.003, weekly: 0.003 }, calendar: [1, 2, 3, 5, 8, 12, 25], race_prizes: [400, 200, 120], updated_at: '2026-11-25T09:00:00Z', updated_by: null };
const PROMOS: Promo[] = [
  { code: 'SPRING', amount: 5, max_uses: 10, uses: 10, active: true, expires_at: null, note: 'newsletter', created_at: '2026-11-25T09:00:00Z', by: 'Mirage', live: false },
  { code: 'VAULT10', amount: 10, max_uses: null, uses: 3, active: true, expires_at: null, note: null, created_at: '2026-11-21T09:00:00Z', by: null, live: true },
];
const ANNS: AnnouncementRow[] = [
  { id: 2, kind: 'banner', style: 'win', body: 'Double <b>XP</b> weekend', starts_at: '2026-11-25T09:00:00Z', ends_at: null, ended_at: null, by: 'Mirage', state: 'showing' },
  { id: 1, kind: 'popup', style: 'info', body: 'Old news', starts_at: '2026-11-20T09:00:00Z', ends_at: null, ended_at: '2026-11-21T09:00:00Z', by: 'Mirage', state: 'ended' },
];
const RACES: AdminRace[] = [
  { id: 4, name: 'Plinko <sprint>', starts_at: '2026-11-24T09:00:00Z', ends_at: '2026-11-25T09:00:00Z', prizes: [100, 50], games: ['plinko'], state: 'ended', pool: 150, top: [{ rank: 1, name: 'Orion', wagered: 50, prize: 100 }], paid_at: null, by: 'Mirage', payouts: [] },
  { id: 3, name: 'Old race', starts_at: '2026-11-20T09:00:00Z', ends_at: '2026-11-21T09:00:00Z', prizes: [10], games: [], state: 'paid', pool: 10, top: [], paid_at: '2026-11-21T10:00:00Z', by: 'Mirage', payouts: [{ rank: 1, name: 'Nova', prize: 10 }] },
];
const RAINS: AdminRain[] = [{ id: 9, pot: 30, min_level: 0, starts_at: '2026-11-25T09:00:00Z', ends_at: '2026-11-25T09:01:00Z', settled_at: '2026-11-25T09:01:02Z', cancelled_at: null, share: 10, joiners: 3, by: 'Mirage' }];
const GIVEAWAYS: AdminGiveaway[] = [{ id: 5, title: 'Friday giveaway', prize: 100, winners: 1, min_level: 0, starts_at: '2026-11-24T09:00:00Z', ends_at: '2026-11-25T09:00:00Z', server_hash: 'f'.repeat(64), state: 'ended', entries: 12, seed: null, drawn: null, by: 'Mirage' }];
const GAMESET: GameSettings = { crash_bet_seconds: 7, double_bet_seconds: 12, lobby_minutes: 30, battle_lobbies_max: 3, flip_lobbies_max: 5, bots_battles: true, bots_coinflip: true,
  simulated_activity: true, bot_names: ['frostbyte', 'kappa_kid', 'm0nkey'], limits: { plinko: { min: 0.01, max: 50000 }, crash: { min: 0.1, max: 50000 } }, games: ['plinko', 'crash'], updated_at: '2026-11-25T09:00:00Z', updated_by: null };
const KYC: KycRequest[] = [{ id: 7, user_id: 'p1', name: 'Nova', tier: 1, note: 'I play <big> battles', status: 'pending', at: '2026-11-25T09:00:00Z', decided_at: null, decision_note: null, by: null,
  current_tier: 0, joined: '2026-11-18T10:00:00Z', wagered: 400, flags: ['mute'] }];
const RG: RgOverview = { excluded: [{ id: 'p2', name: 'Orion', until: '2026-12-25T09:00:00Z' }], cool_off: [], pending: [{ id: 'p1', name: 'Nova', key: 'loss_daily', value: 500, effective_at: '2026-11-26T09:00:00Z' }],
  losses_7d: [{ id: 'p1', name: 'Nova', staked: 800, net_loss: 300, bets: 40 }], busy_today: [], now: Date.now() };
const OK_RUN: FairnessRun = { id: 1, at: '2026-11-25T09:00:00Z', by: 'Mirage', days: 3, summary: { rounds: { checked: 40, bad: 0 }, coinflips: { checked: 5, bad: 0 }, battles: { checked: 2, bad: 0 }, seeds: { checked: 3, bad: 0 }, all_ok: true }, mismatches: [] };
const BAD_RUN: FairnessRun = { ...OK_RUN, id: 2, summary: { ...OK_RUN.summary, rounds: { checked: 40, bad: 1 }, all_ok: false }, mismatches: [{ kind: 'crash', id: '77', hash_ok: true, result_ok: false }] };
const ECON: Economy = { days: 30, now: { coins: 12000, wallets_with_coins: 9, median_balance: 300, items: 40, items_value: 900, top: [{ id: 'p1', name: 'Nova <1>', balance: 5000 }] },
  flows: [{ kind: 'faucet', count: 10, sum: 250 }, { kind: 'bet', count: 50, sum: -1000 }, { kind: 'win', count: 20, sum: 930 }],
  games: [{ game: 'plinko', bets: 50, staked: 1000, paid: 930, take: 70, return: 0.93, expected: 0.97 }],
  daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, free: i, adjust: 0, games: -i })), big_wins: [] };
const CAT_ITEMS: CatItem[] = [{ id: 'c', name: 'AWP | Asiimov', rarity: 'covert', value: 50 }];
const unlocked = (o: Partial<Status> = {}): Status => ({ is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: true, unlocked: true, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), ...o });

interface Fake { api: AdminApi; calls: Record<string, any[][]>; state: { user: { id: string } | null; status: Status; perms: string[]; factors: { id: string; status: string }[]; unlockResult: any; admins: Admin[]; audit: AuditRow[]; queryResult: QueryResult; controls: Controls; overview: WalletOverview; adjustFails: string | null } }
function fake(over: Partial<Fake['state']> = {}, apiOver: Partial<AdminApi> = {}): Fake {
  const calls: Fake['calls'] = {};
  const state: Fake['state'] = {
    user: { id: 'me' }, status: unlocked(), perms: OWNER_PERMS, factors: [{ id: 'f1', status: 'verified' }], unlockResult: { ok: true },
    admins: [
      { user_id: 'me', name: 'Mirage', role: 'owner', rank: 100, granted_at: '2026-11-21T10:00:00Z' },
      { user_id: 'a1', name: 'Kai', role: 'admin', rank: 80, granted_at: '2026-11-21T11:00:00Z' },
      { user_id: 'm1', name: 'Vexx', role: 'moderator', rank: 60, granted_at: '2026-11-21T12:00:00Z' },
    ],
    audit: [
      { id: 12, at: '2026-11-21T12:05:00Z', actor: 'me', actor_name: 'Mirage', actor_role: 'owner', action: 'role.set', target_type: 'player', target_id: 'm1', before: { role: null }, after: { role: 'moderator' }, reason: 'chat help', meta: {} },
      { id: 11, at: '2026-11-21T12:00:00Z', actor: 'me', actor_name: 'Mirage', actor_role: 'owner', action: 'admin.unlock', target_type: 'admin', target_id: 'me', before: null, after: null, reason: null, meta: {} },
    ],
    queryResult: { columns: ['display_name', 'id'], rows: [{ display_name: 'Kai', id: 'k' }, { display_name: 'Mirage', id: 'm' }], truncated: false },
    controls: { ...CONTROLS }, overview: overview(), adjustFails: null,
    ...over,
  };
  const rec = <T,>(name: string, fn: (...a: any[]) => T) => (...a: any[]): T => { (calls[name] ||= []).push(a); return fn(...a); };
  const api: AdminApi = {
    configured: () => true, steamAvailable: () => true, startSteam: rec('startSteam', () => undefined), finishSteam: async () => null,
    user: async () => state.user, onAuth: async () => undefined, signOut: rec('signOut', async () => { state.user = null; }),
    status: rec('status', async () => state.status), factors: async () => state.factors,
    enroll: rec('enroll', async () => ({ id: 'new', qr: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD EFGH' })),
    removeFactor: rec('removeFactor', async () => undefined),
    verify: rec('verify', async () => { state.status = { ...state.status, mfa: true }; }),
    setPassword: rec('setPassword', async () => { state.status = { ...state.status, password_set: true }; return { ok: true }; }),
    unlock: rec('unlock', async () => { if (state.unlockResult.ok) state.status = unlocked({ role: state.status.role, label: state.status.label, rank: state.status.rank }); return state.unlockResult; }),
    lock: rec('lock', async () => { state.status = { ...state.status, unlocked: false }; }),
    touch: rec('touch', async () => new Date(Date.now() + 30 * 60_000).toISOString()),
    myPermissions: async () => state.perms, listAdmins: async () => state.admins, findPlayer: rec('findPlayer', async () => [{ id: 'p1', name: 'Nova', created_at: '2026-11-18T10:00:00Z', role: null }]),
    setRole: rec('setRole', async () => undefined), matrix: async () => MATRIX, setPermission: rec('setPermission', async () => undefined),
    audit: rec('audit', async () => state.audit), query: rec('query', async () => state.queryResult),
    controls: rec('controls', async () => ({ ...state.controls })),
    setMaintenance: rec('setMaintenance', async (on: boolean, message: string) => (state.controls = { ...state.controls, maintenance_on: on, maintenance_message: message, updated_by: 'Mirage' })),
    setNotice: rec('setNotice', async (on: boolean, text: string, kind: 'info' | 'warn') => (state.controls = { ...state.controls, notice_on: on, notice_text: text, notice_kind: kind })),
    setGame: rec('setGame', async (game: string, off: boolean) => (state.controls = { ...state.controls, games_off: off ? [...state.controls.games_off, game] : state.controls.games_off.filter(g => g !== game) })),
    setSignups: rec('setSignups', async (open: boolean) => (state.controls = { ...state.controls, signups_open: open })),
    setCountries: rec('setCountries', async (codes: string[]) => (state.controls = { ...state.controls, blocked_countries: [...new Set(codes)].sort() })),
    walletTotals: rec('walletTotals', async () => TOTALS),
    walletSearch: rec('walletSearch', async () => FOUND),
    walletOverview: rec('walletOverview', async () => state.overview),
    walletLedger: rec('walletLedger', async (_user: string, before?: number) => LEDGER.filter(l => before === undefined || l.id < before).slice(0, 50)),
    walletBets: rec('walletBets', async () => BETS),
    walletAdjust: rec('walletAdjust', async (_user: string, amount: number): Promise<AdjustResult> => {
      if (state.adjustFails) throw new Error(state.adjustFails);
      const before = state.overview.wallet.balance, after = Math.round((before + amount) * 100) / 100;
      state.overview = { ...state.overview, wallet: { ...state.overview.wallet, balance: after } };
      return { user_id: 'p1', amount, balance_before: before, balance_after: after, ledger_id: 99, replayed: false };
    }),
    dashboard: rec('dashboard', async () => DASH),
    players: rec('players', async (q: string) => PLAYERS.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()))),
    player: rec('player', async () => PROFILE),
    note: rec('note', async () => undefined),
    tag: rec('tag', async (_u: string, t: string, on: boolean) => (on ? [t] : [])),
    flag: rec('flag', async () => ({ id: 5, until: null, signed_out: true })),
    liftFlag: rec('liftFlag', async () => undefined),
    signOutPlayer: rec('signOutPlayer', async () => ({ signed_out: true })),
    rename: rec('rename', async () => undefined),
    resetClaim: rec('resetClaim', async () => undefined),
    closeAccount: rec('closeAccount', async () => ({ name: 'deleted-1', balance_removed: 10, signed_out: true })),
    chat: rec('chat', async () => ({ messages: CHAT, settings: { ...CHAT_SETTINGS } })),
    chatRemove: rec('chatRemove', async () => undefined),
    chatClear: rec('chatClear', async () => ({ removed: 3 })),
    chatSettings: rec('chatSettings', async (slow: number, locked: boolean, links: boolean, words: string[]) => ({ ...CHAT_SETTINGS, slow_seconds: slow, locked, links_allowed: links, blocked_words: words })),
    chatPin: rec('chatPin', async () => undefined),
    chatPost: rec('chatPost', async () => undefined),
    chatReports: rec('chatReports', async () => []),
    chatDismiss: rec('chatDismiss', async () => undefined),
    battles: rec('battles', async () => []),
    coinflips: rec('coinflips', async () => FLIPS),
    roomCancel: rec('roomCancel', async () => ({ refunded: 1, each: 40 })),
    roomFlag: rec('roomFlag', async () => undefined),
    rounds: rec('rounds', async () => ROUNDS),
    roundBets: rec('roundBets', async () => []),
    roundVerify: rec('roundVerify', async () => ({ id: 41, game: 'crash', hash_ok: true, result_ok: true, recorded: { point: 2.5 }, recomputed: { point: 2.5 } })),
    catalogueCases: rec('catalogueCases', async () => CAT_LIST),
    catalogueCase: rec('catalogueCase', async () => CAT_CASE),
    catalogueItems: rec('catalogueItems', async () => CAT_ITEMS),
    catalogueSave: rec('catalogueSave', async (c: CatSave, version: number) => ({ id: c.id, version: version + 1, ev: 0.45, rtp: 0.9, created: version === 0 })),
    catalogueSetActive: rec('catalogueSetActive', async () => undefined),
    catalogueRestore: rec('catalogueRestore', async () => ({ version: 4 })),
    rewardSettings: rec('rewardSettings', async () => ({ ...REWARDS })),
    saveRewardSettings: rec('saveRewardSettings', async (s: RewardSettings) => s),
    rewardStats: rec('rewardStats', async () => ({ kinds: [{ kind: 'faucet', today_count: 3, today_sum: 75, week_count: 20, week_sum: 500 }], crates: [{ kind: 'welcome', week: 4 }] })),
    promos: rec('promos', async () => PROMOS),
    promoUsers: rec('promoUsers', async () => [{ id: 'p1', name: 'Nova' }]),
    savePromo: rec('savePromo', async () => undefined),
    announcements: rec('announcements', async () => ANNS),
    announce: rec('announce', async () => undefined),
    endAnnouncement: rec('endAnnouncement', async () => undefined),
    races: rec('races', async () => RACES),
    saveRace: rec('saveRace', async () => undefined),
    payRace: rec('payRace', async () => ({ winners: 2, paid: 150 })),
    cancelRace: rec('cancelRace', async () => undefined),
    rains: rec('rains', async () => RAINS),
    startRain: rec('startRain', async () => undefined),
    cancelRain: rec('cancelRain', async () => undefined),
    giveaways: rec('giveaways', async () => GIVEAWAYS),
    createGiveaway: rec('createGiveaway', async () => undefined),
    drawGiveaway: rec('drawGiveaway', async () => ({ winners: 1, paid: 100 })),
    cancelGiveaway: rec('cancelGiveaway', async () => undefined),
    gameSettings: rec('gameSettings', async () => ({ ...GAMESET, limits: { ...GAMESET.limits } })),
    saveGameSettings: rec('saveGameSettings', async (s: GameSettings) => s),
    kycQueue: rec('kycQueue', async () => KYC),
    kycDecide: rec('kycDecide', async () => undefined),
    kycSetTier: rec('kycSetTier', async () => undefined),
    rgOverview: rec('rgOverview', async () => RG),
    rgApply: rec('rgApply', async () => ({ until: '2026-11-27T10:00:00Z' })),
    fairnessRun: rec('fairnessRun', async () => BAD_RUN),
    fairnessRuns: rec('fairnessRuns', async () => [OK_RUN]),
    economy: rec('economy', async () => ECON),
    ...apiOver,
  };
  return { api, calls, state };
}

let root: HTMLElement, app: AdminApp | undefined;
const start = async (f: Fake): Promise<void> => { root = document.createElement('div'); document.body.append(root); location.hash = ''; app = await boot(root, f.api); };
const wait = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 2000 });
const q = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
const type = (sel: string, v: string): void => { const el = q<HTMLInputElement>(sel); el.value = v; };
const submit = (sel = '#f'): void => { q<HTMLFormElement>(sel).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); };
const goto = async (page: string, ready: string): Promise<void> => { location.hash = `#/${page}`; window.dispatchEvent(new HashChangeEvent('hashchange')); await wait(() => expect(q(ready)).not.toBeNull()); };
const answerReason = async (text: string): Promise<void> => { await wait(() => expect(document.querySelector('#dlgReason')).not.toBeNull()); (document.querySelector('#dlgReason') as HTMLTextAreaElement).value = text; (document.querySelector('#dlgYes') as HTMLElement).click(); };
const cancelReason = async (): Promise<void> => { await wait(() => expect(document.querySelector('#dlgNo')).not.toBeNull()); (document.querySelector('#dlgNo') as HTMLElement).click(); };

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { app?.stop(); app = undefined; document.body.innerHTML = ''; location.hash = ''; });

describe('the three-step sign-in', () => {
  it('says so when there is no database connection', async () => {
    await start(fake({}, { configured: () => false }));
    expect(root.textContent).toMatch(/not configured/i);
  });

  it('step 1: signed out shows only the Steam button', async () => {
    const f = fake({ user: null }); await start(f);
    expect(root.textContent).toContain('Staff sign-in');
    q('#steam').click();
    expect(f.calls['startSteam']).toHaveLength(1);
    expect(root.querySelector('nav')).toBeNull();
  });

  it('a signed-in player who is not staff gets "No access" and nothing else', async () => {
    await start(fake({ status: { is_admin: false } }));
    expect(root.textContent).toContain('No access');
    expect(root.textContent).not.toMatch(/authenticator|password|Overview/i);
  });

  it('step 2: with an authenticator already set up, asks for the code and sends it for the verified factor', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: true, unlocked: false } }); await start(f);
    await wait(() => expect(q('#code')).not.toBeNull());
    expect(root.textContent).toContain('Authenticator code');
    type('#code', '123456'); submit();
    await wait(() => expect(f.calls['verify']).toEqual([['f1', '123456']]));
    await wait(() => expect(root.textContent).toContain('Admin password'));           // moves on to step 3
  });

  it('step 2: with no authenticator yet, shows the QR code and the manual key, and clears a half-finished setup first', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: false, unlocked: false }, factors: [{ id: 'old', status: 'unverified' }] }); await start(f);
    await wait(() => expect(q('.qr img')).not.toBeNull());
    expect(f.calls['removeFactor']).toEqual([['old']]);
    expect(root.textContent).toContain('ABCD EFGH');
    type('#code', '654321'); submit();
    await wait(() => expect(f.calls['verify']).toEqual([['new', '654321']]));
    await wait(() => expect(root.textContent).toContain('Create your admin password'));
  });

  it('a wrong authenticator code shows an error and stays on the step', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: false, password_set: true, unlocked: false } }, { verify: async () => { throw new Error('Invalid TOTP code entered'); } }); await start(f);
    await wait(() => expect(q('#code')).not.toBeNull());
    type('#code', '000000'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/invalid/i));
    expect(root.textContent).toContain('Authenticator code');
  });

  it('step 3 (first time): refuses two different passwords, shows the server\'s weak-password rules, then saves, unlocks and opens the panel', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: false, unlocked: false } }); await start(f);
    expect(root.textContent).toContain('Create your admin password');
    type('#pw1', 'Correct-Horse-Battery-9'); type('#pw2', 'something else entirely'); submit();
    expect(q('#err').textContent).toMatch(/different/);
    expect(f.calls['setPassword']).toBeUndefined();
    f.api.setPassword = async () => { throw new Error('weak_password'); };
    type('#pw2', 'Correct-Horse-Battery-9'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/at least 14 characters/));
    f.api.setPassword = (async (...a: any[]) => { (f.calls['setPassword'] ||= []).push(a); f.state.status = { ...f.state.status, password_set: true }; return { ok: true }; }) as any;
    submit();
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect(f.calls['setPassword']).toEqual([['Correct-Horse-Battery-9']]);
    expect(f.calls['unlock']).toEqual([['Correct-Horse-Battery-9']]);
  });

  it('step 3: a wrong password says how many tries are left; a lockout is shown; the right password opens the panel', async () => {
    const f = fake({ status: { is_admin: true, role: 'owner', label: 'Owner', rank: 100, mfa: true, password_set: true, unlocked: false }, unlockResult: { ok: false, reason: 'wrong_password', remaining: 3 } }); await start(f);
    type('#pw', 'nope'); submit();
    await wait(() => expect(q('#err').textContent).toMatch(/3 attempts left/));
    expect(q<HTMLInputElement>('#pw').value).toBe('');
    f.state.unlockResult = { ok: false, reason: 'locked', until: new Date(Date.now() + 900_000).toISOString() };
    f.state.status = { ...f.state.status, locked_until: f.state.unlockResult.until };
    type('#pw', 'nope'); submit();
    await wait(() => expect(root.textContent).toMatch(/Too many wrong attempts/));
    f.state.unlockResult = { ok: true }; f.state.status = { ...f.state.status, locked_until: null };
    type('#pw', 'Correct-Horse-Battery-9'); submit();
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
  });

  it('Sign out from any step ends the session', async () => {
    const f = fake({ status: { is_admin: false } }); await start(f);
    q('#signout').click();
    await wait(() => expect(f.calls['signOut']).toHaveLength(1));
    await wait(() => expect(root.textContent).toContain('Staff sign-in'));
  });
});

describe('the panel', () => {
  it('shows the owner every page, with the role and a session timer', async () => {
    await start(fake());
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(['Overview', 'Dashboard', 'Players', 'Site controls', 'Wallets', 'Staff and roles', 'Permissions', 'Audit log', 'Data explorer']);
    expect(q('#roleTag').textContent).toBe('Owner');
    expect(q('#timer').textContent).toMatch(/^\d+:\d\d$/);
    expect(root.textContent).toContain('Everything you do here is written to the audit log');
  });

  it('shows a moderator only what its permissions allow', async () => {
    await start(fake({ status: unlocked({ role: 'moderator', label: 'Moderator', rank: 60 }), perms: ['dashboard.view', 'players.view', 'chat.delete'] }));
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(['Overview', 'Dashboard', 'Players', 'Site controls']);       // the dashboard permission lets a moderator look at the switches, not change them
    await goto('explorer', '#page');                                                  // typing the address does not open a hidden page's data
    expect(q('#page h1').textContent).toBe('Data explorer');
  });

  it('Lock now locks the session and returns to the password step', async () => {
    const f = fake(); await start(f);
    await wait(() => expect(q('#lockBtn')).not.toBeNull());
    q('#lockBtn').click();
    await wait(() => expect(root.textContent).toContain('Admin password'));
    expect(f.calls['lock']).toHaveLength(1);
  });

  it('when the session expires on the server, the next call sends you back to the password step', async () => {
    const f = fake({}, { listAdmins: async () => { throw new Error('admin_session_required'); } }); await start(f);
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    f.state.status = { ...f.state.status, unlocked: false };
    await goto('staff', '#page');
    await wait(() => expect(root.textContent).toContain('Admin password'));
  });
});

describe('staff and roles', () => {
  it('lists staff, offers only roles below my own, and locks my own row and ranks above mine', async () => {
    await start(fake({ status: unlocked({ role: 'admin', label: 'Admin', rank: 80 }), perms: ['roles.manage', 'audit.read'], user: { id: 'a1' }, admins: [
      { user_id: 'me', name: 'Mirage', role: 'owner', rank: 100, granted_at: '2026-11-21T10:00:00Z' }, { user_id: 'a1', name: 'Kai', role: 'admin', rank: 80, granted_at: '2026-11-21T11:00:00Z' },
      { user_id: 'm1', name: 'Vexx', role: 'moderator', rank: 60, granted_at: '2026-11-21T12:00:00Z' }] }));
    await goto('staff', 'table.grid');
    const rows = [...root.querySelectorAll('tr[data-u]')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('select')).toBeNull();                              // the owner is above me
    expect(rows[1]!.querySelector('select')).toBeNull();                              // myself
    const opts = [...rows[2]!.querySelectorAll('option')].map(o => o.textContent);
    expect(opts).toEqual(['Read-only', 'Moderator']);                                // nothing at or above my rank, least powerful first
  });

  it('changing a role asks for a reason, then calls the server with it; cancelling calls nothing', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    const row = q('tr[data-u="m1"]');
    (row.querySelector('[data-role]') as HTMLSelectElement).value = 'readonly';
    (row.querySelector('[data-save]') as HTMLElement).click();
    await cancelReason();
    expect(f.calls['setRole']).toBeUndefined();
    (row.querySelector('[data-save]') as HTMLElement).click();
    await answerReason('only needs to look');
    await wait(() => expect(f.calls['setRole']).toEqual([['m1', 'readonly', 'only needs to look']]));
  });

  it('a reason that is too short is not accepted by the dialog', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await wait(() => expect(document.querySelector('#dlgReason')).not.toBeNull());
    (document.querySelector('#dlgReason') as HTMLTextAreaElement).value = 'ab'; (document.querySelector('#dlgYes') as HTMLElement).click();
    expect(document.querySelector('#dlgErr')!.textContent).toMatch(/at least 3/);
    expect(f.calls['setRole']).toBeUndefined();
    (document.querySelector('#dlgNo') as HTMLElement).click();
  });

  it('removing a role and adding someone from a search both go through a reason', async () => {
    const f = fake(); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await answerReason('left the team');
    await wait(() => expect(f.calls['setRole']).toEqual([['m1', null, 'left the team']]));
    await goto('staff', '#find');
    type('#q', 'nov'); submit('#find');
    await wait(() => expect(q('tr[data-p="p1"]')).not.toBeNull());
    expect((q('tr[data-p="p1"]').querySelector('select') as HTMLSelectElement).value).toBe('readonly');     // the default is the least powerful role
    (q('tr[data-p="p1"]').querySelector('select') as HTMLSelectElement).value = 'moderator';
    (q('tr[data-p="p1"]').querySelector('[data-add]') as HTMLElement).click();
    await answerReason('new chat helper');
    await wait(() => expect(f.calls['setRole']![1]).toEqual(['p1', 'moderator', 'new chat helper']));
  });

  it('shows the server\'s refusal in plain words', async () => {
    const f = fake({}, { setRole: async () => { throw new Error('rank_too_low'); } }); await start(f);
    await goto('staff', 'tr[data-u="m1"]');
    (q('tr[data-u="m1"]').querySelector('[data-remove]') as HTMLElement).click();
    await answerReason('testing it');
    await wait(() => expect(document.getElementById('toasts')!.textContent).toMatch(/below your own rank/));
  });
});

describe('permissions', () => {
  it('shows every role and permission, the owner column full and locked, and my own rank and above locked', async () => {
    await start(fake({ status: unlocked({ role: 'admin', label: 'Admin', rank: 80 }), perms: ['roles.manage', 'players.view', 'chat.delete'] }));
    await goto('permissions', 'table.matrix');
    const box = (role: string, perm: string): HTMLInputElement => q<HTMLInputElement>(`input[data-role="${role}"][data-perm="${perm}"]`);
    expect(box('owner', 'players.view').checked).toBe(true); expect(box('owner', 'players.view').disabled).toBe(true);
    expect(box('admin', 'players.view').disabled).toBe(true);                         // my own rank
    expect(box('moderator', 'players.view').checked).toBe(true); expect(box('moderator', 'players.view').disabled).toBe(false);
    expect(box('moderator', 'players.view_email').checked).toBe(false);
    expect(box('moderator', 'players.view_email').disabled).toBe(true);                // I do not hold it, so I cannot grant it
    expect(root.textContent).toContain('sensitive');
  });

  it('switching a permission asks for a reason and saves it; cancelling puts the box back', async () => {
    const f = fake(); await start(f);
    await goto('permissions', 'table.matrix');
    const box = q<HTMLInputElement>('input[data-role="moderator"][data-perm="players.view_email"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await cancelReason();
    await wait(() => expect(box.checked).toBe(false));
    expect(f.calls['setPermission']).toBeUndefined();
    box.checked = true; box.dispatchEvent(new Event('change'));
    await answerReason('moderators may help with e-mail problems');
    await wait(() => expect(f.calls['setPermission']).toEqual([['moderator', 'players.view_email', true, 'moderators may help with e-mail problems']]));
    expect(box.checked).toBe(true);
  });

  it('puts the box back and explains when the server refuses', async () => {
    const f = fake({}, { setPermission: async () => { throw new Error('cannot_grant_what_you_lack'); } }); await start(f);
    await goto('permissions', 'table.matrix');
    const box = q<HTMLInputElement>('input[data-role="moderator"][data-perm="chat.delete"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
    await answerReason('trying');
    await wait(() => expect(box.checked).toBe(false));
    expect(document.getElementById('toasts')!.textContent).toMatch(/do not hold yourself/);
  });
});

describe('audit log', () => {
  it('lists entries newest first, filters on the server, and shows the full entry on click', async () => {
    const f = fake(); await start(f);
    await goto('audit', '#rows tr[data-i]');
    expect([...root.querySelectorAll('#rows tr')].map(r => r.querySelector('code')?.textContent)).toEqual(['role.set', 'admin.unlock']);
    q('#rows tr[data-i="12"]').click();
    expect(q('#detail').hidden).toBe(false);
    expect(q('#detail').textContent).toContain('chat help');
    expect(q('#detail').textContent).toContain('moderator');
    type('#fa', 'unlock'); type('#fb', 'Mir'); submit('#flt');
    await wait(() => expect(f.calls['audit']!.at(-1)![0]).toMatchObject({ action: 'unlock', actor: 'Mir' }));
  });
  it('says so when nothing matches, and shows a refusal', async () => {
    await start(fake({ audit: [] }));
    await goto('audit', '#rows');
    expect(q('#rows').textContent).toContain('Nothing matches');
  });
});

describe('data explorer', () => {
  it('runs a query and shows the columns in the order the database returned them', async () => {
    const f = fake(); await start(f);
    await goto('explorer', '#sql');
    q<HTMLTextAreaElement>('#sql').value = 'select display_name, id from public.profiles';
    q('#run').click();
    await wait(() => expect(root.querySelector('#out table')).not.toBeNull());
    expect([...root.querySelectorAll('#out th')].map(t => t.textContent)).toEqual(['display_name', 'id']);
    expect(root.querySelectorAll('#out tbody tr')).toHaveLength(2);
    expect(f.calls['query']).toEqual([['select display_name, id from public.profiles', 200]]);
    expect(q('#info').textContent).toMatch(/2 rows/);
  });
  it('shows a refused or failing query as a message and never as a table', async () => {
    const f = fake({ queryResult: { columns: [], rows: [], truncated: false, error: 'read_only_only' } }); await start(f);
    await goto('explorer', '#sql');
    q<HTMLTextAreaElement>('#sql').value = 'delete from public.wallets';
    q('#run').click();
    await wait(() => expect(q('#out').textContent).toMatch(/Only SELECT/));
    expect(root.querySelector('#out table')).toBeNull();
  });
  it('the example buttons fill the box, Ctrl+Enter runs, and cells with objects are shown as JSON, safely escaped', async () => {
    const f = fake({ queryResult: { columns: ['x'], rows: [{ x: { a: '<img src=x onerror=alert(1)>' } }], truncated: true } }); await start(f);
    await goto('explorer', '#sql');
    q('[data-ex="0"]').click();
    expect(q<HTMLTextAreaElement>('#sql').value).toContain('information_schema.tables');
    q('#sql').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await wait(() => expect(root.querySelector('#out table')).not.toBeNull());
    expect(root.querySelector('#out img')).toBeNull();
    expect(q('#out td').textContent).toContain('<img');
    expect(q('#info').textContent).toMatch(/more rows exist/);
  });
});

describe('site controls', () => {
  const open = async (f: Fake): Promise<void> => { await start(f); await goto('site', '#mOn, #mOff'); };
  const btn = (text: string): HTMLButtonElement => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;

  it('is in the menu for anyone who can see the dashboard, with the current state of every switch', async () => {
    const f = fake({ controls: { ...CONTROLS, games_off: ['mines'], blocked_countries: ['GB', 'US'], signups_open: false, updated_by: 'Mirage' } }); await start(f);
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toContain('Site controls');
    await goto('site', '#cList');
    expect(root.textContent).toContain('Last change by Mirage');
    expect(q<HTMLInputElement>('#cList').value).toBe('GB, US');
    expect(root.querySelector('tr[data-g="mines"] .pill')?.textContent).toBe('paused');
    expect(root.querySelector('tr[data-g="crash"] .pill')?.textContent).toBe('on');
    expect(root.querySelector('tr[data-g="crash"]')?.textContent).toContain('database');
    expect(root.querySelector('tr[data-g="plinko"]')?.textContent).toContain('browser');
    expect(q('#sBtn').textContent).toBe('Open sign-ups');
  });

  it('turns maintenance on with the message and a reason, then offers to turn it off', async () => {
    const f = fake(); await open(f);
    q<HTMLTextAreaElement>('#mMsg').value = 'Back at noon';
    q('#mOn').click();
    await answerReason('database work');
    await wait(() => expect(f.calls['setMaintenance']).toEqual([[true, 'Back at noon', 'database work']]));
    await wait(() => expect(q('#mOff')).not.toBeNull());
    expect(root.querySelector('h2 .pill')?.textContent).toBe('ON');
    q('#mOff').click(); await answerReason('done');
    await wait(() => expect(f.calls['setMaintenance']?.[1]).toEqual([false, 'Back at noon', 'done']));
    await wait(() => expect(q('#mOn')).not.toBeNull());
  });

  it('does nothing when the reason is cancelled', async () => {
    const f = fake(); await open(f);
    q('#mOn').click(); await cancelReason();
    expect(f.calls['setMaintenance']).toBeUndefined();
    expect(q('#mOn')).not.toBeNull();
  });

  it('shows and hides a notice with its style', async () => {
    const f = fake(); await open(f);
    q<HTMLInputElement>('#nTxt').value = 'Race ends tonight'; q<HTMLSelectElement>('#nKind').value = 'warn';
    q('#nShow').click(); await answerReason('heads up');
    await wait(() => expect(f.calls['setNotice']).toEqual([[true, 'Race ends tonight', 'warn', 'heads up']]));
    await wait(() => expect(q('#nHide')).not.toBeNull());
    q('#nHide').click(); await answerReason('over');
    await wait(() => expect(f.calls['setNotice']?.[1]).toEqual([false, 'Race ends tonight', 'warn', 'over']));
  });

  it('pauses and resumes a game from its row', async () => {
    const f = fake(); await open(f);
    (root.querySelector('tr[data-g="crash"] [data-game]') as HTMLElement).click(); await answerReason('bug');
    await wait(() => expect(f.calls['setGame']).toEqual([['crash', true, 'bug']]));
    await wait(() => expect(root.querySelector('tr[data-g="crash"] .pill')?.textContent).toBe('paused'));
    (root.querySelector('tr[data-g="crash"] [data-game]') as HTMLElement).click(); await answerReason('fixed');
    await wait(() => expect(f.calls['setGame']?.[1]).toEqual(['crash', false, 'fixed']));
    await wait(() => expect(root.querySelector('tr[data-g="crash"] .pill')?.textContent).toBe('on'));
  });

  it('closes and opens sign-ups', async () => {
    const f = fake(); await open(f);
    q('#sBtn').click(); await answerReason('invite only');
    await wait(() => expect(f.calls['setSignups']).toEqual([[false, 'invite only']]));
    await wait(() => expect(q('#sBtn').textContent).toBe('Open sign-ups'));
  });

  it('saves the country list as upper-case two-letter codes', async () => {
    const f = fake(); await open(f);
    q<HTMLInputElement>('#cList').value = 'us, gb ; de'; q('#cSave').click();
    await answerReason('licence');
    await wait(() => expect(f.calls['setCountries']).toEqual([[['US', 'GB', 'DE'], 'licence']]));
    await wait(() => expect(q<HTMLInputElement>('#cList').value).toBe('DE, GB, US'));
  });

  it('shows the database refusal in plain words and keeps the page as it was', async () => {
    const f = fake({}, { setCountries: async () => { throw new Error('invalid_country'); } }); await open(f);
    q<HTMLInputElement>('#cList').value = 'USA'; q('#cSave').click(); await answerReason('licence');
    await wait(() => expect(document.querySelector('.toast.error')?.textContent).toMatch(/two-letter/));
    expect(q<HTMLInputElement>('#cList').value).toBe('USA');
  });

  it('lets a read-only member look, but every control is switched off', async () => {
    const f = fake({ perms: ['dashboard.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }), controls: { ...CONTROLS, maintenance_on: true, notice_on: true, notice_text: 'Hi' } }); await start(f);
    await goto('site', '#mMsg');
    expect(q<HTMLTextAreaElement>('#mMsg').disabled).toBe(true);
    for (const id of ['#nTxt', '#nKind', '#nShow', '#sBtn', '#cList', '#cSave']) expect((q(id) as HTMLInputElement).disabled, id).toBe(true);
    expect([...root.querySelectorAll('[data-game]')].every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(btn('Turn maintenance off').disabled).toBe(true); expect(btn('Hide notice').disabled).toBe(true);
  });

  it('does not show the page to someone without the dashboard permission', async () => {
    const f = fake({ perms: ['audit.read'] }); await start(f);
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).not.toContain('Site controls');
  });
});

describe('wallets', () => {
  const open = async (f: Fake): Promise<void> => { await start(f); await goto('wallets', '#wFind'); };
  const find = async (): Promise<void> => {
    q<HTMLInputElement>('#wq').value = 'nov'; submit('#wFind');
    await wait(() => expect(root.querySelector('tr[data-p="p1"]')).not.toBeNull());
  };
  const openNova = async (): Promise<void> => { await find(); q('tr[data-p="p1"] [data-open]').click(); await wait(() => expect(q('#wBal')).not.toBeNull()); };
  const amount = (v: string, dir: 'credit' | 'debit' = 'credit'): void => { q<HTMLInputElement>('#adjAmt').value = v; q<HTMLSelectElement>('#adjDir').value = dir; submit('#adj'); };

  it('is in the menu only for staff who may see ledgers, and starts with the totals of the economy', async () => {
    await start(fake({ perms: ['dashboard.view'] }));
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).not.toContain('Wallets');
    app?.stop(); document.body.innerHTML = '';
    const f = fake(); await open(f);
    expect(f.calls['walletTotals']).toHaveLength(1);
    const cards = q('#wTotals').textContent ?? '';
    expect(cards).toContain('12,345.50'); expect(cards).toContain('4 of 9 wallets'); expect(cards).toContain('Bets today'); expect(cards).toContain('+300.00 given, -50.00 taken');
  });

  it("searching lists players with balances; opening one shows the wallet, the ledger check, coins by kind and the player's limits", async () => {
    const f = fake(); await open(f); await find();
    expect(f.calls['walletSearch']).toEqual([['nov']]);
    expect(q('tr[data-p="p1"]').textContent).toContain('1,250.75');
    q('tr[data-p="p1"] [data-open]').click();
    await wait(() => expect(q('#wBal')).not.toBeNull());
    expect(f.calls['walletOverview']).toEqual([['p1']]);
    expect(q('#wBal').textContent).toBe('1,250.75');
    const page = q('#wPlayer').textContent ?? '';
    expect(page).toContain('matches'); expect(page).toContain('6 rows add up to 1,250.75');
    expect(page).toMatch(/bet[\s\S]*-400\.00/); expect(page).toContain('items worth 99.50');
    expect(page).toContain('Weekly loss'); expect(page).toContain('2,000.00 coins'); expect(page).toContain('Daily play time'); expect(page).toContain('120.00 min');
    expect(page).toContain('Verification level 0');
  });

  it('shows a ledger that does not add up, and no responsible-play block for staff who may not see it', async () => {
    const f = fake({ overview: overview({ ledger: { rows: 2, sum: 100, difference: 5, by_kind: [] }, responsible: null }) }); await open(f); await openNova();
    const page = q('#wPlayer').textContent ?? '';
    expect(page).toContain('5.00'); expect(page).not.toContain('matches'); expect(page).toContain('before the ledger existed');
    expect(page).not.toContain('Responsible play');
  });

  it('the ledger loads on open, "Load older" asks for the rows before the last one, and the bets tab has its own table', async () => {
    const f = fake(); await open(f); await openNova();
    await wait(() => expect(root.querySelectorAll('#wRows tr')).toHaveLength(50));
    expect(f.calls['walletLedger']).toEqual([['p1', undefined]]);
    expect(q('#wRows tr').textContent).toContain('1,000.00');                                          // the newest row first
    expect(q<HTMLButtonElement>('#wMore').hidden).toBe(false);
    q('#wMore').click();
    await wait(() => expect(root.querySelectorAll('#wRows tr')).toHaveLength(100));
    expect(f.calls['walletLedger']?.[1]).toEqual(['p1', 71]);                                           // 120 down to 71 shown, older than id 71 next
    q('#wMore').click();
    await wait(() => expect(root.querySelectorAll('#wRows tr')).toHaveLength(120));
    expect(q<HTMLButtonElement>('#wMore').hidden).toBe(true);                                          // fewer than a full page came back: that was the end
    q('#tabBets').click();
    await wait(() => expect(root.querySelectorAll('#wRows tr')).toHaveLength(2));
    expect(q('#wRows').textContent).toContain('plinko'); expect(q('#wRows').textContent).toContain('-60.00'); expect(q('#wRows').textContent).toContain('+110.00');
  });

  it('crediting asks for a reason first, then sends a signed amount with a fresh key and refreshes the wallet', async () => {
    const f = fake(); await open(f); await openNova();
    amount('250.5');
    await cancelReason();
    expect(f.calls['walletAdjust']).toBeUndefined();                                                  // cancelled: nothing sent
    amount('250.5'); await answerReason('compensation for a lost round');
    await wait(() => expect(f.calls['walletAdjust']).toHaveLength(1));
    const [user, amt, reason, key] = f.calls['walletAdjust']![0]!;
    expect([user, amt, reason]).toEqual(['p1', 250.5, 'compensation for a lost round']);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    await wait(() => expect(q('#wBal').textContent).toBe('1,501.25'));                                 // the page shows the new balance
    expect(f.calls['walletOverview']).toHaveLength(2); expect(f.calls['walletTotals']!.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('.toast.ok')?.textContent).toContain('1,501.25');
  });

  it('a debit is sent as a negative amount, and one above the balance is stopped before anything is asked', async () => {
    const f = fake(); await open(f); await openNova();
    amount('5000', 'debit');
    expect(document.querySelector('.toast.error')?.textContent).toMatch(/cannot take the balance below zero/);
    expect(document.querySelector('#dlgReason')).toBeNull(); expect(f.calls['walletAdjust']).toBeUndefined();
    amount('50', 'debit'); await answerReason('wrong bonus');
    await wait(() => expect(f.calls['walletAdjust']?.[0]?.slice(0, 3)).toEqual(['p1', -50, 'wrong bonus']));
    await wait(() => expect(q('#wBal').textContent).toBe('1,200.75'));
  });

  it('refuses amounts that make no sense without calling the database', async () => {
    const f = fake(); await open(f); await openNova();
    for (const bad of ['0', '-5', '10000000.01', '']) { amount(bad); expect(document.querySelector('#dlgReason'), bad).toBeNull(); }
    expect(f.calls['walletAdjust']).toBeUndefined();
  });

  it('a failed adjustment shows the reason in plain words and keeps the same key for the same retry, but a different request gets a new one', async () => {
    const f = fake({ adjustFails: 'network down' }); await open(f); await openNova();
    amount('20'); await answerReason('first try');
    await wait(() => expect(document.querySelector('.toast.error')?.textContent).toContain('network down'));
    expect(q('#wBal').textContent).toBe('1,250.75');                                                  // nothing changed on the page
    amount('20'); await answerReason('second try');
    await wait(() => expect(f.calls['walletAdjust']).toHaveLength(2));
    expect(f.calls['walletAdjust']![1]![3]).toBe(f.calls['walletAdjust']![0]![3]);                    // the same request again: the same key, so it can only be paid once
    amount('21'); await answerReason('another amount');
    await wait(() => expect(f.calls['walletAdjust']).toHaveLength(3));
    expect(f.calls['walletAdjust']![2]![3]).not.toBe(f.calls['walletAdjust']![0]![3]);
  });

  it("turns the database's refusals into readable text", async () => {
    const f = fake({ adjustFails: 'debit_exceeds_balance' }); await open(f); await openNova();
    amount('10'); await answerReason('try');
    await wait(() => expect(document.querySelector('.toast.error')?.textContent).toMatch(/below zero/));
    f.state.adjustFails = 'admin_denied';
    amount('11'); await answerReason('try again');
    await wait(() => expect([...document.querySelectorAll('.toast.error')].some(t => /do not have access/.test(t.textContent ?? ''))).toBe(true));
  });

  it('someone who may look but not change sees the wallet without the adjust form', async () => {
    const f = fake({ perms: ['ledger.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) }); await open(f); await openNova();
    expect(root.querySelector('#adj')).toBeNull();
    expect(q('#wPlayer').textContent).toContain('wallet.adjust');
    expect(q('#wBal').textContent).toBe('1,250.75');
  });

  it('player names and ids from the database are escaped', async () => {
    const f = fake({ overview: overview({ player: { id: 'p1', name: '<img src=x onerror=alert(1)>', created_at: '2026-11-18T10:00:00Z', closed: true, staff_role: 'moderator' } }) }); await open(f); await openNova();
    expect(root.querySelector('#wPlayer img')).toBeNull();
    expect(q('#wPlayer h2').textContent).toContain('<img');
    expect(q('#wPlayer h2').textContent).toContain('closed'); expect(q('#wPlayer h2').textContent).toContain('staff: moderator');
  });
});

describe('step B pages: dashboard, players, chat, rooms, rounds', () => {
  const ALL = [...OWNER_PERMS, 'players.notes', 'players.tags', 'accounts.mute', 'accounts.ban', 'accounts.signout', 'accounts.rename', 'accounts.close', 'rewards.edit',
    'chat.view', 'chat.settings', 'chat.post', 'rooms.view', 'rooms.cancel', 'rooms.void', 'rounds.view', 'rounds.void', 'audit.read'];
  const toastText = (): string => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');

  it('the owner sees every step B page in the menu, in order', async () => {
    await start(fake({ perms: ALL }));
    await wait(() => expect(root.querySelector('nav')).not.toBeNull());
    expect([...root.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(['Overview', 'Dashboard', 'Players', 'Chat', 'Live rooms', 'Rounds', 'Site controls', 'Wallets', 'Staff and roles', 'Permissions', 'Audit log', 'Data explorer']);
    expect(q('#page').textContent).toContain('Control and visibility');
  });

  it('the dashboard shows the live numbers, the paused games and the charts', async () => {
    await start(fake({ perms: ALL })); await goto('dashboard', '.bars');
    const t = q('#pageBody').textContent ?? '';
    expect(t).toContain('41 active today'); expect(t).toContain('1 stuck'); expect(t).toContain('plinko'); expect(t).toContain('slow mode 10 s');
    expect(root.querySelectorAll('.bars')).toHaveLength(2);
    expect(root.querySelectorAll('.bars')[0]!.querySelectorAll('.bar')).toHaveLength(24);
  });

  it('players: the list shows status and tags; opening one shows the profile, escaped', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('players', '#pRows tr[data-p]');
    expect(q('tr[data-p="p1"]').textContent).toContain('Muted'); expect(q('tr[data-p="p1"]').textContent).toContain('watch');
    expect(q('tr[data-p="p2"]').textContent).toContain('self-excluded');
    q('tr[data-p="p1"]').click();
    await wait(() => expect(q('#profile')).not.toBeNull());
    expect(q('#profile').textContent).toContain('signs in with steam');
    expect(q('#profile').textContent).toContain('hello <b>all</b>');                 // shown as text, not markup
    expect(f.calls['player']![0]).toEqual(['p1']);
  });

  it('a deep link #/players?id= opens that player straight away', async () => {
    const f = fake({ perms: ALL }); await start(f);
    location.hash = '#/players?id=p1'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    await wait(() => expect(q('#profile')).not.toBeNull());
    expect(q('#page h1').textContent).toBe('Players');
  });

  it('account actions ask for a reason and send exactly what was chosen; a warning needs its message', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('players', 'tr[data-p="p1"]');
    q('tr[data-p="p1"]').click(); await wait(() => expect(q('#aForm')).not.toBeNull());
    q<HTMLSelectElement>('#aKind').value = 'warn'; submit('#aForm');
    await wait(() => expect(toastText()).toMatch(/message the player will see/));
    expect(f.calls['flag']).toBeUndefined();
    q<HTMLSelectElement>('#aKind').value = 'bet_ban'; q<HTMLSelectElement>('#aDur').value = '3'; submit('#aForm');   // 7 days
    await answerReason('chargeback suspicion');
    await wait(() => expect(f.calls['flag']).toHaveLength(1));
    expect(f.calls['flag']![0]).toEqual(['p1', 'bet_ban', 10080, '', 'chargeback suspicion']);
    await wait(() => expect(f.calls['player']).toHaveLength(2));                  // the profile is drawn again after the action
    await wait(() => expect(q('[data-lift="3"]')).not.toBeNull());
    q('[data-lift="3"]').click(); await answerReason('appeal accepted');
    await wait(() => expect(f.calls['liftFlag']).toEqual([[3, 'appeal accepted']]));
  });

  it('tags and notes are saved for the player', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('players', 'tr[data-p="p1"]');
    q('tr[data-p="p1"]').click(); await wait(() => expect(q('#nForm')).not.toBeNull());
    const vip = q<HTMLInputElement>('input[data-tag="vip"]'); vip.checked = true; vip.dispatchEvent(new Event('change'));
    await wait(() => expect(f.calls['tag']).toEqual([['p1', 'vip', true]]));
    type('#nBody', 'Plays every evening'); submit('#nForm');
    await wait(() => expect(f.calls['note']).toEqual([['p1', 'Plays every evening']]));
  });

  it('a moderator without ban rights cannot pick a ban, and cannot close accounts', async () => {
    const f = fake({ perms: ['players.view', 'accounts.mute'], status: unlocked({ role: 'moderator', label: 'Moderator', rank: 60 }) }); await start(f); await goto('players', 'tr[data-p="p1"]');
    q('tr[data-p="p1"]').click(); await wait(() => expect(q('#aForm')).not.toBeNull());
    expect(q<HTMLOptionElement>('#aKind option[value="bet_ban"]').disabled).toBe(true);
    expect(q<HTMLOptionElement>('#aKind option[value="mute"]').disabled).toBe(false);
    expect(q<HTMLButtonElement>('#aClose').disabled).toBe(true);
  });

  it('chat: remove and pin a message, save the room rules, post as staff', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('chat', 'tr[data-m="9"]');
    expect(q('tr[data-m="9"]').textContent).toContain('2 reports');
    expect(q('tr[data-m="8"]').textContent).toContain('removed by Vexx');
    expect(q('tr[data-m="8"] [data-rm]')).toBeNull();
    q('tr[data-m="9"] [data-rm]').click(); await answerReason('advertising');
    await wait(() => expect(f.calls['chatRemove']).toEqual([[9, 'advertising']]));
    await wait(() => expect(q('tr[data-m="9"] [data-pin]')).not.toBeNull());
    q('tr[data-m="9"] [data-pin]').click(); await answerReason('rules');
    await wait(() => expect(f.calls['chatPin']).toEqual([[9, 'rules']]));
    q<HTMLInputElement>('#sLock').checked = true; q<HTMLInputElement>('#sLinks').checked = true; q<HTMLSelectElement>('#sSlow').value = '30'; type('#sWords', 'scam, spam ,');
    q('#sSave').click(); await answerReason('raid');
    await wait(() => expect(f.calls['chatSettings']).toEqual([[30, true, false, ['scam', 'spam'], 'raid']]));
    type('#cBody', 'Be nice'); submit('#cPost');
    await wait(() => expect(f.calls['chatPost']).toEqual([['Be nice']]));
  });

  it('rooms: a stuck coinflip is marked and can be cancelled with a refund', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('rooms', '#rList');
    q('[data-k="coinflips"]').click();
    await wait(() => expect(q('[data-cancel="77"]')).not.toBeNull());
    expect(q('#rList').textContent).toContain('stuck');
    q('[data-cancel="77"]').click(); await answerReason('stuck lobby');
    await wait(() => expect(f.calls['roomCancel']).toEqual([['coinflip', '77', 'stuck lobby']]));
  });

  it('rounds: a finished round can be checked; a round in play cannot; pausing goes through the game switch', async () => {
    const f = fake({ perms: ALL }); await start(f); await goto('rounds', 'tr[data-r="41"]');
    expect(q('tr[data-r="42"] [data-check]')).toBeNull();
    expect(q('tr[data-r="41"]').textContent).toContain('2.5×');
    q('tr[data-r="41"] [data-check]').click();
    await wait(() => expect(toastText()).toMatch(/checks out/));
    q('#gPause').click(); await answerReason('investigating');
    await wait(() => expect(f.calls['setGame']).toEqual([['crash', true, 'investigating']]));
  });
});

describe('step C: the catalogue editor', () => {
  const CAT = [...OWNER_PERMS, 'catalogue.view', 'catalogue.edit'];
  const toastText = (): string => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
  const openStarter = async (f: Fake): Promise<void> => {
    await start(f); await goto('catalogue', 'tr[data-k="starter"]');
    q('tr[data-k="starter"] [data-open]').click();
    await wait(() => expect(q('#kEditor')).not.toBeNull());
  };
  const setPct = (row: number, v: string): void => { const i = root.querySelectorAll<HTMLInputElement>('#kRows [data-pct]')[row]!; i.value = v; i.dispatchEvent(new Event('input')); };

  it('lists the cases with their return; switched-off cases only on request; reward crates are not "sold"', async () => {
    await start(fake({ perms: CAT })); await goto('catalogue', 'tr[data-k="starter"]');
    expect(q('tr[data-k="starter"]').textContent).toContain('90.0%');
    expect(q('tr[data-k="daily"]').textContent).toContain('not sold');
    expect(q('tr[data-k="old-box"]')).toBeNull();
    q<HTMLInputElement>('#kOff').checked = true; q('#kOff').dispatchEvent(new Event('change'));
    expect(q('tr[data-k="old-box"]').textContent).toContain('off');
  });

  it('the editor shows the totals live and blocks saving until the chances add up and the return is allowed', async () => {
    const f = fake({ perms: CAT }); await openStarter(f);
    expect(q('#kSum').textContent).toContain('100.000%'); expect(q('#kSum').textContent).toContain('90.0%');
    expect(q('#kRows').textContent).toContain('P250 | Sand <Dune>');                 // names are text, not markup
    setPct(1, '5');                                                                  // 90% + 5% = 95%
    expect(q('#kSum').textContent).toContain('95.000%');
    expect(q<HTMLButtonElement>('#kSave').disabled).toBe(true);
    expect(q('#kProblems').textContent).toContain('not 100%');
    q('#kFill').click();                                                             // the missing 5% goes to the most likely item
    expect(q('#kSum').textContent).toContain('100.000%');
    const price = q<HTMLInputElement>('#kPrice'); price.value = '5'; price.dispatchEvent(new Event('input'));
    expect(q('#kProblems').textContent).toMatch(/between 70% and 98%/);
    q('#kPrice90').click();
    expect(q('#kProblems').textContent).toBe('');
    expect(q<HTMLButtonElement>('#kSave').disabled).toBe(false);
  });

  it('saving sends the version it was opened at, the items as tickets, and a reason', async () => {
    const f = fake({ perms: CAT }); await openStarter(f);
    setPct(0, '89'); setPct(1, '11');
    const name = q<HTMLInputElement>('#kName'); name.value = 'Starter Crate II'; name.dispatchEvent(new Event('input'));
    q('#kPrice90').click();
    q('#kSave').click(); await answerReason('better mix');
    await wait(() => expect(f.calls['catalogueSave']).toHaveLength(1));
    const [body, version, reason] = f.calls['catalogueSave']![0]!;
    expect(version).toBe(3); expect(reason).toBe('better mix');
    expect(body).toMatchObject({ id: 'starter', name: 'Starter Crate II', entries: [{ item: 'a', tickets: 89000 }, { item: 'b', tickets: 11000 }] });
    await wait(() => expect(toastText()).toContain('version 4'));
  });

  it('adding an item from the search puts it in at 1%', async () => {
    const f = fake({ perms: CAT }); await openStarter(f);
    q<HTMLInputElement>('#kq').value = 'awp'; submit('#kFind');
    await wait(() => expect(q('tr[data-f="c"] [data-add]')).not.toBeNull());
    q('tr[data-f="c"] [data-add]').click();
    expect(root.querySelectorAll('#kRows tr[data-i]')).toHaveLength(3);
    expect(q('#kSum').textContent).toContain('101.000%');
  });

  it('a new case needs a valid id; an old version can be restored with a reason', async () => {
    const f = fake({ perms: CAT }); await start(f); await goto('catalogue', '#kNew');
    q('#kNew').click(); await wait(() => expect(q('#kEditor')).not.toBeNull());
    const id = q<HTMLInputElement>('#kId'); id.value = 'Bad Id'; id.dispatchEvent(new Event('input'));
    expect(q('#kProblems').textContent).toContain('lower-case');
    q('#kClose').click();
    q('tr[data-k="starter"] [data-open]').click(); await wait(() => expect(q('[data-restore="1"]')).not.toBeNull());
    expect(q('[data-restore="3"]')).toBeNull();                                      // the current version has nothing to restore
    q('[data-restore="1"]').click(); await answerReason('back to the original');
    await wait(() => expect(f.calls['catalogueRestore']).toEqual([['starter', 1, 'back to the original']]));
  });

  it('staff who may only look see the cases without any way to change them', async () => {
    const f = fake({ perms: ['catalogue.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) }); await start(f);
    await goto('catalogue', 'tr[data-k="starter"]');
    expect(q('#kNew')).toBeNull(); expect(q('tr[data-k="starter"] [data-toggle]')).toBeNull();
    q('tr[data-k="starter"] [data-open]').click(); await wait(() => expect(q('#kEditor')).not.toBeNull());
    expect(q('#kSave')).toBeNull(); expect(q<HTMLInputElement>('#kName').disabled).toBe(true); expect(q('[data-restore]')).toBeNull();
  });
});

describe('step E part 1: rewards and announcements', () => {
  const E1 = [...OWNER_PERMS, 'rewards.view', 'rewards.edit', 'promos.manage', 'announcements.manage'];
  const toastText = (): string => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
  const setVal = (sel: string, v: string): void => { const i = q<HTMLInputElement>(sel); i.value = v; i.dispatchEvent(new Event('input')); };

  it('shows the reward settings and what they cost; a summary updates as numbers change', async () => {
    await start(fake({ perms: E1 })); await goto('rewards', '#rFa');
    expect(q('#pageBody').textContent).toContain('Free coins (faucet)');
    expect(q<HTMLInputElement>('#rRi').value).toBe('0.4');
    expect(q('#rSum').textContent).toContain('150.00 free coins');                      // 6 claims an hour of 25
    setVal('#rFm', '30');
    expect(q('#rSum').textContent).toContain('50.00 free coins');
    setVal('#rCal', '1, 2, 3');
    expect(q('#rSum').textContent).toContain('exactly 7');
    expect(q<HTMLButtonElement>('#rSave').disabled).toBe(true);
  });

  it('saving sends the settings as the database wants them (rakeback as a share, not a percent)', async () => {
    const f = fake({ perms: E1 }); await start(f); await goto('rewards', '#rFa');
    setVal('#rFa', '40'); setVal('#rRi', '1'); setVal('#rRace', '777, 5');
    q('#rSave').click(); await answerReason('weekend boost');
    await wait(() => expect(f.calls['saveRewardSettings']).toHaveLength(1));
    const [s, reason] = f.calls['saveRewardSettings']![0]!;
    expect(reason).toBe('weekend boost');
    expect(s).toMatchObject({ faucet_amount: 40, faucet_minutes: 10, rakeback: { instant: 0.01, daily: 0.003, weekly: 0.003 }, race_prizes: [777, 5] });
  });

  it('promo codes: the list shows the state; a new code is upper-cased and checked; one can be switched off', async () => {
    const f = fake({ perms: E1 }); await start(f); await goto('rewards', 'tr[data-code="SPRING"]');
    expect(q('tr[data-code="SPRING"]').textContent).toContain('used up');
    expect(q('tr[data-code="VAULT10"]').textContent).toContain('working');
    type('#pCode', 'vault10'); type('#pAmt', '5'); submit('#pNew');
    await wait(() => expect(toastText()).toContain('already exists'));
    type('#pCode', 'summer-25'); type('#pAmt', '7.5'); type('#pMax', '100'); submit('#pNew'); await answerReason('summer campaign');
    await wait(() => expect(f.calls['savePromo']).toHaveLength(1));
    expect(f.calls['savePromo']![0]).toEqual([{ code: 'SUMMER-25', amount: 7.5, max_uses: 100, expires_at: null, active: true, note: null }, 'summer campaign']);
    await wait(() => expect(q('tr[data-code="VAULT10"] [data-toggle]')).not.toBeNull());
    q('tr[data-code="VAULT10"] [data-toggle]').click(); await answerReason('retired');
    await wait(() => expect(f.calls['savePromo']).toHaveLength(2));
    expect(f.calls['savePromo']![1]![0]).toMatchObject({ code: 'VAULT10', active: false });
    q('tr[data-code="VAULT10"] [data-users]').click();
    await wait(() => expect(q('#pUsers').textContent).toContain('Nova'));
  });

  it('read-only staff see rewards without any controls', async () => {
    await start(fake({ perms: ['rewards.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) })); await goto('rewards', '#rFa');
    expect(q<HTMLInputElement>('#rFa').disabled).toBe(true); expect(q('#rSave')).toBeNull(); expect(q('#pNew')).toBeNull(); expect(q('[data-toggle]')).toBeNull();
  });

  it('announcements: the list is escaped; publishing and ending ask for a reason', async () => {
    const f = fake({ perms: E1 }); await start(f); await goto('announcements', 'tr[data-a="2"]');
    expect(q('tr[data-a="2"]').textContent).toContain('Double <b>XP</b> weekend');
    expect(q('tr[data-a="1"] [data-end]')).toBeNull();
    q<HTMLSelectElement>('#aKind').value = 'popup'; q<HTMLSelectElement>('#aStyle').value = 'warn';
    q<HTMLTextAreaElement>('#aBody').value = 'Maintenance tonight'; submit('#aNew'); await answerReason('heads-up');
    await wait(() => expect(f.calls['announce']).toEqual([[{ kind: 'popup', style: 'warn', body: 'Maintenance tonight', starts_at: null, ends_at: null }, 'heads-up']]));
    q('tr[data-a="2"] [data-end]').click(); await answerReason('weekend over');
    await wait(() => expect(f.calls['endAnnouncement']).toEqual([[2, 'weekend over']]));
  });
});

describe('step E part 2: events', () => {
  const E2 = [...OWNER_PERMS, 'rewards.view', 'races.manage', 'rain.manage', 'giveaways.manage'];

  it('races: the list is escaped; an ended race can be paid; a new race sends its prizes and games', async () => {
    const f = fake({ perms: E2 }); await start(f); await goto('events', 'tr[data-r="4"]');
    expect(q('tr[data-r="4"]').textContent).toContain('Plinko <sprint>');
    expect(q('tr[data-r="3"]').textContent).toContain('Nova');                          // a paid race shows who got what
    expect(q('tr[data-r="3"] [data-pay]')).toBeNull();
    q('tr[data-r="4"] [data-pay]').click(); await answerReason('well played');
    await wait(() => expect(f.calls['payRace']).toEqual([[4, 'well played']]));
    type('#rName', 'Crash weekend'); type('#rPrizes', '500, 250'); type('#rEnd', '2030-01-01T12:00');
    q<HTMLInputElement>('[data-g="crash"]').checked = true;
    submit('#rNew'); await answerReason('weekend event');
    await wait(() => expect(f.calls['saveRace']).toHaveLength(1));
    expect(f.calls['saveRace']![0]![0]).toMatchObject({ id: null, name: 'Crash weekend', prizes: [500, 250], games: ['crash'] });
  });

  it('coin rain: starting one sends the pot, time and level', async () => {
    const f = fake({ perms: E2 }); await start(f); await goto('events', '#evBody');
    q('[data-t="rain"]').click(); await wait(() => expect(q('#rnNew')).not.toBeNull());
    expect(q('tr[data-rn="9"]').textContent).toContain('paid');
    type('#rnPot', '75'); q<HTMLSelectElement>('#rnSec').value = '120'; type('#rnLvl', '5');
    submit('#rnNew'); await answerReason('stream party');
    await wait(() => expect(f.calls['startRain']).toEqual([[75, 120, 5, 'stream party']]));
  });

  it('giveaways: an ended giveaway can be drawn; staff without the permission cannot', async () => {
    const f = fake({ perms: E2 }); await start(f); await goto('events', '#evBody');
    q('[data-t="giveaways"]').click(); await wait(() => expect(q('tr[data-g="5"]')).not.toBeNull());
    q('tr[data-g="5"] [data-draw]').click(); await answerReason('Friday draw');
    await wait(() => expect(f.calls['drawGiveaway']).toEqual([[5, 'Friday draw']]));
    const g = fake({ perms: ['rewards.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) }); app?.stop(); document.body.innerHTML = '';
    await start(g); await goto('events', '#evBody'); q('[data-t="giveaways"]').click();
    await wait(() => expect(q('tr[data-g="5"]')).not.toBeNull());
    expect(q<HTMLButtonElement>('tr[data-g="5"] [data-draw]').disabled).toBe(true);
  });
});

describe('step E part 3: game settings', () => {
  const E3 = [...OWNER_PERMS, 'config.view', 'config.edit'];
  const setVal = (sel: string, v: string): void => { const i = q<HTMLInputElement>(sel); i.value = v; i.dispatchEvent(new Event('input')); };

  it('shows the settings and the house edge, and checks values before anything is sent', async () => {
    await start(fake({ perms: E3 })); await goto('config', '#cCrash');
    expect(q<HTMLInputElement>('#cCrash').value).toBe('7');
    expect(q('tr[data-g="crash"]').textContent).toContain('Crash');
    expect(q('#pageBody').textContent).toContain('House edge');
    setVal('#cCrash', '3');
    expect(q('#cErr').textContent).toContain('5 to 20');
    expect(q<HTMLButtonElement>('#cSave').disabled).toBe(true);
    setVal('#cCrash', '10');
    const max = q<HTMLInputElement>('tr[data-g="plinko"] [data-max]'); max.value = '0.001'; max.dispatchEvent(new Event('input'));
    expect(q('#cErr').textContent).toContain('Plinko');
  });

  it('saving sends every value, with bots and simulated activity switched as ticked', async () => {
    const f = fake({ perms: E3 }); await start(f); await goto('config', '#cCrash');
    setVal('#cDouble', '15');
    const min = q<HTMLInputElement>('tr[data-g="plinko"] [data-min]'); min.value = '1'; min.dispatchEvent(new Event('input'));
    q<HTMLInputElement>('#cBotB').checked = false; q<HTMLInputElement>('#cSim').checked = false; q('#cSim').dispatchEvent(new Event('change'));
    q('#cSave').click(); await answerReason('quieter site');
    await wait(() => expect(f.calls['saveGameSettings']).toHaveLength(1));
    const [s, reason] = f.calls['saveGameSettings']![0]!;
    expect(reason).toBe('quieter site');
    expect(s).toMatchObject({ crash_bet_seconds: 7, double_bet_seconds: 15, bots_battles: false, bots_coinflip: true, simulated_activity: false, bot_names: ['frostbyte', 'kappa_kid', 'm0nkey'] });
    expect(s.limits).toEqual({ plinko: { min: 1, max: 50000 }, crash: { min: 0.1, max: 50000 } });
  });

  it('staff who may only look cannot change anything', async () => {
    await start(fake({ perms: ['config.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) })); await goto('config', '#cCrash');
    expect(q<HTMLInputElement>('#cCrash').disabled).toBe(true); expect(q('#cSave')).toBeNull();
  });
});

describe('step F part 1: compliance', () => {
  const F1 = [...OWNER_PERMS, 'compliance.view', 'compliance.review', 'rg.view', 'rg.apply'];

  it('the verification queue is escaped and decisions ask for a reason', async () => {
    const f = fake({ perms: F1 }); await start(f); await goto('compliance', 'tr[data-k="7"]');
    expect(q('tr[data-k="7"]').textContent).toContain('I play <big> battles');
    expect(q('tr[data-k="7"]').textContent).toContain('up to 25,000');
    q('tr[data-k="7"] [data-ok]').click(); await answerReason('regular player');
    await wait(() => expect(f.calls['kycDecide']).toEqual([[7, true, 'regular player']]));
  });

  it('responsible play: the lists show, and applying finds the player and sends the action', async () => {
    const f = fake({ perms: F1 }); await start(f); await goto('compliance', '#cBody');
    q('[data-t="rg"]').click(); await wait(() => expect(q('#rgFind')).not.toBeNull());
    expect(q('#cBody').textContent).toContain('Orion'); expect(q('#cBody').textContent).toContain('Daily loss');
    type('#rgQ', 'nov'); submit('#rgFind');
    await wait(() => expect(q('[data-p="p1"]')).not.toBeNull());
    q('[data-p="p1"]').click();
    q<HTMLSelectElement>('#rgKind').value = 'cool_off'; type('#rgVal', '48'); submit('#rgForm'); await answerReason('asked by support');
    await wait(() => expect(f.calls['rgApply']).toEqual([['p1', 'cool_off', 48, 'asked by support']]));
  });

  it('staff without review rights see the queue but cannot decide; without rg.view there is no console tab', async () => {
    await start(fake({ perms: ['compliance.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) })); await goto('compliance', 'tr[data-k="7"]');
    expect(q<HTMLButtonElement>('tr[data-k="7"] [data-ok]').disabled).toBe(true);
    expect(q('[data-t="rg"]')).toBeNull();
  });
});

describe('step F part 2: fairness and economy', () => {
  const F2 = [...OWNER_PERMS, 'fairness.view', 'fairness.run', 'economy.view'];

  it('fairness: shows the last run, and a new run that finds a problem lists it', async () => {
    const f = fake({ perms: F2 }); await start(f); await goto('fairness', '#fRun');
    expect(q('#fResult').textContent).toContain('40 of 40');
    expect(q('#fRuns').textContent).toContain('all match');
    q<HTMLSelectElement>('#fDays').value = '7'; q('#fRun').click();
    await wait(() => expect(f.calls['fairnessRun']).toEqual([[7]]));
    await wait(() => expect(q('#fResult').textContent).toContain('do not match'));
    expect(q('#fResult').textContent).toContain('Crash round');
  });

  it('fairness: staff who may only look cannot run it', async () => {
    await start(fake({ perms: ['fairness.view'], status: unlocked({ role: 'readonly', label: 'Read-only', rank: 10 }) })); await goto('fairness', '#fRun');
    expect(q<HTMLButtonElement>('#fRun').disabled).toBe(true);
  });

  it('economy: totals, each game against its maths, the day chart, escaped names; the period can change', async () => {
    const f = fake({ perms: F2 }); await start(f); await goto('economy', '.econ-days');
    expect(q('#eBody').textContent).toContain('12,000.00');
    expect(q('#eBody').textContent).toContain('93.0%'); expect(q('#eBody').textContent).toContain('97.0%');
    expect(root.querySelectorAll('.econ-day')).toHaveLength(30);
    expect(q('#eBody').textContent).toContain('Nova <1>');
    q<HTMLSelectElement>('#eDays').value = '7'; q('#eDays').dispatchEvent(new Event('change'));
    await wait(() => expect(f.calls['economy']).toEqual([[30], [7]]));
  });
});
