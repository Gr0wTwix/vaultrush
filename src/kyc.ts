// KYC (know-your-customer) in SANDBOX mode: a vendor-style flow (email, date of birth, document + liveness, name screening)
// with deterministic test scenarios, the way real providers expose sandbox environments. It never accepts real documents.
// To go live, replace `submitDocument` with a call to a licensed vendor and keep the tier/limit logic below.
import type { KycState, KycTier } from './types.js';

/** Highest single bet allowed per verification tier (coins). */
export const TIER_MAX_BET: Record<KycTier, number> = { 0: 1000, 1: 2500, 2: 5000 };
export const tierMaxBet = (tier: KycTier): number => TIER_MAX_BET[tier];
export const TIER_NAMES: Record<KycTier, string> = { 0: 'Unverified', 1: 'Basic (email and age)', 2: 'Full (identity checked)' };

export const SCENARIOS = [
  { id: 'pass', label: 'Valid document: approved' },
  { id: 'blurry', label: 'Unreadable photo: rejected' },
  { id: 'expired', label: 'Expired document: rejected' },
  { id: 'mismatch', label: 'Name does not match: manual review' },
  { id: 'minor', label: 'Applicant under 18: rejected' },
  { id: 'sanctions', label: 'Sanctions list hit: compliance hold' },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]['id'];

export const defaultKyc = (): KycState => ({
  tier: 0, fullName: '', email: '', emailVerifiedAt: 0, dob: '', docStatus: 'none', docReason: '', sandbox: 'pass',
  submittedAt: 0, sofDeclared: false, sofText: '', pendingCode: '', codeAt: 0, log: [],
});

const note = (k: KycState, text: string, now: number): void => { k.log.unshift({ at: now, text }); k.log.length = Math.min(k.log.length, 60); };

/** Whole years between a YYYY-MM-DD date of birth and `now`, or null when the date is not valid. */
export function ageFromDob(dob: string, now: number = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(Date.UTC(y, mo - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d) return null;
  const t = new Date(now);
  let age = t.getUTCFullYear() - y;
  if (t.getUTCMonth() < mo - 1 || (t.getUTCMonth() === mo - 1 && t.getUTCDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Tier 1 needs a verified email and an adult date of birth; tier 2 also needs an approved document. */
export function recalcTier(k: KycState, now: number = Date.now()): KycTier {
  const age = ageFromDob(k.dob, now);
  const basic = k.emailVerifiedAt > 0 && age !== null && age >= 18;
  k.tier = basic && k.docStatus === 'approved' ? 2 : basic ? 1 : 0;
  return k.tier;
}

const randomCode = (): string => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] as number) % 900000);

/** Step 1: "send" a 6-digit code. In the sandbox the code is returned so the UI can show it as a demo inbox. */
export function requestEmailCode(k: KycState, email: string, now: number = Date.now()): { ok: boolean; code?: string; error?: string } {
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) return { ok: false, error: 'Enter a valid email address.' };
  k.email = clean; k.pendingCode = randomCode(); k.codeAt = now; k.emailVerifiedAt = 0;
  note(k, `Verification code sent to ${clean} (sandbox)`, now);
  return { ok: true, code: k.pendingCode };
}

export function verifyEmailCode(k: KycState, code: string, now: number = Date.now()): { ok: boolean; error?: string } {
  if (!k.pendingCode) return { ok: false, error: 'Request a code first.' };
  if (now - k.codeAt > 10 * 60_000) { k.pendingCode = ''; return { ok: false, error: 'That code expired. Request a new one.' }; }
  if (code.trim() !== k.pendingCode) return { ok: false, error: 'That code is not correct.' };
  k.pendingCode = ''; k.emailVerifiedAt = now;
  note(k, 'Email verified', now); recalcTier(k, now);
  return { ok: true };
}

/** Step 2: self-declared date of birth. Under-18s are refused outright. */
export function submitDob(k: KycState, dob: string, now: number = Date.now()): { ok: boolean; error?: string } {
  const age = ageFromDob(dob, now);
  if (age === null) return { ok: false, error: 'Enter a valid date (YYYY-MM-DD).' };
  if (age < 18) { note(k, 'Date of birth rejected: under 18', now); return { ok: false, error: 'You must be 18 or older to play.' }; }
  k.dob = dob; note(k, `Date of birth accepted (age ${age})`, now); recalcTier(k, now);
  return { ok: true };
}

