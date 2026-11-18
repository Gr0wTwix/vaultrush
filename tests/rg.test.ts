import { describe, expect, it } from 'vitest';
import {
  COOLING_MS, DAY_MS, acknowledgeReality, activityStatement, addPlayTime, applyPending, betBlockReason, cancelPending, confirmAge,
  netLoss, realityDue, recordSettled, recordStake, scorePgsi, sessionSummary, setLimit, startCoolOff, startSession, PGSI_QUESTIONS,
} from '../src/rg.js';
import { newGameState } from '../src/state.js';

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);
function player() { const s = newGameState(); confirmAge(s.rg, T0); return s; }

describe('age gate and base blocks', () => {
  it('blocks every bet until 18+ is confirmed', () => {
    const s = newGameState();
    expect(betBlockReason(s, 1, T0)).toMatch(/18/);
    confirmAge(s.rg, T0);
    expect(betBlockReason(s, 1, T0)).toBeNull();
  });
  it('blocks while self-excluded, cooling off, or on a compliance hold', () => {
    const s = player();
    s.excludedUntil = T0 + 1000;
    expect(betBlockReason(s, 1, T0)).toMatch(/Self-exclusion/);
    s.excludedUntil = 0;
    startCoolOff(s.rg, DAY_MS, T0);
    expect(betBlockReason(s, 1, T0)).toMatch(/Cool-off/);
    expect(betBlockReason(s, 1, T0 + DAY_MS + 1)).toBeNull();
    s.kyc.docStatus = 'hold';
    expect(betBlockReason(s, 1, T0 + DAY_MS + 1)).toMatch(/compliance hold/);
  });
  it('a cool-off can be extended but never shortened', () => {
    const s = player();
    const first = startCoolOff(s.rg, 7 * DAY_MS, T0);
    expect(startCoolOff(s.rg, DAY_MS, T0)).toBe(first);
    expect(startCoolOff(s.rg, 30 * DAY_MS, T0)).toBeGreaterThan(first);
  });
});

describe('limits: tightening is instant, loosening waits 24 hours', () => {
  it('applies a new or lower limit at once', () => {
    const s = player();
    expect(setLimit(s.rg, 'lossDaily', 100, T0).status).toBe('applied');
    expect(s.rg.limits.lossDaily).toBe(100);
    expect(setLimit(s.rg, 'lossDaily', 50, T0).status).toBe('applied');
    expect(setLimit(s.rg, 'lossDaily', 50, T0).status).toBe('same');
  });
  it('delays a higher limit or removing a limit, and the old limit stays in force meanwhile', () => {
    const s = player();
    setLimit(s.rg, 'maxBet', 20, T0);
    const up = setLimit(s.rg, 'maxBet', 80, T0);
    expect(up.status).toBe('pending');
    expect(up.effectiveAt).toBe(T0 + COOLING_MS);
    expect(betBlockReason(s, 30, T0 + 1000)).toMatch(/maximum bet limit is 20/);
    expect(setLimit(s.rg, 'maxBet', null, T0 + 2000).status).toBe('pending');   // replaces the earlier request
    expect(s.rg.pending).toHaveLength(1);
    expect(applyPending(s.rg, T0 + COOLING_MS + 5000)).toBe(true);
    expect(s.rg.limits.maxBet).toBeNull();
    expect(betBlockReason(s, 30, T0 + COOLING_MS + 5000)).toBeNull();
  });
  it('lets a pending loosening be cancelled', () => {
    const s = player();
    setLimit(s.rg, 'lossWeekly', 40, T0); setLimit(s.rg, 'lossWeekly', 90, T0);
    expect(cancelPending(s.rg, 'lossWeekly')).toBe(true);
    applyPending(s.rg, T0 + 2 * DAY_MS);
    expect(s.rg.limits.lossWeekly).toBe(40);
  });
  it('treats a longer reality-check interval or turning it off as loosening', () => {
    const s = player();
    expect(s.rg.limits.realityMin).toBe(30);
    expect(setLimit(s.rg, 'realityMin', 15, T0).status).toBe('applied');
    expect(setLimit(s.rg, 'realityMin', 60, T0).status).toBe('pending');
    expect(setLimit(s.rg, 'realityMin', 0, T0).status).toBe('pending');
  });
  it('rejects invalid values', () => {
    const s = player();
    expect(setLimit(s.rg, 'maxBet', -5, T0).status).toBe('invalid');
    expect(setLimit(s.rg, 'maxBet', NaN, T0).status).toBe('invalid');
    expect(setLimit(s.rg, 'realityMin', null, T0).status).toBe('invalid');
  });
});

