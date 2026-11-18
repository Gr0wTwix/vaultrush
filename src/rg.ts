// Responsible-gambling controls. Pure functions over the player's state so they can be unit-tested and, later, run on a server.
// Rules follow common regulator practice: limits that tighten apply at once, limits that loosen wait 24h, a reality check
// reports time and money, cool-offs cannot be shortened, and a validated self-assessment (PGSI) is offered.
import { tierMaxBet } from './kyc.js';
import type { GameState, RgDay, RgLimitKey, RgLimits, RgState } from './types.js';

export const HOUR = 3_600_000;
export const DAY_MS = 24 * HOUR;
export const COOLING_MS = DAY_MS;
export const COOL_OFF_OPTIONS = [['24 hours', DAY_MS], ['7 days', 7 * DAY_MS], ['30 days', 30 * DAY_MS]] as const;

export const defaultLimits = (): RgLimits => ({
  lossDaily: null, lossWeekly: null, lossMonthly: null, wagerDaily: null, maxBet: null, timeDailyMin: null, realityMin: 30,
});
export const defaultRg = (): RgState => ({
  ageConfirmedAt: 0, limits: defaultLimits(), pending: [], coolOffUntil: 0, days: {}, timeMs: {},
  lastRealityAt: 0, sessionStart: 0, assessments: [], log: [],
});

export const LIMIT_LABELS: Record<RgLimitKey, string> = {
  lossDaily: 'Daily loss limit', lossWeekly: 'Weekly loss limit', lossMonthly: 'Monthly loss limit',
  wagerDaily: 'Daily wager limit', maxBet: 'Maximum single bet', timeDailyMin: 'Daily play time (minutes)', realityMin: 'Reality check every (minutes)',
};

export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
const emptyDay = (): RgDay => ({ staked: 0, wagered: 0, paid: 0 });
const bucket = (rg: RgState, t: number): RgDay => (rg.days[dayKey(t)] ??= emptyDay());

function log(rg: RgState, text: string, now: number): void { rg.log.unshift({ at: now, text }); rg.log.length = Math.min(rg.log.length, 100); }

function sumDays(rg: RgState, days: number, now: number, pick: (d: RgDay) => number): number {
  let total = 0;
  for (let i = 0; i < days; i++) { const d = rg.days[dayKey(now - i * DAY_MS)]; if (d) total += pick(d); }
  return total;
}
/** Net loss in coins over the last `days` UTC days (settled bets only). Winnings offset losses but never go below zero. */
export const netLoss = (rg: RgState, days: number, now: number = Date.now()): number =>
  Math.max(0, Math.round(sumDays(rg, days, now, d => d.wagered - d.paid) * 100) / 100);
export const stakedToday = (rg: RgState, now: number = Date.now()): number => rg.days[dayKey(now)]?.staked ?? 0;
export const playedTodayMs = (rg: RgState, now: number = Date.now()): number => rg.timeMs[dayKey(now)] ?? 0;

export function confirmAge(rg: RgState, now: number = Date.now()): void { if (!rg.ageConfirmedAt) { rg.ageConfirmedAt = now; log(rg, 'Confirmed 18+', now); } }

// ---- limits --------------------------------------------------------------------------------------------------------
/** Move limits whose 24h cooling-off has passed from "pending" to active. Returns true if anything changed. */
export function applyPending(rg: RgState, now: number = Date.now()): boolean {
  const due = rg.pending.filter(p => p.effectiveAt <= now);
  if (!due.length) return false;
  for (const p of due) { (rg.limits as unknown as Record<string, number | null>)[p.key] = p.value; log(rg, `${LIMIT_LABELS[p.key]} is now ${p.value ?? 'off'}`, now); }
  rg.pending = rg.pending.filter(p => p.effectiveAt > now);
  return true;
}

