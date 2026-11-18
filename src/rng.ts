// RNG quality tooling: the statistical tests and runtime health checks an operator runs on a random number generator.
// The tests follow NIST SP 800-22 (frequency, block frequency, runs, longest run), FIPS 140-2 (monobit, poker, runs, long run),
// NIST SP 800-90B section 4.4 (repetition count and adaptive proportion health tests) plus KS, serial-correlation and
// chi-square tests used on game outcomes. This is SELF-ASSESSMENT tooling. It is not a substitute for an accredited
// test laboratory (GLI, iTech Labs, eCOGRA, BMM), which must certify the production generator.
import type { BetEntry } from './types.js';

// ---- special functions (p-values) ----------------------------------------------------------------------------------
const LANCZOS = [57.1562356658629235, -59.5979603554754912, 14.1360979747417471, -0.491913816097620199, 0.339946499848118887e-4, 0.465236289270485756e-4, -0.983744753048795646e-4, 0.158088703224912494e-3, -0.210264441724104883e-3, 0.217439618115212643e-3, -0.164318106536763890e-3, 0.844182239838527433e-4, -0.261908384015814087e-4, 0.368991826595316234e-5];
export function lgamma(x: number): number {
  let y = x; const tmp = x + 5.24218750000000000 - (x + 0.5) * Math.log(x + 5.24218750000000000);
  let ser = 0.999999999999997092;
  for (const c of LANCZOS) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
/** Regularised upper incomplete gamma Q(a, x). */
export function igamc(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {                                          // series for P, then Q = 1 - P
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a)));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;       // Lentz continued fraction for Q
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - lgamma(a)) * h);
}
export const erfc = (x: number): number => (x >= 0 ? igamc(0.5, x * x) : 2 - igamc(0.5, x * x));
export const chiSquarePValue = (chi: number, df: number): number => igamc(df / 2, chi / 2);

export interface TestResult { name: string; stat: number; p: number; pass: boolean; note?: string }
export const ALPHA = 0.001;
const result = (name: string, stat: number, p: number, note?: string): TestResult => ({ name, stat, p, pass: p >= ALPHA, ...(note ? { note } : {}) });

// ---- helpers --------------------------------------------------------------------------------------------------------
/** 32 bits per float (most significant first). */
export function floatsToBits(floats: number[]): number[] {
  const bits: number[] = [];
  for (const f of floats) { const u = Math.floor(f * 4294967296) >>> 0; for (let i = 31; i >= 0; i--) bits.push((u >>> i) & 1); }
  return bits;
}
export const bitsFromString = (s: string): number[] => [...s].map(c => (c === '1' ? 1 : 0));

// ---- NIST SP 800-22 ---------------------------------------------------------------------------------------------------
export function frequencyTest(bits: number[]): TestResult {
  const n = bits.length, s = bits.reduce((a, b) => a + (2 * b - 1), 0), sObs = Math.abs(s) / Math.sqrt(n);
  return result('Frequency (monobit)', sObs, erfc(sObs / Math.SQRT2));
}
export function blockFrequencyTest(bits: number[], M = 128): TestResult {
  const N = Math.floor(bits.length / M); let chi = 0;
  for (let i = 0; i < N; i++) { let ones = 0; for (let j = 0; j < M; j++) ones += bits[i * M + j] as number; chi += (ones / M - 0.5) ** 2; }
  chi *= 4 * M;
  return result(`Block frequency (M=${M})`, chi, igamc(N / 2, chi / 2));
}
export function runsTest(bits: number[]): TestResult {
  const n = bits.length, pi = bits.reduce((a, b) => a + b, 0) / n;
  if (Math.abs(pi - 0.5) >= 2 / Math.sqrt(n)) return result('Runs', 0, 0, 'failed the frequency prerequisite');
  let v = 1; for (let i = 1; i < n; i++) if (bits[i] !== bits[i - 1]) v++;
  const p = erfc(Math.abs(v - 2 * n * pi * (1 - pi)) / (2 * Math.sqrt(2 * n) * pi * (1 - pi)));
  return result('Runs', v, p);
}
/** Longest run of ones in blocks of 128 bits (needs n >= 6272). */
export function longestRunTest(bits: number[]): TestResult {
  const M = 128, N = Math.floor(bits.length / M);
  if (bits.length < 6272) return result('Longest run of ones', 0, 0, 'needs at least 6,272 bits');
  const pi = [0.1174, 0.2430, 0.2493, 0.1752, 0.1027, 0.1124], v = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    let run = 0, best = 0;
    for (let j = 0; j < M; j++) { if (bits[i * M + j] === 1) { run++; if (run > best) best = run; } else run = 0; }
    v[Math.min(5, Math.max(0, best - 4))]!++;
  }
  const chi = v.reduce((a, o, i) => a + (o - N * (pi[i] as number)) ** 2 / (N * (pi[i] as number)), 0);
  return result('Longest run of ones (M=128)', chi, igamc(5 / 2, chi / 2));
}

