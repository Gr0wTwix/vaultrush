import { describe, expect, it } from 'vitest';
import { CASE, entryForTicket, ticketOf } from '../src/data.js';
import { crashPoint, doubleRoll, floatsFor, minePositions, plinkoPath, sha256 } from '../src/fair.js';
import { recompute, rtpTest, uniformityTest, verifyAll, SNIPPET } from '../src/verify.js';
import type { BetEntry, RevealedSeed } from '../src/types.js';

const SERVER = 'f'.repeat(64);
const CLIENT = 'tester';

describe('recompute', () => {
  it('reproduces a case opening from the seeds', async () => {
    const r = await recompute('cases', { case: 'starter' }, SERVER, CLIENT, 3);
    const f = (await floatsFor(SERVER, CLIENT, 3, 1))[0] as number;
    const item = entryForTicket(CASE.starter!, ticketOf(f)).item;
    expect(r?.key).toBe(`${ticketOf(f)}:${item.id}`);
    expect(r?.text).toContain(item.skin);
  });

  it('reproduces crash, double, coinflip, mines, plinko, upgrade and battles', async () => {
    const f1 = (await floatsFor(SERVER, CLIENT, 0, 1))[0] as number;
    expect((await recompute('crash', {}, SERVER, CLIENT, 0))?.key).toBe(crashPoint(f1).toFixed(2));
    expect((await recompute('double', {}, SERVER, CLIENT, 0))?.key).toBe(String(doubleRoll(f1)));
    expect((await recompute('coinflip', {}, SERVER, CLIENT, 0))?.key).toBe(f1 < 0.5 ? 'bolt' : 'star');

    const mines = await recompute('mines', { grid: 25, mines: 5 }, SERVER, CLIENT, 1);
    const pos = minePositions(await floatsFor(SERVER, CLIENT, 1, 24), 5, 25).map(x => x + 1).sort((a, b) => a - b);
    expect(mines?.key).toBe(pos.join(','));

    const plinko = await recompute('plinko', { rows: 12, risk: 'normal' }, SERVER, CLIENT, 2);
    expect(plinko?.key).toBe(plinkoPath(await floatsFor(SERVER, CLIENT, 2, 12), 12).map(x => (x ? 'R' : 'L')).join(''));
    expect(plinko?.key).toHaveLength(12);

    const up = await recompute('upgrade', { chance: 0.5, over: false }, SERVER, CLIENT, 4);
    expect(up?.text).toMatch(/win|lose/);

    const battle = await recompute('battles', { players: 2, cases: ['starter', 'neon'] }, SERVER, CLIENT, 5);
    expect(battle?.key.split('|')[0]?.split(',')).toHaveLength(4);
  });

  it('returns null for an unknown game and throws on missing public inputs', async () => {
    expect(await recompute('slide', {}, SERVER, CLIENT, 0)).toBeNull();
    await expect(recompute('mines', {}, SERVER, CLIENT, 0)).rejects.toThrow(/missing/);
  });
});

describe('verifyAll', () => {
  const hashOf = async (seed: string) => sha256(seed);

  async function bet(nonce: number, serverHash: string): Promise<BetEntry> {
    const r = await recompute('crash', {}, SERVER, CLIENT, nonce);
    return { id: `${serverHash.slice(0, 6)}-${nonce}`, game: 'crash', nonce, clientSeed: CLIENT, serverHash, at: 1, count: 1, key: r!.key };
  }

  it('marks honest bets ok, tampered bets bad and unrevealed bets active', async () => {
    const hash = await hashOf(SERVER);
    const revealed: RevealedSeed[] = [{ serverSeed: SERVER, serverHash: hash, clientSeed: CLIENT, nonces: 3, at: 1 }];
    const good = await bet(0, hash);
    const tampered = { ...(await bet(1, hash)), key: '99.99' };
    const stranger = await bet(2, 'unknown-hash');
    const rows = await verifyAll([good, tampered, stranger], revealed);
    expect(rows.map(r => r.status)).toEqual(['ok', 'bad', 'active']);
  });

  it('flags a revealed seed that does not hash to the committed value, and old bets without a key', async () => {
    const hash = await hashOf(SERVER);
    const forged: RevealedSeed[] = [{ serverSeed: 'not-the-seed', serverHash: hash, clientSeed: CLIENT, nonces: 1, at: 1 }];
    expect((await verifyAll([await bet(0, hash)], forged))[0]?.status).toBe('seed');
    const honest: RevealedSeed[] = [{ serverSeed: SERVER, serverHash: hash, clientSeed: CLIENT, nonces: 1, at: 1 }];
    const { key: _drop, ...noKey } = await bet(0, hash);
    expect((await verifyAll([noKey as BetEntry], honest))[0]?.status).toBe('old');
  });
});

describe('self-tests shown on the Fairness page', () => {
  it('house-edge simulation: every row matches the exact maths within 6 standard errors', async () => {
    const rows = await rtpTest(20000);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const r of rows) {
      if (r.exact) expect(Math.abs(r.sim - r.theory)).toBeLessThan(0.02);
      else expect(Math.abs(r.sim - r.theory), r.name).toBeLessThanOrEqual(6 * r.se + 1e-9);
    }
  }, 60_000);

  it('generator uniformity test passes (best of 3, since a 1% test fails 1 run in 100)', async () => {
    const runs = [await uniformityTest(), await uniformityTest(), await uniformityTest()];
    expect(runs.some(r => r.pass)).toBe(true);
    expect(runs[0]?.n).toBe(20000);
  }, 60_000);

  it('the copy-paste verifier mentions the same formulas the game uses', () => {
    expect(SNIPPET).toContain('createHmac');
    expect(SNIPPET).toContain('/ 2 ** 32');
    expect(SNIPPET).toContain('97 / (1 - f)');
  });
});