export type SetLimitResult = { status: 'applied' | 'pending' | 'same' | 'invalid'; effectiveAt?: number };
/** Tightening applies immediately; loosening (a higher value, or removing the limit) waits 24h and can be cancelled. */
export function setLimit(rg: RgState, key: RgLimitKey, value: number | null, now: number = Date.now()): SetLimitResult {
  applyPending(rg, now);
  if (value !== null && (!Number.isFinite(value) || value < 0)) return { status: 'invalid' };
  if (key === 'realityMin' && value === null) return { status: 'invalid' };
  const cur = rg.limits[key];
  rg.pending = rg.pending.filter(p => p.key !== key);                 // a new request replaces an earlier pending one
  if (value === cur) return { status: 'same' };
  const stricter = key === 'realityMin'
    ? value !== null && value > 0 && (cur === 0 || value < (cur as number))
    : value !== null && (cur === null || value < cur);
  if (stricter) { (rg.limits as unknown as Record<string, number | null>)[key] = value; log(rg, `${LIMIT_LABELS[key]} set to ${value}`, now); return { status: 'applied' }; }
  const effectiveAt = now + COOLING_MS;
  rg.pending.push({ key, value, effectiveAt });
  log(rg, `${LIMIT_LABELS[key]} change to ${value ?? 'off'} requested (effective ${new Date(effectiveAt).toISOString()})`, now);
  return { status: 'pending', effectiveAt };
}
export function cancelPending(rg: RgState, key: RgLimitKey): boolean {
  const before = rg.pending.length; rg.pending = rg.pending.filter(p => p.key !== key); return rg.pending.length < before;
}

/** Cool-off: a short, player-chosen break. It can be extended but never shortened. */
export function startCoolOff(rg: RgState, ms: number, now: number = Date.now()): number {
  rg.coolOffUntil = Math.max(rg.coolOffUntil, now + ms);
  log(rg, `Cool-off until ${new Date(rg.coolOffUntil).toISOString()}`, now);
  return rg.coolOffUntil;
}

// ---- the gate every bet passes through -----------------------------------------------------------------------------
export function betBlockReason(s: GameState, amount: number, now: number = Date.now()): string | null {
  const rg = s.rg;
  applyPending(rg, now);
  if (!rg.ageConfirmedAt) return 'Confirm that you are 18 or older to play.';
  if (s.excludedUntil > now) return 'Self-exclusion is active. Betting is paused.';
  if (rg.coolOffUntil > now) return `Cool-off is active until ${new Date(rg.coolOffUntil).toLocaleString()}.`;
  if (s.kyc.docStatus === 'hold') return 'Your account is on a compliance hold. Betting is paused.';
  const L = rg.limits;
  if (L.maxBet !== null && amount > L.maxBet) return `Your maximum bet limit is ${L.maxBet}.`;
  const tierMax = tierMaxBet(s.kyc.tier);
  if (amount > tierMax) return `Bets above ${tierMax} need a higher verification level (Account > Verification).`;
  if (L.wagerDaily !== null && stakedToday(rg, now) + amount > L.wagerDaily) return `This bet would pass your daily wager limit of ${L.wagerDaily}.`;
  if (L.lossDaily !== null && netLoss(rg, 1, now) + amount > L.lossDaily) return `This bet could pass your daily loss limit of ${L.lossDaily}.`;
  if (L.lossWeekly !== null && netLoss(rg, 7, now) + amount > L.lossWeekly) return `This bet could pass your weekly loss limit of ${L.lossWeekly}.`;
  if (L.lossMonthly !== null && netLoss(rg, 30, now) + amount > L.lossMonthly) return `This bet could pass your monthly loss limit of ${L.lossMonthly}.`;
  if (L.timeDailyMin !== null && playedTodayMs(rg, now) >= L.timeDailyMin * 60_000) return `You have used your daily play-time limit of ${L.timeDailyMin} minutes.`;
  return null;
}

// ---- bookkeeping ---------------------------------------------------------------------------------------------------
function prune(rg: RgState, now: number): void {
  const oldest = dayKey(now - 35 * DAY_MS);
  for (const k of Object.keys(rg.days)) if (k < oldest) delete rg.days[k];
  for (const k of Object.keys(rg.timeMs)) if (k < oldest) delete rg.timeMs[k];
}
export function recordStake(rg: RgState, amount: number, now: number = Date.now()): void { bucket(rg, now).staked += amount; prune(rg, now); }
export function recordSettled(rg: RgState, amount: number, payout: number, now: number = Date.now()): void {
  const d = bucket(rg, now); d.wagered += amount; d.paid += payout;
}
/** Adds time the page was actually visible. */
export function addPlayTime(rg: RgState, ms: number, now: number = Date.now()): void { rg.timeMs[dayKey(now)] = (rg.timeMs[dayKey(now)] ?? 0) + ms; }