// ---- name screening against (mock) sanctions and PEP lists -------------------------------------------------------
export const SANCTIONS_LIST = ['test sanctioned', 'ivan embargoed', 'jane doe listed'];
export const PEP_LIST = ['test politician', 'maria exposed'];

const norm = (s: string): string[] => s.toLowerCase().normalize('NFKD').replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
function lev(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] as number;
}

export interface Screening { status: 'clear' | 'review' | 'hit'; list?: 'sanctions' | 'pep'; entry?: string }
/** Exact token match = hit; every token within one typo = possible match (review); anything else = clear. */
export function screenName(fullName: string): Screening {
  const tokens = norm(fullName);
  if (tokens.length === 0) return { status: 'clear' };
  let best: Screening = { status: 'clear' };
  for (const [list, entries] of [['sanctions', SANCTIONS_LIST], ['pep', PEP_LIST]] as const) {
    for (const entry of entries) {
      const parts = norm(entry);
      if (parts.every(p => tokens.includes(p))) return { status: 'hit', list, entry };
      if (parts.every(p => tokens.some(t => lev(t, p) <= 1)) && best.status === 'clear') best = { status: 'review', list, entry };
    }
  }
  return best;
}

/** Step 3: document + liveness check. `scenario` selects the sandbox outcome; no file is ever read or stored. */
export function submitDocument(k: KycState, fullName: string, scenario: ScenarioId, now: number = Date.now()): { ok: boolean; error?: string } {
  if (k.tier < 1) return { ok: false, error: 'Verify your email and date of birth first.' };
  if (fullName.trim().split(/\s+/).length < 2) return { ok: false, error: 'Enter your full name (first and last).' };
  k.fullName = fullName.trim(); k.sandbox = scenario; k.submittedAt = now;
  const screening = screenName(k.fullName);
  if (screening.status === 'hit') {
    k.docStatus = 'hold'; k.docReason = `Name matches the ${screening.list} list (${screening.entry}). Held for compliance review.`;
  } else if (scenario === 'sanctions') {
    k.docStatus = 'hold'; k.docReason = 'Sanctions list hit reported by the (sandbox) screening provider. Held for compliance review.';
  } else if (scenario === 'blurry') { k.docStatus = 'rejected'; k.docReason = 'The document photo is unreadable. Retake it in good light.';
  } else if (scenario === 'expired') { k.docStatus = 'rejected'; k.docReason = 'The document has expired.';
  } else if (scenario === 'minor') { k.docStatus = 'rejected'; k.docReason = 'The document shows the applicant is under 18.';
  } else if (scenario === 'mismatch' || screening.status === 'review') {
    k.docStatus = 'review'; k.docReason = screening.status === 'review' ? `Possible partial match on the ${screening.list} list. Needs a manual review.` : 'The name on the document differs from the account details. Needs a manual review.';
  } else { k.docStatus = 'approved'; k.docReason = ''; }
  note(k, `Document check (${scenario}): ${k.docStatus}${k.docReason ? ' - ' + k.docReason : ''}`, now);
  recalcTier(k, now);
  return { ok: true };
}

/** Sandbox stand-in for a human compliance reviewer resolving a "review" case. Holds cannot be released here. */
export function resolveReview(k: KycState, approve: boolean, now: number = Date.now()): boolean {
  if (k.docStatus !== 'review') return false;
  k.docStatus = approve ? 'approved' : 'rejected';
  k.docReason = approve ? '' : 'Manual review: documents could not be confirmed.';
  note(k, `Manual review ${approve ? 'approved' : 'rejected'} the case`, now);
  recalcTier(k, now);
  return true;
}

/** Source-of-funds declaration, needed once cumulative payouts pass the AML threshold. */
export function declareSourceOfFunds(k: KycState, text: string, now: number = Date.now()): { ok: boolean; error?: string } {
  if (text.trim().length < 20) return { ok: false, error: 'Describe where the money comes from (at least 20 characters).' };
  k.sofDeclared = true; k.sofText = text.trim(); note(k, 'Source-of-funds declaration recorded', now);
  return { ok: true };
}
