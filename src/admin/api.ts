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
};
export const errorText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const code = Object.keys(ADMIN_ERRORS).find(k => m.includes(k));
  return code ? (ADMIN_ERRORS[code] as string) : m;
};
