// AML (anti-money-laundering) transaction monitoring for the SANDBOX payout simulator. No money ever moves: a "payout"
// converts demo coins into a log entry. The rules, thresholds and reason codes mirror what a real operator monitors:
//   K01-K03 verification gates, B01 bonus play-through, V01 velocity, S01 structuring, W01 improbable winnings,
//   F01 source of funds. Each rule returns a reason code, a severity and a score; the decision is approve / review / reject.
import type { AlertSeverity, AmlAlert, GameState } from './types.js';

export const REPORTING_THRESHOLD = 100;   // payouts at or above this need full (tier 2) verification
export const SOF_THRESHOLD = 500;         // cumulative approved payouts above this need a source-of-funds declaration
export const VELOCITY_LIMIT = 3;          // payout requests per 24h before review
const HOUR = 3_600_000, DAY = 24 * HOUR;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const BONUS_TYPE = /free coins|rakeback|promo|calendar|coin rain|race prize|bonus/i;
/** Coins the player received without paying for them (free claims, rakeback, promos, rain, prizes). Item rewards are excluded. */
export function bonusCoins(s: GameState): number {
  return round2(s.tx.filter(t => !t.note && t.amount > 0 && BONUS_TYPE.test(t.type)).reduce((a, t) => a + t.amount, 0));
}

export interface Finding { rule: string; level: 'reject' | 'review' | 'info'; severity: AlertSeverity; score: number; text: string }
export interface AmlResult { decision: 'approved' | 'review' | 'rejected'; score: number; findings: Finding[]; reasons: string[] }

/**
 * Win-rate anomaly (W01): z-score of the player's net result against what the house edge predicts.
 * Per-bet standard deviation is modelled as 1.6 x stake, which is conservative for the games here.
 */
export function winZScore(s: GameState): { n: number; z: number } {
  const bets = s.history;
  const n = bets.length;
  if (n === 0) return { n: 0, z: 0 };
  const staked = bets.reduce((a, b) => a + b.amount, 0), paid = bets.reduce((a, b) => a + b.payout, 0);
  const expectedNet = -0.05 * staked;
  const sd = 1.6 * Math.sqrt(bets.reduce((a, b) => a + b.amount * b.amount, 0));
  return { n, z: sd > 0 ? (paid - staked - expectedNet) / sd : 0 };
}

/** Evaluate a payout request without changing anything. */
export function evaluatePayout(s: GameState, amount: number, now: number = Date.now()): AmlResult {
  const f: Finding[] = [];
  const add = (rule: string, level: Finding['level'], severity: AlertSeverity, score: number, text: string): void => { f.push({ rule, level, severity, score, text }); };
  if (!(amount > 0) || !Number.isFinite(amount)) add('P00', 'reject', 'low', 0, 'Enter a valid amount.');
  else if (amount > s.balance + 1e-9) add('P01', 'reject', 'low', 0, 'The amount is more than your balance.');

  const k = s.kyc;
  if (k.docStatus === 'hold') add('K03', 'reject', 'high', 100, 'The account is on a compliance hold (screening match). Payouts are frozen.');
  if (k.tier < 1) add('K01', 'reject', 'medium', 40, 'Verify your email and date of birth before requesting a payout.');
  else if (amount >= REPORTING_THRESHOLD && k.tier < 2) add('K02', 'reject', 'medium', 35, `Payouts of ${REPORTING_THRESHOLD} or more need full identity verification.`);
  if (k.docStatus === 'review') add('K04', 'review', 'medium', 30, 'Your identity check is waiting for a manual review.');

  const bonus = bonusCoins(s);
  if (bonus > 0 && s.stats.wagered < bonus) add('B01', 'reject', 'medium', 30, `Bonus coins must be wagered at least once before payout (wagered ${round2(s.stats.wagered)} of ${bonus}).`);

  const recent = s.aml.payouts.filter(p => now - p.at < DAY);
  if (recent.length >= VELOCITY_LIMIT) add('V01', 'review', 'medium', 25, `${recent.length} payout requests in the last 24 hours.`);

  const lo = REPORTING_THRESHOLD * 0.9;
  const nearThreshold = s.aml.payouts.filter(p => now - p.at < 7 * DAY && p.amount >= lo && p.amount < REPORTING_THRESHOLD).length + (amount >= lo && amount < REPORTING_THRESHOLD ? 1 : 0);
  if (nearThreshold >= 2) add('S01', 'review', 'high', 30, 'Repeated payouts just below the reporting threshold (possible structuring).');

  const { n, z } = winZScore(s);
  if (n >= 30 && z >= 4) add('W01', 'review', 'high', 35, `Winnings are statistically improbable (z = ${z.toFixed(1)} over ${n} bets).`);

  const paidOut = s.aml.payouts.filter(p => p.decision === 'approved').reduce((a, p) => a + p.amount, 0);
  if (paidOut + amount >= SOF_THRESHOLD && !k.sofDeclared) add('F01', 'review', 'medium', 20, `Cumulative payouts reach ${SOF_THRESHOLD}: a source-of-funds declaration is required.`);

  const score = Math.min(100, f.reduce((a, x) => a + x.score, 0));
  const decision = f.some(x => x.level === 'reject') ? 'rejected' : f.some(x => x.level === 'review') ? 'review' : 'approved';
  return { decision, score, findings: f, reasons: f.map(x => `${x.rule}: ${x.text}`) };
}