describe('the bet gate enforces limits', () => {
  it('enforces the maximum single bet and the verification tier cap', () => {
    const s = player();
    setLimit(s.rg, 'maxBet', 10, T0);
    expect(betBlockReason(s, 10, T0)).toBeNull();
    expect(betBlockReason(s, 11, T0)).toMatch(/maximum bet/);
    const t = player();                                     // tier 0 cap is 50 coins
    expect(betBlockReason(t, 50, T0)).toBeNull();
    expect(betBlockReason(t, 51, T0)).toMatch(/verification/);
    t.kyc.tier = 1;
    expect(betBlockReason(t, 51, T0)).toBeNull();
  });
  it('enforces the daily wager limit using stakes placed today', () => {
    const s = player();
    setLimit(s.rg, 'wagerDaily', 30, T0);
    recordStake(s.rg, 25, T0);
    expect(betBlockReason(s, 5, T0)).toBeNull();
    expect(betBlockReason(s, 6, T0)).toMatch(/daily wager limit/);
    expect(betBlockReason(s, 6, T0 + DAY_MS)).toBeNull();     // a new day starts a new budget
  });
  it('enforces daily, weekly and monthly loss limits on settled bets, offset by winnings', () => {
    const s = player();
    setLimit(s.rg, 'lossDaily', 40, T0);
    recordSettled(s.rg, 30, 0, T0);
    expect(netLoss(s.rg, 1, T0)).toBe(30);
    expect(betBlockReason(s, 10, T0)).toBeNull();
    expect(betBlockReason(s, 11, T0)).toMatch(/daily loss limit/);
    recordSettled(s.rg, 10, 30, T0);                          // a 20-coin net win brings the day to a 10-coin loss
    expect(netLoss(s.rg, 1, T0)).toBe(10);
    expect(betBlockReason(s, 30, T0)).toBeNull();
    const w = player();
    setLimit(w.rg, 'lossWeekly', 100, T0); setLimit(w.rg, 'lossMonthly', 200, T0);
    recordSettled(w.rg, 90, 0, T0 - 3 * DAY_MS);
    expect(betBlockReason(w, 11, T0)).toMatch(/weekly loss limit/);
    recordSettled(w.rg, 80, 0, T0 - 20 * DAY_MS);
    expect(netLoss(w.rg, 7, T0)).toBe(90);
    expect(netLoss(w.rg, 30, T0)).toBe(170);
    expect(betBlockReason(w, 1, T0 - 4 * DAY_MS + 3 * DAY_MS)).toBeNull();
  });
  it('enforces the daily play-time limit from visible time', () => {
    const s = player();
    setLimit(s.rg, 'timeDailyMin', 30, T0);
    addPlayTime(s.rg, 29 * 60_000, T0);
    expect(betBlockReason(s, 1, T0)).toBeNull();
    addPlayTime(s.rg, 61_000, T0);
    expect(betBlockReason(s, 1, T0)).toMatch(/play-time limit/);
    expect(betBlockReason(s, 1, T0 + DAY_MS)).toBeNull();
  });
});

describe('reality check and statements', () => {
  it('becomes due after the interval and resets when acknowledged', () => {
    const s = player();
    startSession(s.rg, T0);
    expect(realityDue(s.rg, T0 + 29 * 60_000)).toBe(false);
    expect(realityDue(s.rg, T0 + 30 * 60_000)).toBe(true);
    acknowledgeReality(s.rg, T0 + 31 * 60_000);
    expect(realityDue(s.rg, T0 + 60 * 60_000)).toBe(false);
    expect(realityDue(s.rg, T0 + 61 * 60_000)).toBe(true);
    s.rg.limits.realityMin = 0;
    expect(realityDue(s.rg, T0 + 600 * 60_000)).toBe(false);
  });
  it('summarises the session and the last days of activity', () => {
    const s = player();
    startSession(s.rg, T0);
    s.history.unshift({ game: 'Crash', amount: 10, multi: 0, payout: 0, at: T0 + 60_000 }, { game: 'Mines', amount: 5, multi: 3, payout: 15, at: T0 + 120_000 });
    expect(sessionSummary(s, T0 + 600_000)).toEqual({ minutes: 10, bets: 2, staked: 15, paid: 15, net: 0 });
    recordStake(s.rg, 15, T0); recordSettled(s.rg, 15, 15, T0); addPlayTime(s.rg, 600_000, T0);
    const st = activityStatement(s, 3, T0);
    expect(st[0]).toMatchObject({ staked: 15, paid: 15, net: 0, minutes: 10 });
    expect(st).toHaveLength(3);
  });
});

describe('self-assessment (PGSI)', () => {
  const answers = (n: number) => Array(PGSI_QUESTIONS.length).fill(n) as number[];
  it('scores the four bands', () => {
    expect(scorePgsi(answers(0))).toMatchObject({ score: 0, band: 'non-problem' });
    expect(scorePgsi([1, 1, ...answers(0).slice(2)])).toMatchObject({ score: 2, band: 'low risk' });
    expect(scorePgsi(answers(1))).toMatchObject({ score: 9, band: 'problem gambling' });
    expect(scorePgsi([1, 1, 1, ...answers(0).slice(3)])).toMatchObject({ score: 3, band: 'moderate risk' });
    expect(scorePgsi(answers(3))).toMatchObject({ score: 27, band: 'problem gambling' });
  });
  it('refuses incomplete or out-of-range answers', () => {
    expect(scorePgsi([0, 1])).toBeNull();
    expect(scorePgsi([...answers(0).slice(1), 4])).toBeNull();
    expect(scorePgsi([...answers(0).slice(1), 1.5])).toBeNull();
  });
});
