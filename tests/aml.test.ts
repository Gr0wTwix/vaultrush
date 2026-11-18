import { describe, expect, it } from 'vitest';
import { REPORTING_THRESHOLD, SOF_THRESHOLD, accountRisk, applyPayout, bonusCoins, caseReport, clearAlert, evaluatePayout, scanAccount, winZScore } from '../src/aml.js';
import { defaultKyc, requestEmailCode, submitDob, submitDocument, verifyEmailCode } from '../src/kyc.js';
import { newGameState } from '../src/state.js';
import type { GameState } from '../src/types.js';

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);

/** A player with a verified email/age (tier 1), a 1,000-coin balance and enough wagering to have no bonus restriction. */
function verified(tier2 = false): GameState {
  const s = newGameState();
  s.balance = 1000; s.stats.wagered = 5000;
  const code = requestEmailCode(s.kyc, 'p@example.com', T0).code!;
  verifyEmailCode(s.kyc, code, T0);
  submitDob(s.kyc, '1990-01-01', T0);
  if (tier2) submitDocument(s.kyc, 'Alex Morgan', 'pass', T0);
  return s;
}
const rules = (s: GameState, amount: number, now = T0) => evaluatePayout(s, amount, now).findings.map(f => f.rule);

describe('verification gates', () => {
  it('rejects unverified players and large payouts without tier 2', () => {
    const s = newGameState(); s.balance = 1000;
    expect(evaluatePayout(s, 10, T0)).toMatchObject({ decision: 'rejected' });
    expect(rules(s, 10)).toContain('K01');
    const t1 = verified();
    expect(evaluatePayout(t1, REPORTING_THRESHOLD - 1, T0).decision).toBe('approved');
    expect(rules(t1, REPORTING_THRESHOLD)).toContain('K02');
    expect(evaluatePayout(verified(true), REPORTING_THRESHOLD, T0).decision).toBe('approved');
  });
  it('freezes payouts on a compliance hold and queues a pending manual review', () => {
    const h = verified(); h.kyc.docStatus = 'hold';
    expect(rules(h, 5)).toContain('K03');
    expect(evaluatePayout(h, 5, T0)).toMatchObject({ decision: 'rejected', score: 100 });
    const r = verified(); r.kyc.docStatus = 'review';
    expect(evaluatePayout(r, 5, T0).decision).toBe('review');
  });
  it('validates the amount', () => {
    const s = verified();
    for (const bad of [0, -5, NaN, Infinity]) expect(rules(s, bad)).toContain('P00');
    expect(rules(s, 2000)).toContain('P01');
  });
});

describe('bonus play-through (B01)', () => {
  it('counts free coins, rakeback and promos but not items', () => {
    const s = verified();
    s.tx.push({ id: 1, type: 'Free coins', amount: 25, note: '', at: T0 }, { id: 2, type: 'Rakeback (daily)', amount: 5, note: '', at: T0 },
      { id: 3, type: 'Welcome gift', amount: 0.4, note: 'Hornet SMG | Grid Rot', at: T0 }, { id: 4, type: 'Promo code X', amount: 10, note: '', at: T0 });
    expect(bonusCoins(s)).toBe(40);
  });
  it('rejects a payout until the bonus has been wagered once', () => {
    const s = verified(); s.stats.wagered = 20;
    s.tx.push({ id: 1, type: 'Free coins', amount: 25, note: '', at: T0 });
    expect(rules(s, 10)).toContain('B01');
    expect(evaluatePayout(s, 10, T0).decision).toBe('rejected');
    s.stats.wagered = 25;
    expect(rules(s, 10)).not.toContain('B01');
  });
});

describe('velocity and structuring', () => {
  it('sends the 4th payout request in 24 hours to review', () => {
    const s = verified(true);
    for (let i = 0; i < 3; i++) applyPayout(s, 5, T0 + i * 60_000);
    expect(s.aml.payouts).toHaveLength(3);
    const r = evaluatePayout(s, 5, T0 + 4 * 60_000);
    expect(r.findings.map(f => f.rule)).toContain('V01');
    expect(r.decision).toBe('review');
    expect(rules(s, 5, T0 + 25 * 3_600_000)).not.toContain('V01');
  });
  it('flags repeated payouts just under the reporting threshold', () => {
    const s = verified(true);
    applyPayout(s, 95, T0);
    expect(rules(s, 5, T0 + 60_000)).not.toContain('S01');
    expect(rules(s, 96, T0 + 60_000)).toContain('S01');
    expect(evaluatePayout(s, 96, T0 + 60_000).decision).toBe('review');
    expect(rules(s, 50, T0 + 8 * 86_400_000)).not.toContain('S01');
  });
});