function raise(s: GameState, rule: string, severity: AlertSeverity, text: string, now: number): AmlAlert | null {
  if (s.aml.alerts.some(a => a.rule === rule && a.status === 'open' && now - a.at < DAY)) return null;   // no duplicate alerts within a day
  const alert: AmlAlert = { id: ++s.aml.seq, rule, severity, text, at: now, status: 'open' };
  s.aml.alerts.unshift(alert); s.aml.alerts.length = Math.min(s.aml.alerts.length, 200);
  return alert;
}

/** Record a payout request: logs it, raises alerts for every non-trivial finding and, if approved, takes the coins. */
export function applyPayout(s: GameState, amount: number, now: number = Date.now()): AmlResult {
  const r = evaluatePayout(s, amount, now);
  if (r.findings.some(x => x.rule === 'P00' || x.rule === 'P01')) return r;      // not even a valid request: nothing to log
  for (const x of r.findings) if (x.severity !== 'low') raise(s, x.rule, x.severity, x.text, now);
  s.aml.payouts.unshift({ id: ++s.aml.seq, amount: round2(amount), at: now, decision: r.decision, reasons: r.reasons, score: r.score });
  s.aml.payouts.length = Math.min(s.aml.payouts.length, 200);
  if (r.decision === 'approved') {
    s.balance = round2(s.balance - amount);
    s.tx.unshift({ id: (s.tx[0]?.id ?? 1000) + 1, type: 'Payout (sandbox)', amount: -round2(amount), note: 'No money moved', at: now });
  }
  return r;
}

/** Account-level monitoring that does not need a payout request (run on a schedule, or from the UI). */
export function scanAccount(s: GameState, now: number = Date.now()): AmlAlert[] {
  const out: AmlAlert[] = [];
  const { n, z } = winZScore(s);
  if (n >= 30 && z >= 4) { const a = raise(s, 'W01', 'high', `Winnings are statistically improbable (z = ${z.toFixed(1)} over ${n} bets).`, now); if (a) out.push(a); }
  const bonus = bonusCoins(s);
  if (bonus >= 100 && s.stats.wagered < bonus * 0.25) { const a = raise(s, 'B02', 'medium', 'Large bonus balance with almost no wagering.', now); if (a) out.push(a); }
  return out;
}

export function clearAlert(s: GameState, id: number): boolean {
  const a = s.aml.alerts.find(x => x.id === id);
  if (!a || a.status === 'cleared') return false;
  a.status = 'cleared'; return true;
}

/** 0-100 account risk from open alerts, held cases and missing verification. */
export function accountRisk(s: GameState): { score: number; band: 'low' | 'medium' | 'high' } {
  const weight: Record<AlertSeverity, number> = { low: 5, medium: 15, high: 30 };
  let score = s.aml.alerts.filter(a => a.status === 'open').reduce((a, x) => a + weight[x.severity], 0);
  if (s.kyc.docStatus === 'hold') score += 50;
  score = Math.min(100, score);
  return { score, band: score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low' };
}

/** Regulator-style case export for the player's own account (a demo of a suspicious-activity report; not a legal filing). */
export function caseReport(s: GameState, now: number = Date.now()): Record<string, unknown> {
  return {
    generatedAt: new Date(now).toISOString(), disclaimer: 'Sandbox report generated by a play-money demo. Not a legal filing.',
    kyc: { tier: s.kyc.tier, docStatus: s.kyc.docStatus, reason: s.kyc.docReason, sourceOfFundsDeclared: s.kyc.sofDeclared },
    risk: accountRisk(s), activity: { bets: s.history.length, wagered: round2(s.stats.wagered), bonusCoins: bonusCoins(s), win: winZScore(s) },
    alerts: s.aml.alerts, payouts: s.aml.payouts,
  };
}
