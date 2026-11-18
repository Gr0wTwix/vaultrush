import { describe, expect, it } from 'vitest';
import {
  ALPHA, RngHealth, auditNonces, bitBattery, bitsFromString, blockFrequencyTest, byteTest, chiSquarePValue, erfc, fips1402,
  floatsToBits, frequencyTest, igamc, ksUniformTest, lgamma, longestRunTest, nibbleTest, proportionTest, runsTest, serialCorrelationTest,
} from '../src/rng.js';
import { collectFloats, cryptoFloats, outcomeTests, rngReport } from '../src/rnglab.js';
import type { BetEntry } from '../src/types.js';
import { seededRandom } from './helpers.js';

const floatsFrom = (rng: () => number, n: number) => Array.from({ length: n }, () => rng());

describe('special functions behind the p-values', () => {
  it('match known values', () => {
    expect(erfc(0)).toBeCloseTo(1, 12);
    expect(erfc(1)).toBeCloseTo(0.15729920705028513, 10);
    expect(erfc(-1)).toBeCloseTo(1.8427007929497148, 10);
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(igamc(1, 1)).toBeCloseTo(Math.exp(-1), 10);
    expect(chiSquarePValue(30.1435, 19)).toBeCloseTo(0.05, 3);       // 5% critical value for df = 19
    expect(chiSquarePValue(36.1909, 19)).toBeCloseTo(0.01, 3);
    expect(chiSquarePValue(0, 5)).toBe(1);
  });
});

describe('NIST SP 800-22 worked examples', () => {
  it('frequency test, section 2.1.8 (n = 100)', () => {
    const bits = bitsFromString('1100100100001111110110101010001000100001011010001100001000110100110001001100011001100010100010111000');
    expect(bits).toHaveLength(100);
    expect(frequencyTest(bits).p).toBeCloseTo(0.109599, 5);
  });
  it('block frequency test, section 2.2.8 (n = 10, M = 3)', () => {
    expect(blockFrequencyTest(bitsFromString('0110011010'), 3).p).toBeCloseTo(0.801252, 5);
  });
  it('runs test, section 2.3.8 (n = 10)', () => {
    expect(runsTest(bitsFromString('1001101011')).p).toBeCloseTo(0.147232, 5);
  });
});

describe('the tests can tell good from bad generators', () => {
  const N = 40000;
  it('accepts a good generator on every test', () => {
    const f = floatsFrom(seededRandom(2026), N);
    for (const t of bitBattery(f)) expect(t.p, t.name).toBeGreaterThanOrEqual(ALPHA);
    expect(fips1402(floatsToBits(f)).pass).toBe(true);
  });
  it('rejects a generator biased 52/48 toward ones', () => {
    const rng = seededRandom(5);
    const bits = Array.from({ length: 200000 }, () => (rng() < 0.52 ? 1 : 0));
    expect(frequencyTest(bits).pass).toBe(false);
    expect(frequencyTest(bits).p).toBeLessThan(1e-4);
  });
  it('rejects alternating and run-heavy bit patterns', () => {
    const alt = Array.from({ length: 20000 }, (_, i) => i % 2);
    expect(runsTest(alt).pass).toBe(false);
    const blocks = Array.from({ length: 20000 }, (_, i) => Math.floor(i / 50) % 2);
    expect(runsTest(blocks).pass).toBe(false);
    expect(blockFrequencyTest(blocks).pass).toBe(false);
    expect(fips1402(blocks).pass).toBe(false);
  });
  it('rejects a low-quality linear generator and a monotone ramp', () => {
    let x = 7;
    const lcg = Array.from({ length: N }, () => { x = (x * 5 + 3) % 64; return x / 64; });
    expect(bitBattery(lcg).some(t => !t.pass)).toBe(true);
    const ramp = Array.from({ length: N }, (_, i) => i / N);
    expect(ksUniformTest(ramp).pass).toBe(true);                    // perfectly uniform in distribution...
    expect(serialCorrelationTest(ramp).pass).toBe(false);          // ...but obviously not random
  });
  it('rejects floats concentrated in part of the range', () => {
    const rng = seededRandom(9);
    const skew = Array.from({ length: N }, () => rng() ** 1.15);
    expect(ksUniformTest(skew).pass).toBe(false);
    expect(byteTest(skew).pass).toBe(false);
  });
  it('rejects a stuck generator for the long-run test', () => {
    const stuck = [...Array.from({ length: 6272 }, (_, i) => (i % 100 < 40 ? 1 : 0))];
    expect(longestRunTest(stuck).pass).toBe(false);
    expect(longestRunTest([1, 0, 1]).note).toMatch(/needs at least/);
  });
  it('nibble and proportion tests behave', () => {
    expect(nibbleTest(Array.from({ length: 40000 }, () => 0)).pass).toBe(false);
    expect(proportionTest('fair coin', 5000, 10000, 0.5).pass).toBe(true);
    expect(proportionTest('rigged coin', 5300, 10000, 0.5).pass).toBe(false);
  });
});