// ---- FIPS 140-2 on one 20,000-bit sample -------------------------------------------------------------------------------
export function fips1402(bits: number[]): { pass: boolean; checks: { name: string; pass: boolean; value: number }[] } {
  const b = bits.slice(0, 20000);
  if (b.length < 20000) return { pass: false, checks: [{ name: 'needs 20,000 bits', pass: false, value: b.length }] };
  const ones = b.reduce((a, x) => a + x, 0);
  const f = Array(16).fill(0) as number[];
  for (let i = 0; i < 5000; i++) { const k = (b[4 * i] as number) * 8 + (b[4 * i + 1] as number) * 4 + (b[4 * i + 2] as number) * 2 + (b[4 * i + 3] as number); f[k]!++; }
  const poker = (16 / 5000) * f.reduce((a, x) => a + x * x, 0) - 5000;
  const runs: Record<string, number> = {}; let longest = 0, run = 1;
  for (let i = 1; i <= b.length; i++) {
    if (i < b.length && b[i] === b[i - 1]) { run++; continue; }
    const key = `${b[i - 1]}${Math.min(run, 6)}`; runs[key] = (runs[key] ?? 0) + 1; if (run > longest) longest = run; run = 1;
  }
  const bounds: [number, number][] = [[2315, 2685], [1114, 1386], [527, 723], [240, 384], [103, 209], [103, 209]];
  const runsOk = [0, 1].every(bit => bounds.every(([lo, hi], i) => { const c = runs[`${bit}${i + 1}`] ?? 0; return c >= lo && c <= hi; }));
  const checks = [
    { name: 'Monobit (9,725 < ones < 10,275)', pass: ones > 9725 && ones < 10275, value: ones },
    { name: 'Poker (2.16 < X < 46.17)', pass: poker > 2.16 && poker < 46.17, value: Math.round(poker * 100) / 100 },
    { name: 'Runs (every run length within bounds)', pass: runsOk, value: Object.keys(runs).length },
    { name: 'Long run (< 26)', pass: longest < 26, value: longest },
  ];
  return { pass: checks.every(c => c.pass), checks };
}

// ---- tests on floats and outcomes ----------------------------------------------------------------------------------
/** Lag-1 serial correlation of the float stream. */
export function serialCorrelationTest(floats: number[]): TestResult {
  const n = floats.length, mean = floats.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const d = (floats[i] as number) - mean; den += d * d; if (i + 1 < n) num += d * ((floats[i + 1] as number) - mean); }
  const r = den === 0 ? 1 : num / den;
  return result('Serial correlation (lag 1)', r, erfc(Math.abs(r) * Math.sqrt(n) / Math.SQRT2));
}
/** Kolmogorov-Smirnov test against the uniform distribution on [0, 1). */
export function ksUniformTest(floats: number[]): TestResult {
  const x = [...floats].sort((a, b) => a - b), n = x.length; let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, (i + 1) / n - (x[i] as number), (x[i] as number) - i / n);
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  let p = 0; for (let k = 1; k <= 100; k++) { const t = 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda); p += t; if (Math.abs(t) < 1e-12) break; }
  return result('Kolmogorov-Smirnov (uniform)', d, Math.min(1, Math.max(0, p)));
}
/** Chi-square goodness of fit of observed counts against expected probabilities. */
export function chiSquareGof(name: string, observed: number[], probs: number[]): TestResult {
  const n = observed.reduce((a, b) => a + b, 0); let chi = 0;
  observed.forEach((o, i) => { const e = n * (probs[i] as number); chi += (o - e) ** 2 / e; });
  return result(name, chi, chiSquarePValue(chi, observed.length - 1));
}
/** Two-sided z-test that a Bernoulli success rate equals p. */
export function proportionTest(name: string, successes: number, n: number, p: number): TestResult {
  const z = (successes - n * p) / Math.sqrt(n * p * (1 - p));
  return result(name, z, erfc(Math.abs(z) / Math.SQRT2));
}
/** Poker test on 4-bit nibbles, reported as a p-value. */
export function nibbleTest(bits: number[]): TestResult {
  const f = Array(16).fill(0) as number[];
  for (let i = 0; i + 3 < bits.length; i += 4) f[(bits[i] as number) * 8 + (bits[i + 1] as number) * 4 + (bits[i + 2] as number) * 2 + (bits[i + 3] as number)]!++;
  return chiSquareGof('Nibble frequency (poker)', f, Array(16).fill(1 / 16) as number[]);
}
export function byteTest(floats: number[]): TestResult {
  const f = Array(256).fill(0) as number[];
  for (const x of floats) f[Math.floor(x * 256)]!++;
  return chiSquareGof('Byte frequency (256 bins)', f, Array(256).fill(1 / 256) as number[]);
}

