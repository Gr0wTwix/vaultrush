// Sign-up rules shared by the register form (instant feedback) and the tests. The server re-checks age, terms and the name
// itself (complete_signup in supabase/migrations), so nothing here is a security boundary: it only makes errors friendly.
import { BOTS } from './data.js';
import { ageFromDob } from './kyc.js';

export const TERMS_VERSION = '2026-11-18';
export const USERNAME_RE = /^[A-Za-z0-9_ -]{2,20}$/;
const RESERVED = ['admin', 'administrator', 'support', 'moderator', 'mod', 'staff', 'vaultrush', 'system', 'root', 'you', 'bot'];
const COMMON_PASSWORDS = ['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'iloveyou123', 'letmein123',
  'welcome123', 'admin12345', 'abc1234567', 'football123', 'baseball123', 'monkey12345', 'dragon12345', 'passw0rd123', '0123456789', '9876543210', 'vaultrush'];

export type Field = 'username' | 'email' | 'password' | 'dob' | 'terms' | 'age' | 'region';
export type Errors = Partial<Record<Field, string>>;

export function validateUsername(name: string, taken: readonly string[] = BOTS): string | null {
  const n = name.trim();
  if (!USERNAME_RE.test(n)) return 'Use 2 to 20 letters, numbers, spaces, _ or -.';
  const lower = n.toLowerCase();
  if (RESERVED.includes(lower) || lower.startsWith('deleted-') || lower.startsWith('player-')) return 'That name is reserved.';
  if (taken.some(t => t.toLowerCase() === lower)) return 'That name belongs to another player.';
  return null;
}
export function validateEmail(email: string): string | null {
  const e = email.trim();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'Enter a valid email address.';
  return null;
}

/** 0 (unacceptable) to 4 (strong). Length matters most; common passwords and repeated patterns are rejected outright. */
export function passwordStrength(pw: string): number {
  if (pw.length < 10) return pw.length === 0 ? 0 : 1;
  if (COMMON_PASSWORDS.includes(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 1;
  let score = 2;
  if (pw.length >= 14) score++;
  if (pw.length >= 18 || [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length >= 3) score++;
  return Math.min(4, score);
}
export function validatePassword(pw: string, ctx: { username?: string; email?: string } = {}): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (new TextEncoder().encode(pw).length > 72) return 'Use at most 72 characters.';
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS.includes(low) || /^(.)\1+$/.test(pw) || '0123456789'.includes(low) || 'abcdefghijklmnopqrstuvwxyz'.includes(low)) return 'That password is too common or too simple.';
  const user = ctx.username?.trim().toLowerCase(), local = ctx.email?.split('@')[0]?.toLowerCase();
  if (user && user.length >= 3 && low.includes(user)) return 'Your password should not contain your username.';
  if (local && local.length >= 4 && low.includes(local)) return 'Your password should not contain your email.';
  return null;
}
export function validateDob(dob: string, now: number = Date.now()): string | null {
  const age = ageFromDob(dob, now);
  if (age === null) return 'Enter your date of birth.';
  if (age < 18) return 'You must be 18 or older to play.';
  if (age > 120) return 'Enter a valid date of birth.';
  return null;
}

export interface RegistrationInput { username: string; email?: string; password?: string; dob: string; terms: boolean; adult: boolean; region: boolean }
/** `cloud` registrations need an email and password; local profiles do not. */
export function validateRegistration(i: RegistrationInput, cloud: boolean, now: number = Date.now()): { ok: boolean; errors: Errors } {
  const errors: Errors = {};
  const u = validateUsername(i.username); if (u) errors.username = u;
  if (cloud) {
    const e = validateEmail(i.email ?? ''); if (e) errors.email = e;
    const p = validatePassword(i.password ?? '', { username: i.username, email: i.email }); if (p) errors.password = p;
  }
  const d = validateDob(i.dob, now); if (d) errors.dob = d;
  if (!i.adult) errors.age = 'Confirm that you are 18 or older.';
  if (!i.region) errors.region = 'Confirm that online gambling content is allowed where you live.';
  if (!i.terms) errors.terms = 'Accept the Terms of Service and Privacy Policy.';
  return { ok: Object.keys(errors).length === 0, errors };
}