describe('improbable winnings (W01)', () => {
  const bets = (n: number, amount: number, multi: number, s: GameState) => {
    for (let i = 0; i < n; i++) s.history.push({ game: 'Crash', amount, multi, payout: amount * multi, at: T0 });
  };
  it('does not flag ordinary results or small samples', () => {
    const s = verified(true);
    bets(60, 10, 0.95, s);
    expect(winZScore(s).z).toBeCloseTo(0, 5);
    const lucky = verified(true); bets(10, 10, 5, lucky);
    expect(rules(lucky, 5)).not.toContain('W01');     // only 10 bets
  });
  it('flags a long, large winning run and sends payouts to review', () => {
    const s = verified(true);
    bets(60, 10, 2, s);                                // doubling the stake 60 times in a row
    const { n, z } = winZScore(s);
    expect(n).toBe(60);
    expect(z).toBeGreaterThan(4);
    expect(rules(s, 5)).toContain('W01');
    expect(scanAccount(s, T0).map(a => a.rule)).toContain('W01');
    expect(scanAccount(s, T0 + 60_000)).toHaveLength(0);      // no duplicate alert within a day
  });
});

describe('source of funds (F01)', () => {
  it('requires a declaration before cumulative payouts reach the threshold', () => {
    const s = verified(true);
    s.balance = 5000;
    s.aml.payouts.push({ id: 1, amount: SOF_THRESHOLD - 50, at: T0 - 10 * 86_400_000, decision: 'approved', reasons: [], score: 0 });
    expect(rules(s, 100)).toContain('F01');
    s.kyc.sofDeclared = true;
    expect(rules(s, 100)).not.toContain('F01');
  });
});

describe('applying payouts, alerts and risk', () => {
  it('takes the coins and logs a transaction only when approved', () => {
    const s = verified(true);
    const ok = applyPayout(s, 40, T0);
    expect(ok.decision).toBe('approved');
    expect(s.balance).toBe(960);
    expect(s.tx[0]).toMatchObject({ type: 'Payout (sandbox)', amount: -40 });
    const bad = newGameState(); bad.balance = 100;
    expect(applyPayout(bad, 10, T0).decision).toBe('rejected');
    expect(bad.balance).toBe(100);
    expect(bad.aml.payouts[0]).toMatchObject({ decision: 'rejected' });
  });
  it('does not log malformed requests', () => {
    const s = verified();
    applyPayout(s, -5, T0); applyPayout(s, 999999, T0);
    expect(s.aml.payouts).toHaveLength(0);
  });
  it('raises alerts for medium and high findings, scores risk and clears alerts', () => {
    const s = newGameState(); s.balance = 100;
    applyPayout(s, 10, T0);                         // K01: not verified
    expect(s.aml.alerts.map(a => a.rule)).toContain('K01');
    expect(accountRisk(s).score).toBeGreaterThan(0);
    const id = s.aml.alerts[0]!.id;
    expect(clearAlert(s, id)).toBe(true);
    expect(clearAlert(s, id)).toBe(false);
    expect(accountRisk(s)).toEqual({ score: 0, band: 'low' });
    const h = newGameState(); h.kyc.docStatus = 'hold';
    expect(accountRisk(h)).toEqual({ score: 50, band: 'medium' });
  });
  it('exports a case report with a disclaimer', () => {
    const s = verified(true); applyPayout(s, 20, T0);
    const r = caseReport(s, T0) as { disclaimer: string; payouts: unknown[]; kyc: { tier: number } };
    expect(r.disclaimer).toMatch(/Not a legal filing/);
    expect(r.payouts).toHaveLength(1);
    expect(r.kyc.tier).toBe(2);
    expect(defaultKyc().tier).toBe(0);
  });
});
