// The admin site against a fake API: every sign-in step, the panel for different roles, and the pages (staff, permissions, audit, explorer).
// The rules themselves are tested in admin-db.test.ts; here we check that the screens show the right step and call the right functions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdjustResult, Admin, AdminApi, AuditRow, BetRow, ChatMsg, ChatSettings, Controls, Dashboard, FlipRoom, LedgerRow, Matrix, PlayerProfile, PlayerRow, QueryResult, RoundRow, Status, WalletFound, WalletOverview, WalletTotals } from '../src/admin/api.js';
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
