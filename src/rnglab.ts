// RNG lab: collects numbers from the REAL generator used by the games (HMAC-SHA256 stream) and runs the test battery on them,
// the game outcome mappings, the FIPS 140-2 checks and a CSPRNG reference run. The report is self-assessed and says so.
import { crashPoint, doubleRoll, floatsFor, minePositions, plinkoPath, randHex, sha256 } from './fair.js';
import {
  type TestResult, auditNonces, bitBattery, chiSquareGof, floatsToBits, fips1402, proportionTest, rngHealth,
} from './rng.js';
import type { BetEntry } from './types.js';

export const DISCLAIMER = 'Self-assessed report from the Vaultrush RNG lab. It is not a certificate. Real-money operation requires certification of the production generator by an accredited test laboratory (for example GLI, iTech Labs, eCOGRA or BMM) and approval by the regulator.';

/** `n` floats from the same construction the games use, for a throw-away seed. */
export async function collectFloats(n: number, seed: string = randHex(32), client = 'rng-lab'): Promise<number[]> {
  const out: number[] = [];
  for (let nonce = 0; out.length < n; nonce++) out.push(...(await floatsFor(seed, client, nonce, Math.min(400, n - out.length))));
  return out;
}
/** Reference stream straight from the platform CSPRNG. */
export function cryptoFloats(n: number): number[] {
  const out: number[] = [];
  const buf = new Uint32Array(16384);                    // getRandomValues refuses more than 65,536 bytes per call
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) out.push((buf[i] as number) / 4294967296);
  }
  return out;
}

/** Each game's outcome mapping must be unbiased: tests run on the outcomes, not only on the raw floats. */
export function outcomeTests(floats: number[]): TestResult[] {
  const out: TestResult[] = [];
  const tiles = Array(15).fill(0) as number[];
  for (const f of floats) tiles[doubleRoll(f)]!++;
  out.push(chiSquareGof('Double: 15 tiles equally likely', tiles, Array(15).fill(1 / 15) as number[]));

  const rows = 8, buckets = Array(rows + 1).fill(0) as number[];
  for (let i = 0; i + rows <= floats.length; i += rows) buckets[plinkoPath(floats.slice(i, i + rows), rows).reduce((a, b) => a + b, 0)]!++;
  const binom = Array.from({ length: rows + 1 }, (_, k) => { let c = 1; for (let i = 1; i <= k; i++) c = (c * (rows - k + i)) / i; return c / 2 ** rows; });
  out.push(chiSquareGof('Plinko (8 rows): buckets follow the binomial', buckets, binom));

  const deciles = Array(10).fill(0) as number[];
  for (const f of floats) deciles[Math.floor(Math.floor(f * 100000) / 10000)]!++;
  out.push(chiSquareGof('Cases: ticket deciles equally likely', deciles, Array(10).fill(0.1) as number[]));

  const N = 25, mines = 5, perTile = Array(N).fill(0) as number[];
  let runs = 0;
  for (let i = 0; i + (N - 1) <= floats.length; i += N - 1) { runs++; for (const p of minePositions(floats.slice(i, i + N - 1), mines, N)) perTile[p]!++; }
  out.push(chiSquareGof('Mines (5x5, 5 mines): every tile equally likely', perTile, Array(N).fill(1 / N) as number[]));

  const n = floats.length;
  for (const m of [2, 10]) out.push(proportionTest(`Crash: P(crash point >= ${m}x) = 97% / ${m}`, floats.filter(f => crashPoint(f) >= m).length, n, 0.97 / m));
  out.push(proportionTest('Coinflip: Bolt and Star equally likely', floats.filter(f => f < 0.5).length, n, 0.5));
  void runs;
  return out;
}

export interface RngReport {
  generatedAt: string; source: string; floats: number; bits: number;
  tests: TestResult[]; outcomes: TestResult[]; reference: TestResult[];
  fips: ReturnType<typeof fips1402>;
  health: { samples: number; ok: boolean; failures: string[] };
  nonces: { ok: boolean; problems: string[]; seeds: number };
  passed: number; total: number; verdict: 'pass' | 'attention'; digest: string; disclaimer: string;
}

export async function rngReport(opts: { floats?: number; seed?: string; history?: BetEntry[] } = {}): Promise<RngReport> {
  const n = opts.floats ?? 30000;
  const floats = await collectFloats(n, opts.seed);
  const tests = bitBattery(floats), outcomes = outcomeTests(floats), reference = bitBattery(cryptoFloats(n));
  const fips = fips1402(floatsToBits(floats));
  const all = [...tests, ...outcomes];
  const passed = all.filter(t => t.pass).length + (fips.pass ? 1 : 0);
  const total = all.length + 1;
  const body = { tests, outcomes, fips, reference, n };
  const digest = await sha256(JSON.stringify(body));
  return {
    generatedAt: new Date().toISOString(), source: 'HMAC-SHA256(serverSeed, clientSeed:nonce:round), 4 bytes per float', floats: n, bits: n * 32,
    tests, outcomes, reference, fips, health: { samples: rngHealth.samples, ok: rngHealth.ok, failures: [...rngHealth.failures] },
    nonces: auditNonces(opts.history ?? []), passed, total, verdict: passed === total ? 'pass' : 'attention', digest, disclaimer: DISCLAIMER,
  };
}