// ---- reality check -------------------------------------------------------------------------------------------------
export function startSession(rg: RgState, now: number = Date.now()): void { rg.sessionStart = now; rg.lastRealityAt = now; }
export function realityDue(rg: RgState, now: number = Date.now()): boolean {
  const mins = rg.limits.realityMin;
  return mins > 0 && rg.sessionStart > 0 && now - Math.max(rg.lastRealityAt, rg.sessionStart) >= mins * 60_000;
}
export function acknowledgeReality(rg: RgState, now: number = Date.now()): void { rg.lastRealityAt = now; }
export function sessionSummary(s: GameState, now: number = Date.now()): { minutes: number; bets: number; staked: number; paid: number; net: number } {
  const since = s.rg.sessionStart || now;
  const mine = s.history.filter(h => h.at >= since);
  const staked = mine.reduce((a, h) => a + h.amount, 0), paid = mine.reduce((a, h) => a + h.payout, 0);
  return { minutes: Math.floor((now - since) / 60_000), bets: mine.length, staked: Math.round(staked * 100) / 100, paid: Math.round(paid * 100) / 100, net: Math.round((paid - staked) * 100) / 100 };
}

/** One line per day for the last `days` days: what you staked, what came back and how long you played. */
export function activityStatement(s: GameState, days = 7, now: number = Date.now()): { day: string; staked: number; paid: number; net: number; minutes: number }[] {
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = dayKey(now - i * DAY_MS), d = s.rg.days[key] ?? emptyDay();
    out.push({ day: key, staked: Math.round(d.staked * 100) / 100, paid: Math.round(d.paid * 100) / 100, net: Math.round((d.paid - d.wagered) * 100) / 100, minutes: Math.round((s.rg.timeMs[key] ?? 0) / 60_000) });
  }
  return out;
}

// ---- Problem Gambling Severity Index (PGSI), 9 questions scored 0-3 ------------------------------------------------
export const PGSI_QUESTIONS = [
  'Have you bet more than you could really afford to lose?',
  'Have you needed to bet with larger amounts to get the same feeling?',
  'Have you gone back another day to try to win back money you lost?',
  'Have you borrowed money or sold anything to get money to bet?',
  'Have you felt that you might have a problem with betting?',
  'Has betting caused you any health problems, including stress or anxiety?',
  'Have people criticised your betting or told you that you had a problem?',
  'Has your betting caused any financial problems for you or your household?',
  'Have you felt guilty about the way you bet, or what happens when you bet?',
] as const;
export const PGSI_OPTIONS = ['Never', 'Sometimes', 'Most of the time', 'Almost always'] as const;
export type PgsiBand = 'non-problem' | 'low risk' | 'moderate risk' | 'problem gambling';
export function scorePgsi(answers: number[]): { score: number; band: PgsiBand; advice: string } | null {
  if (answers.length !== PGSI_QUESTIONS.length || answers.some(a => !Number.isInteger(a) || a < 0 || a > 3)) return null;
  const score = answers.reduce((a, b) => a + b, 0);
  if (score === 0) return { score, band: 'non-problem', advice: 'Your answers suggest gambling is not causing problems. Keep your limits on and take regular breaks.' };
  if (score <= 2) return { score, band: 'low risk', advice: 'Low risk. Consider setting loss and time limits so that stays true.' };
  if (score <= 7) return { score, band: 'moderate risk', advice: 'Moderate risk. Set limits now, and consider a cool-off. Talking to a support service can help.' };
  return { score, band: 'problem gambling', advice: 'Your answers point to gambling problems. Please use self-exclusion and contact a support service today.' };
}

export const HELP_RESOURCES = [
  { name: 'BeGambleAware (UK)', url: 'https://www.begambleaware.org' },
  { name: 'GamCare (UK)', url: 'https://www.gamcare.org.uk' },
  { name: 'Gamblers Anonymous', url: 'https://www.gamblersanonymous.org' },
  { name: 'National Council on Problem Gambling (US)', url: 'https://www.ncpgambling.org' },
] as const;