describe('runtime health monitor (NIST SP 800-90B)', () => {
  it('has sensible cut-offs', () => {
    const h = new RngHealth();
    expect(h.rctCutoff).toBe(4);
    expect(h.aptCutoff).toBeGreaterThan(8);
    expect(h.aptCutoff).toBeLessThan(20);
  });
  it('stays quiet on a good generator', () => {
    const h = new RngHealth(), rng = seededRandom(77);
    for (let i = 0; i < 200000; i++) h.observe(rng());
    expect(h.ok).toBe(true);
    expect(h.samples).toBe(200000);
  });
  it('raises an alarm when the generator gets stuck', () => {
    const h = new RngHealth(); const alarms: string[] = []; h.onAlarm = r => alarms.push(r);
    for (let i = 0; i < 10; i++) h.observe(0.5);
    expect(h.ok).toBe(false);
    expect(alarms[0]).toMatch(/Repetition count/);
  });
  it('raises an alarm when one value dominates a window', () => {
    const h = new RngHealth(), rng = seededRandom(3);
    for (let i = 0; i < 4000; i++) h.observe(i % 4 === 0 ? 0.3 : rng());     // a quarter of all samples identical, never 4 in a row
    expect(h.failures.some(f => /Adaptive proportion/.test(f))).toBe(true);
  });
  it('can be reset', () => {
    const h = new RngHealth(); for (let i = 0; i < 10; i++) h.observe(0.1);
    h.reset();
    expect(h.ok).toBe(true); expect(h.samples).toBe(0);
  });
});

describe('nonce audit', () => {
  const bet = (nonce: number, hash = 'aaaaaaaabbbb'): BetEntry => ({ id: `${hash}-${nonce}`, game: 'crash', nonce, clientSeed: 'c', serverHash: hash, at: 0, count: 1 });
  it('accepts consecutive nonces within each seed, newest first', () => {
    expect(auditNonces([bet(3), bet(2), bet(1), bet(0), bet(1, 'ccccccccdddd'), bet(0, 'ccccccccdddd')])).toEqual({ ok: true, problems: [], seeds: 2 });
  });
  it('reports duplicated and missing nonces', () => {
    const r = auditNonces([bet(5), bet(4), bet(4), bet(1)]);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/nonce 4 used twice/);
    expect(r.problems.join(' ')).toMatch(/nonces 2-3 missing/);
  });
});

describe('the real game generator', () => {
  it('passes the whole report on a fixed seed (deterministic)', async () => {
    const report = await rngReport({ floats: 30000, seed: 'a3'.repeat(32), history: [] });
    const failed = [...report.tests, ...report.outcomes].filter(t => !t.pass).map(t => `${t.name} p=${t.p.toFixed(5)}`);
    expect(failed).toEqual([]);
    expect(report.fips.pass).toBe(true);
    expect(report.verdict).toBe('pass');
    expect(report.passed).toBe(report.total);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.disclaimer).toMatch(/not a certificate/);
    expect(report.reference.every(t => t.pass || t.p > 1e-4)).toBe(true);
  }, 60_000);

  it('is reproducible: the same seed gives the same stream and the same digest', async () => {
    const a = await collectFloats(2000, 'seed-x'), b = await collectFloats(2000, 'seed-x');
    expect(a).toEqual(b);
    expect(a).toHaveLength(2000);
  });

  it('game outcome mappings are unbiased and the outcome tests detect a biased mapping', async () => {
    const floats = await collectFloats(30000, 'b7'.repeat(32));
    for (const t of outcomeTests(floats)) expect(t.pass, `${t.name} p=${t.p.toFixed(5)}`).toBe(true);
    const biased = floats.map(f => Math.min(0.999999, f * 1.1));        // pushes outcomes toward the top tiles
    expect(outcomeTests(biased).some(t => !t.pass)).toBe(true);
  }, 60_000);

  it('the CSPRNG reference stream also passes', () => {
    for (const t of bitBattery(cryptoFloats(30000))) expect(t.p, t.name).toBeGreaterThan(1e-5);
  });
});
