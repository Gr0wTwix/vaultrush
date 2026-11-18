import { describe, expect, it } from 'vitest';
import {
  TIER_MAX_BET, ageFromDob, declareSourceOfFunds, defaultKyc, recalcTier, requestEmailCode, resolveReview, screenName, submitDob,
  submitDocument, verifyEmailCode,
} from '../src/kyc.js';

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

function basic() {
  const k = defaultKyc();
  const sent = requestEmailCode(k, 'Player@Example.com', T0);
  verifyEmailCode(k, sent.code!, T0 + 1000);
  submitDob(k, '1990-05-20', T0 + 2000);
  return k;
}

describe('age from date of birth', () => {
  it('computes whole years and handles birthdays', () => {
    expect(ageFromDob('2008-06-15', T0)).toBe(18);
    expect(ageFromDob('2008-06-16', T0)).toBe(17);
    expect(ageFromDob('1990-01-01', T0)).toBe(36);
  });
  it('rejects impossible or malformed dates', () => {
    for (const bad of ['', '2000-13-01', '2001-02-30', '20000101', 'yesterday', '3000-01-01']) expect(ageFromDob(bad, T0)).toBeNull();
  });
});

describe('tier 1: email and age', () => {
  it('needs both a verified email and an adult date of birth', () => {
    const k = defaultKyc();
    const sent = requestEmailCode(k, 'a@b.co', T0);
    expect(sent.ok && sent.code).toMatch(/^\d{6}$/);
    expect(recalcTier(k, T0)).toBe(0);
    expect(verifyEmailCode(k, sent.code!, T0 + 1000).ok).toBe(true);
    expect(recalcTier(k, T0)).toBe(0);                        // still no date of birth
    expect(submitDob(k, '1995-01-01', T0).ok).toBe(true);
    expect(k.tier).toBe(1);
  });
  it('rejects bad emails, wrong or expired codes, and minors', () => {
    const k = defaultKyc();
    expect(requestEmailCode(k, 'not-an-email', T0).ok).toBe(false);
    expect(verifyEmailCode(k, '123456', T0).error).toMatch(/Request a code/);
    const sent = requestEmailCode(k, 'a@b.co', T0);
    expect(verifyEmailCode(k, sent.code === '000000' ? '111111' : '000000', T0).ok).toBe(false);
    expect(verifyEmailCode(k, sent.code!, T0 + 11 * 60_000).error).toMatch(/expired/);
    expect(submitDob(k, '2015-01-01', T0)).toEqual({ ok: false, error: 'You must be 18 or older to play.' });
    expect(k.dob).toBe('');
  });
});

describe('tier 2: document check scenarios', () => {
  it('approves a valid document and unlocks the top tier', () => {
    const k = basic();
    expect(submitDocument(k, 'Alex Morgan', 'pass', T0).ok).toBe(true);
    expect(k.docStatus).toBe('approved');
    expect(k.tier).toBe(2);
    expect(TIER_MAX_BET[2]).toBeGreaterThan(TIER_MAX_BET[1]);
  });
  it('requires tier 1 and a full name first', () => {
    expect(submitDocument(defaultKyc(), 'Alex Morgan', 'pass', T0).ok).toBe(false);
    expect(submitDocument(basic(), 'Alex', 'pass', T0).ok).toBe(false);
  });
  it.each([['blurry', 'rejected'], ['expired', 'rejected'], ['minor', 'rejected'], ['mismatch', 'review'], ['sanctions', 'hold']] as const)(
    'scenario %s ends as %s and stays at tier 1', (scenario, status) => {
      const k = basic();
      submitDocument(k, 'Alex Morgan', scenario, T0);
      expect(k.docStatus).toBe(status);
      expect(k.tier).toBe(1);
      expect(k.docReason.length).toBeGreaterThan(5);
    });
  it('lets a manual review approve or reject, but a hold cannot be released by the player', () => {
    const a = basic(); submitDocument(a, 'Alex Morgan', 'mismatch', T0);
    expect(resolveReview(a, true, T0)).toBe(true);
    expect(a.tier).toBe(2);
    const b = basic(); submitDocument(b, 'Alex Morgan', 'mismatch', T0);
    resolveReview(b, false, T0);
    expect(b.docStatus).toBe('rejected');
    const c = basic(); submitDocument(c, 'Alex Morgan', 'sanctions', T0);
    expect(resolveReview(c, true, T0)).toBe(false);
    expect(c.docStatus).toBe('hold');
  });
});

describe('name screening', () => {
  it('flags exact list matches regardless of order or case', () => {
    expect(screenName('Test Sanctioned')).toMatchObject({ status: 'hit', list: 'sanctions' });
    expect(screenName('SANCTIONED, test')).toMatchObject({ status: 'hit' });
    expect(screenName('Test Politician')).toMatchObject({ status: 'hit', list: 'pep' });
  });
  it('flags near matches for review and clears ordinary names', () => {
    expect(screenName('Tesst Sanctioned')).toMatchObject({ status: 'review', list: 'sanctions' });
    expect(screenName('Alex Morgan')).toEqual({ status: 'clear' });
    expect(screenName('')).toEqual({ status: 'clear' });
  });
  it('holds an account whose name hits a list even with a clean document scenario', () => {
    const k = basic();
    submitDocument(k, 'Test Sanctioned', 'pass', T0);
    expect(k.docStatus).toBe('hold');
    const near = basic();
    submitDocument(near, 'Tesst Politicin', 'pass', T0);
    expect(near.docStatus).toBe('review');
  });
});

describe('source of funds', () => {
  it('needs a meaningful description', () => {
    const k = basic();
    expect(declareSourceOfFunds(k, 'salary', T0).ok).toBe(false);
    expect(declareSourceOfFunds(k, 'Monthly salary from my employer', T0).ok).toBe(true);
    expect(k.sofDeclared).toBe(true);
  });
});
