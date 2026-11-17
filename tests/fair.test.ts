import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HOUSE, DOUBLE_PAY, DOUBLE_TILES, UPGRADE_MAX, crashPoint, doubleColor, doubleRoll, doubleWins, floatsFor, minePositions,
  minesMultiplier, pickWeighted, plinkoPath, plinkoTable, sha256, upgradeChance,
} from '../src/fair.js';
import type { DoubleLane, Risk } from '../src/types.js';
import { seededRandom } from './helpers.js';

/** The standalone verifier shown on the Fairness page, written independently with Node's crypto. */
function referenceFloats(serverSeed: string, clientSeed: string, nonce: number, count: number): number[] {
  const out: number[] = [];
  for (let round = 0; out.length < count; round++) {
    const h = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${round}`).digest('hex');
    for (let i = 0; i + 8 <= 64 && out.length < count; i += 8) out.push(parseInt(h.slice(i, i + 8), 16) / 2 ** 32);
  }
  return out;
}

describe('hashing and the random stream', () => {
  it('sha256 matches the standard test vectors', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256('')).toBe(createHash('sha256').update('').digest('hex'));
  });

  it('floatsFor equals an independent HMAC-SHA256 implementation', async () => {
    const cases: [string, string, number, number][] = [['server-seed', 'client', 0, 1], ['a'.repeat(64), 'x:y', 7, 8], ['s', 'c', 123456, 20]];
    for (const [seed, client, nonce, n] of cases) {
      expect(await floatsFor(seed, client, nonce, n)).toEqual(referenceFloats(seed, client, nonce, n));
    }
  });

  it('returns floats in [0, 1) and is deterministic, with a different stream per nonce and seed', async () => {
    const a = await floatsFor('seed', 'client', 1, 40);
    expect(a).toHaveLength(40);
    expect(a.every(f => f >= 0 && f < 1)).toBe(true);
    expect(await floatsFor('seed', 'client', 1, 40)).toEqual(a);
    expect(await floatsFor('seed', 'client', 2, 40)).not.toEqual(a);
    expect(await floatsFor('other', 'client', 1, 40)).not.toEqual(a);
  });

  it('is roughly uniform (20 bins, chi-square below the 1% critical value)', async () => {
    const f = (await Promise.all(Array.from({ length: 60 }, (_, n) => floatsFor('uniform-test', 'c', n, 400)))).flat();
    const bins: number[] = Array(20).fill(0);
    f.forEach(x => { const b = Math.floor(x * 20); bins[b] = (bins[b] as number) + 1; });
    const exp = f.length / 20;
    const chi = bins.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(36.19);
  });
});

describe('crash', () => {
  it('never pays below 1.00x or above the cap, and rises with the roll', () => {
    expect(crashPoint(0)).toBe(1);
    expect(crashPoint(0.999999999)).toBe(10000);
    expect(crashPoint(0.5)).toBe(1.94);
    let prev = 0;
    for (let f = 0; f < 1; f += 0.01) { const c = crashPoint(f); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
  });

  it('has an RTP of about 97% at any fixed cash-out', () => {
    // P(crash >= m) = HOUSE.crash / m, so m * P is the return of always cashing out at m.
    const rng = seededRandom(7);
    for (const m of [1.5, 2, 5, 10]) {
      let wins = 0; const N = 200000;
      for (let i = 0; i < N; i++) if (crashPoint(rng()) >= m) wins++;
      const tol = 0.03 * Math.sqrt(m);
      expect((wins / N) * m).toBeGreaterThan(HOUSE.crash - tol);
      expect((wins / N) * m).toBeLessThan(HOUSE.crash + tol);
    }
  });
});

describe('double', () => {
  const tiles = [...Array(DOUBLE_TILES).keys()];
  it('has 1 green, 7 purple and 7 gray tiles', () => {
    expect(tiles.filter(n => doubleColor(n) === 'green')).toHaveLength(1);
    expect(tiles.filter(n => doubleColor(n) === 'purple')).toHaveLength(7);
    expect(tiles.filter(n => doubleColor(n) === 'gray')).toHaveLength(7);
  });
  it('maps rolls to tiles 0..14', () => {
    expect(doubleRoll(0)).toBe(0);
    expect(doubleRoll(0.9999999)).toBe(14);
  });
  it('pays every lane the same expected return (93.33%), including the bait lane', () => {
    for (const lane of ['purple', 'gray', 'green', 'bait'] as DoubleLane[]) {
      const p = tiles.filter(n => doubleWins(lane, n)).length / DOUBLE_TILES;
      expect(p * DOUBLE_PAY[lane]).toBeCloseTo(HOUSE.double, 3);
    }
    expect(tiles.filter(n => doubleWins('bait', n))).toEqual([1, 14]);
  });
});

describe('mines', () => {
  it('returns distinct positions inside the grid, deterministically', () => {
    const rng = seededRandom(3);
    const grids: [number, number][] = [[16, 3], [25, 10], [64, 24]];
    for (const [N, mines] of grids) {
      const floats = Array.from({ length: N - 1 }, () => rng());
      const pos = minePositions(floats, mines, N);
      expect(pos).toHaveLength(mines);
      expect(new Set(pos).size).toBe(mines);
      expect(pos.every(p => p >= 0 && p < N)).toBe(true);
      expect(minePositions(floats, mines, N)).toEqual(pos);
    }
  });

  it('puts a mine on every tile with equal probability (mines / tiles)', () => {
    const rng = seededRandom(11), N = 25, mines = 5, runs = 40000;
    const hits: number[] = Array(N).fill(0);
    for (let r = 0; r < runs; r++) for (const p of minePositions(Array.from({ length: N - 1 }, () => rng()), mines, N)) hits[p] = (hits[p] as number) + 1;
    for (const h of hits) {
      expect(h / runs).toBeGreaterThan(mines / N - 0.02);
      expect(h / runs).toBeLessThan(mines / N + 0.02);
    }
  });

  it('multipliers start at the documented value and never beat the 97% return', () => {
    expect(minesMultiplier(3, 1, 25)).toBe(1.1);          // floor(0.97 * 25 / 22 * 100) / 100
    const grids: [number, number][] = [[16, 3], [25, 3], [25, 10], [36, 8], [64, 24]];
    for (const [N, mines] of grids) {
      let p = 1;
      for (let picks = 1; picks <= N - mines; picks++) {
        p *= (N - mines - (picks - 1)) / (N - (picks - 1));
        expect(p * minesMultiplier(mines, picks, N)).toBeLessThanOrEqual(HOUSE.mines + 1e-9);
      }
    }
  });
});

describe('plinko', () => {
  it('has tables that are symmetric, edge-heavy and return about 97%', () => {
    const choose = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
    for (const rows of [8, 10, 12, 14, 16]) for (const risk of ['low', 'normal', 'high'] as Risk[]) {
      const t = plinkoTable(rows, risk);
      expect(t).toHaveLength(rows + 1);
      expect(t).toEqual([...t].reverse());
      expect(Math.max(...t)).toBe(t[0]);
      const rtp = t.reduce((s, m, k) => s + (choose(rows, k) / 2 ** rows) * m, 0);
      expect(rtp).toBeGreaterThan(HOUSE.plinko - 0.03);
      expect(rtp).toBeLessThan(HOUSE.plinko + 0.03);
    }
  });
  it('higher risk widens the spread between edge and middle', () => {
    const spread = (r: Risk) => { const t = plinkoTable(12, r); return (t[0] as number) / (t[6] as number); };
    expect(spread('low')).toBeLessThan(spread('normal'));
    expect(spread('normal')).toBeLessThan(spread('high'));
  });
  it('turns floats into left/right moves at 0.5', () => {
    expect(plinkoPath([0, 0.49999, 0.5, 0.99], 3)).toEqual([0, 0, 1]);
    expect(plinkoPath([0.9, 0.9, 0.9, 0.9], 2)).toHaveLength(2);
  });
});

describe('upgrade and weighted picks', () => {
  it('chance is stake / target times the house edge, capped at 80%', () => {
    expect(upgradeChance(1, 5)).toBeCloseTo(0.19, 10);
    expect(upgradeChance(10, 10)).toBe(UPGRADE_MAX);
    expect(upgradeChance(1, 1000)).toBeLessThan(0.001);
  });
  it('pickWeighted follows the weights', () => {
    const e = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
    expect(pickWeighted(e, 0).id).toBe('a');
    expect(pickWeighted(e, 0.24).id).toBe('a');
    expect(pickWeighted(e, 0.26).id).toBe('b');
    expect(pickWeighted(e, 0.999999).id).toBe('b');
  });
});
