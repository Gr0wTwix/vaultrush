// Local accounts for the browser-only mode: an email or username plus a password, so the Login button works without a backend.
// Passwords are stored as PBKDF2-SHA256 hashes with a per-account salt. This only stops casual snooping: anyone who can open this
// browser's developer tools can still read or delete the data. Real protection needs the cloud (Supabase) accounts.
// Each account keeps its own game state under its own storage key, so several people can share one browser.
const ACCOUNTS_KEY = 'vaultrush.accounts.v1';
export const ACTIVE_KEY = 'vaultrush.active';
const ITERATIONS = 200_000;
const MAX_FAILS = 5;
const LOCK_MS = 30_000;

export interface LocalAccount { id: string; email: string; username: string; salt: string; hash: string; iterations: number; createdAt: number; fails: number; lockedUntil: number }
export type AuthResult = { ok: true; account: LocalAccount } | { ok: false; error: string };

const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b as ArrayBuffer)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));

export async function hashPassword(password: string, salt: Uint8Array, iterations: number = ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}
/** Compare without stopping at the first difference. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const load = (): LocalAccount[] => { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]') as LocalAccount[]; } catch { return []; } };
const store = (a: LocalAccount[]): void => { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); };
export const listAccounts = (): LocalAccount[] => load();
export const normEmail = (e: string): string => e.trim().toLowerCase();
export const normName = (n: string): string => n.trim().toLowerCase();

export function emailTaken(email: string): boolean { return load().some(a => a.email === normEmail(email)); }
export function usernameTaken(name: string): boolean { return load().some(a => normName(a.username) === normName(name)); }

export async function registerLocal(input: { email: string; username: string; password: string }, now: number = Date.now()): Promise<AuthResult> {
  const accounts = load();
  if (accounts.some(a => a.email === normEmail(input.email))) return { ok: false, error: 'An account with that email already exists.' };
  if (accounts.some(a => normName(a.username) === normName(input.username))) return { ok: false, error: 'That username is already taken.' };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const account: LocalAccount = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), email: normEmail(input.email), username: input.username.trim(), salt: hex(salt),
    hash: await hashPassword(input.password, salt), iterations: ITERATIONS, createdAt: now, fails: 0, lockedUntil: 0,
  };
  store([...accounts, account]);
  return { ok: true, account };
}

/** `identifier` is an email address or a username. After five wrong passwords the account is locked for 30 seconds. */
export async function loginLocal(identifier: string, password: string, now: number = Date.now()): Promise<AuthResult> {
  const id = identifier.trim().toLowerCase(), accounts = load();
  const acc = accounts.find(a => a.email === id || normName(a.username) === id);
  const generic = 'Wrong email, username or password.';
  if (!acc) { await hashPassword(password, new Uint8Array(16)); return { ok: false, error: generic }; }   // similar timing for unknown accounts
  if (acc.lockedUntil > now) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil((acc.lockedUntil - now) / 1000)} seconds.` };
  const ok = safeEqual(await hashPassword(password, fromHex(acc.salt), acc.iterations), acc.hash);
  if (!ok) {
    acc.fails++;
    if (acc.fails >= MAX_FAILS) { acc.fails = 0; acc.lockedUntil = now + LOCK_MS; }
    store(accounts);
    return { ok: false, error: generic };
  }
  acc.fails = 0; acc.lockedUntil = 0; store(accounts);
  return { ok: true, account: acc };
}

// ---- which account is active in this browser ----
export const activeId = (): string => { try { return localStorage.getItem(ACTIVE_KEY) ?? ''; } catch { return ''; } };
export const activeAccount = (): LocalAccount | null => { const id = activeId(); return id ? load().find(a => a.id === id) ?? null : null; };
export const stateKeyFor = (id: string): string => (id ? `vaultrush.state.v1.${id}` : 'vaultrush.state.v1');
export const fairKeyFor = (id: string): string => (id ? `vaultrush.fair.v1.${id}` : 'vaultrush.fair.v1');
export function setActive(id: string): void { if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY); }

/** New accounts start from what the guest session had (balance, items, history), so signing up does not throw progress away. */
export function adoptGuestProgress(id: string): void {
  for (const [from, to] of [[stateKeyFor(''), stateKeyFor(id)], [fairKeyFor(''), fairKeyFor(id)]] as const) {
    const v = localStorage.getItem(from); if (v && !localStorage.getItem(to)) localStorage.setItem(to, v);
  }
}