/** The core battery on a float stream: bit-level NIST tests plus float-level tests. */
export function bitBattery(floats: number[]): TestResult[] {
  const bits = floatsToBits(floats);
  return [frequencyTest(bits), blockFrequencyTest(bits), runsTest(bits), longestRunTest(bits), nibbleTest(bits), serialCorrelationTest(floats), ksUniformTest(floats), byteTest(floats)];
}

// ---- NIST SP 800-90B runtime health tests --------------------------------------------------------------------------------
/** Smallest cutoff c with P(Binomial(w - 1, p) >= c - 1) <= alpha, as used for the adaptive proportion test. */
export function binomialCutoff(w: number, p: number, alpha: number): number {
  let cdf = 0, logTerm = (w - 1) * Math.log(1 - p);
  for (let k = 0; k <= w - 1; k++) {
    if (k > 0) logTerm += Math.log((w - k) / k) + Math.log(p / (1 - p));
    cdf += Math.exp(logTerm);
    if (1 - cdf <= alpha) return k + 2;
  }
  return w;
}

/**
 * Continuous health monitor: feed it every float the generator produces. The repetition-count test catches a generator that
 * gets stuck; the adaptive-proportion test catches a value that appears far too often. Cut-offs target a 2^-20 false-alarm rate.
 */
export class RngHealth {
  readonly windowSize = 512;
  readonly rctCutoff = 1 + Math.ceil(20 / 8);                                   // alpha = 2^-20, 8 bits of entropy per byte
  readonly aptCutoff = binomialCutoff(this.windowSize, 1 / 256, 2 ** -20);
  samples = 0; failures: string[] = [];
  private last = -1; private run = 0; private ref = -1; private count = 0; private seen = 0;
  onAlarm: ((reason: string) => void) | null = null;
  observe(f: number): void {
    const v = Math.min(255, Math.max(0, Math.floor(f * 256)));
    this.samples++;
    if (v === this.last) { if (++this.run >= this.rctCutoff) this.fail(`Repetition count: value ${v} repeated ${this.run} times`); } else { this.last = v; this.run = 1; }
    if (this.seen === 0) { this.ref = v; this.count = 1; this.seen = 1; }
    else { this.seen++; if (v === this.ref) this.count++; if (this.count >= this.aptCutoff) this.fail(`Adaptive proportion: value ${this.ref} seen ${this.count} times in ${this.windowSize} samples`); if (this.seen >= this.windowSize) this.seen = 0; }
  }
  private fail(reason: string): void { if (this.failures.length < 20) this.failures.push(reason); this.onAlarm?.(reason); this.last = -1; this.run = 0; this.count = 0; this.seen = 0; }
  get ok(): boolean { return this.failures.length === 0; }
  reset(): void { this.samples = 0; this.failures = []; this.last = -1; this.run = 0; this.ref = -1; this.count = 0; this.seen = 0; }
}
export const rngHealth = new RngHealth();

// ---- audit of nonce discipline ----------------------------------------------------------------------------------------------
/** Within each server seed, nonces must be used once each, in order, with no gaps. History is newest first. */
export function auditNonces(history: BetEntry[]): { ok: boolean; problems: string[]; seeds: number } {
  const bySeed = new Map<string, number[]>();
  for (const b of history) { const list = bySeed.get(b.serverHash) ?? []; list.push(b.nonce); bySeed.set(b.serverHash, list); }
  const problems: string[] = [];
  for (const [hash, nonces] of bySeed) {
    const asc = [...nonces].sort((a, b) => a - b);
    for (let i = 1; i < asc.length; i++) {
      if (asc[i] === asc[i - 1]) problems.push(`Seed ${hash.slice(0, 8)}: nonce ${asc[i]} used twice`);
      else if ((asc[i] as number) - (asc[i - 1] as number) > 1) problems.push(`Seed ${hash.slice(0, 8)}: nonces ${(asc[i - 1] as number) + 1}-${(asc[i] as number) - 1} missing`);
    }
  }
  return { ok: problems.length === 0, problems, seeds: bySeed.size };
}
