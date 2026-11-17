// Independent re-computation of past bets, plus the house-edge (RTP) and randomness self-tests shown on the Fairness page.
import { floatsFor, sha256, HOUSE, crashPoint, minePositions, minesMultiplier, doubleRoll, doubleWins, DOUBLE_PAY, plinkoPath, plinkoTable, upgradeChance } from './fair.js';
import { CASE, CASES, entryForTicket, ticketOf } from './data.js';
import type { BetEntry, BetParams, Case, DoubleLane, RevealedSeed, Risk } from './types.js';

const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`missing ${what}`); return v; };
export interface Recomputed { key: string; text: string }

/** Recompute one bet from (serverSeed, clientSeed, nonce). Returns { key, text }; `key` is compared with the stored one. */
export async function recompute(game: string, params: BetParams | undefined, serverSeed: string, clientSeed: string, nonce: number): Promise<Recomputed | null> {
  const p = params ?? {};
  const one = async (): Promise<number> => (await floatsFor(serverSeed, clientSeed, nonce, 1))[0] as number;
  switch (game) {
    case 'cases': {
      const f = await one(), t = ticketOf(f), it = entryForTicket(need(CASE[need(p.case, 'case')], 'case'), t).item;
      return { key: `${t}:${it.id}`, text: `Roll ${f.toFixed(8)} → ticket #${t} → ${it.weapon} | ${it.skin}` };
    }
    case 'crash': { const f = await one(), c = crashPoint(f); return { key: c.toFixed(2), text: `Roll ${f.toFixed(8)} → crash at ${c.toFixed(2)}×` }; }
    case 'double': { const f = await one(), n = doubleRoll(f); return { key: String(n), text: `Roll ${f.toFixed(8)} → tile ${n}` }; }
    case 'coinflip': { const f = await one(), s = f < 0.5 ? 'bolt' : 'star'; return { key: s, text: `Roll ${f.toFixed(8)} → ${s === 'bolt' ? '⚡ Bolt' : '★ Star'}` }; }
    case 'mines': {
      const N = need(p.grid, 'grid'), pos = minePositions(await floatsFor(serverSeed, clientSeed, nonce, N - 1), need(p.mines, 'mines'), N).map(x => x + 1).sort((a, b) => a - b);
      return { key: pos.join(','), text: `Mines on tiles ${pos.join(', ')}` };
    }
    case 'plinko': {
      const rows = need(p.rows, 'rows'), path = plinkoPath(await floatsFor(serverSeed, clientSeed, nonce, rows), rows).map(x => (x ? 'R' : 'L')).join('');
      return { key: path, text: `Path ${path} → bucket ${[...path].filter(c => c === 'R').length}` };
    }
    case 'upgrade': {
      const f = await one(), ch = need(p.chance, 'chance'), win = p.over ? f > 1 - ch : f < ch;
      return { key: `${f.toFixed(6)}:${win ? 1 : 0}`, text: `Roll ${(f * 100).toFixed(4)} (${(ch * 100).toFixed(2)}% ${p.over ? 'over' : 'under'}) → ${win ? 'win' : 'lose'}` };
    }
    case 'battles': {
      const P = need(p.players, 'players'), R = need(p.cases, 'cases').length, fl = await floatsFor(serverSeed, clientSeed, nonce, P * R + 1);
      const tickets: number[] = [];
      for (let pl = 0; pl < P; pl++) for (let r = 0; r < R; r++) tickets.push(ticketOf(fl[r * P + pl] as number));
      const tie = (fl[fl.length - 1] as number).toFixed(6);
      return { key: `${tickets.join(',')}|${tie}`, text: `Tickets (player-major) ${tickets.join(', ')} · tie-break roll ${tie}` };
    }
    default: return null;
  }
}

/**
 * Check every stored bet. status: 'active' (seed still hidden), 'ok', 'bad', 'seed' (revealed seed does not hash to the committed hash),
 * 'old' (bet made before verification keys existed).
 */
export type VerifyStatus = 'active' | 'ok' | 'bad' | 'seed' | 'old';
export interface VerifyRow { b: BetEntry; status: VerifyStatus; text?: string; got?: string }

export async function verifyAll(history: BetEntry[], revealed: RevealedSeed[]): Promise<VerifyRow[]> {
  const bySeed = new Map(revealed.map(r => [r.serverHash, r]));
  const hashOk = new Map<string, boolean>();
  const out: VerifyRow[] = [];
  for (const b of history) {
    const r = bySeed.get(b.serverHash);
    if (!r) { out.push({ b, status: 'active' }); continue; }
    if (!hashOk.has(r.serverHash)) hashOk.set(r.serverHash, (await sha256(r.serverSeed)) === r.serverHash);
    if (!hashOk.get(r.serverHash)) { out.push({ b, status: 'seed' }); continue; }
    if (b.key === undefined) { out.push({ b, status: 'old' }); continue; }
    try {
      const re = await recompute(b.game, b.params, r.serverSeed, b.clientSeed, b.nonce);
      out.push({ b, status: re && re.key === b.key ? 'ok' : 'bad', text: re?.text, got: re?.key });
    } catch (e) { out.push({ b, status: 'bad', text: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}

// ---- house edge / RTP self-test ------------------------------------------------------------------------------
const buf = new Uint32Array(8192); let bi = buf.length;
const rnd = (): number => { if (bi >= buf.length) { crypto.getRandomValues(buf); bi = 0; } return (buf[bi++] as number) / 2 ** 32; };

class Stat {
  n = 0; mean = 0; m2 = 0;
  add(x: number): void { this.n++; const d = x - this.mean; this.mean += d / this.n; this.m2 += d * (x - this.mean); }
  get se(): number { return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1) / this.n) : 0; }
}
const choose = (n: number, k: number): number => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

/** Exact RTP of a case from its ticket table (sum of range size × value ÷ 100,000 ÷ price). */
const caseExactRtp = (c: Case): number => c.entries.reduce((s, e) => s + ((e.to - e.from + 1) / 100000) * e.item.value, 0) / c.price;

export interface RtpResult { name: string; rule: string; theory: number; sim: number; se: number; rounds: number; pass: boolean; exact?: boolean; min?: number; max?: number }
interface SimRow { name: string; rule: string; theory: number; play?: () => number; rounds: number; stat: Stat; exactVal?: number; min?: number; max?: number }

/** Runs n rounds per row using the real game functions, and compares the measured return with the exact maths. */
export async function rtpTest(n = 100000, onProgress: (p: number) => void = () => {}): Promise<RtpResult[]> {
  const rows: SimRow[] = [];
  const add = (name: string, rule: string, theory: number, play: () => number, rounds: number = n): void => { rows.push({ name, rule, theory, play, rounds, stat: new Stat() }); };

  // Cases: exact from the ticket table, and a ticket-range simulation for the most-played mid-price case.
  const exact = CASES.map(caseExactRtp);
  rows.push({ rounds: 0, stat: new Stat(), name: `Cases (all ${CASES.length})`, rule: 'Exact from every case\'s ticket ranges; price = expected value ÷ 0.90', theory: HOUSE.cases, exactVal: exact.reduce((a, b) => a + b, 0) / exact.length, min: Math.min(...exact), max: Math.max(...exact) });
  const starter = need(CASE.neon, 'neon case');
  add('Cases: Neon Nights', 'Random ticket 0–99,999 → item value ÷ price', caseExactRtp(starter), () => entryForTicket(starter, ticketOf(rnd())).item.value / starter.price);

  add('Crash: cash out at 2.00×', 'Crash point = ⌊97 ÷ (1 − roll)⌋ ÷ 100', 0.97, () => (crashPoint(rnd()) >= 2 ? 2 : 0));
  for (const [lane, label] of [['purple', 'Purple 2×'], ['gray', 'Gray 2×'], ['green', 'Green 14×'], ['bait', 'Bait 7×']] as [DoubleLane, string][]) {
    add(`Double: ${label}`, '15 tiles: 0 green, odd purple, even gray; bait = tiles 1 & 14', HOUSE.double, () => (doubleWins(lane, doubleRoll(rnd())) ? DOUBLE_PAY[lane] : 0));
  }
  {
    const N = 25, M = 3, picks = 3;
    let p = 1; for (let i = 0; i < picks; i++) p *= (N - M - i) / (N - i);
    add('Mines: 5×5, 3 mines, cash out after 3 gems', 'Mines = Fisher–Yates shuffle of the tiles', p * minesMultiplier(M, picks, N), () => {
      const f = Array.from({ length: N - 1 }, () => rnd()), pos = new Set(minePositions(f, M, N));
      return !pos.has(0) && !pos.has(1) && !pos.has(2) ? minesMultiplier(M, picks, N) : 0;
    }, Math.min(n, 60000));
  }
  for (const [rows_, risk] of [[12, 'low'], [12, 'normal'], [12, 'high'], [16, 'normal']] as [number, Risk][]) {
    const t = plinkoTable(rows_, risk);
    const theory = t.reduce((s, m, k) => s + (choose(rows_, k) / 2 ** rows_) * m, 0);
    add(`Plinko: ${rows_} rows, ${risk}`, 'One roll per row: ≥ 0.5 bounces right; bucket = number of rights', theory, () => t[plinkoPath(Array.from({ length: rows_ }, () => rnd()), rows_).reduce((a, b) => a + b, 0)] as number);
  }
  add('Coinflip: any side', 'Roll < 0.5 = Bolt; winner takes the pot minus 3%', 2 * HOUSE.coinflip * 0.5, () => (rnd() < 0.5 ? 2 * HOUSE.coinflip : 0));
  {
    const stake = 1, target = 5, ch = upgradeChance(stake, target);
    add('Upgrade: 1 → 5 (19%)', 'Win if roll < chance; chance = stake ÷ target × 0.95', ch * (target / stake), () => (rnd() < ch ? target / stake : 0));
  }

  const sims = rows.filter((r): r is SimRow & { play: () => number } => !!r.play), total = sims.reduce((s, r) => s + r.rounds, 0);
  let done = 0;
  for (const r of sims) {
    for (let i = 0; i < r.rounds; i++) {
      r.stat.add(r.play());
      if ((i & 4095) === 4095) { onProgress((done + i) / total); await new Promise(res => setTimeout(res, 0)); }
    }
    done += r.rounds;
  }
  onProgress(1);
  return rows.map(r => r.play
    ? { name: r.name, rule: r.rule, theory: r.theory, sim: r.stat.mean, se: r.stat.se, rounds: r.rounds, pass: Math.abs(r.stat.mean - r.theory) <= 4 * r.stat.se + 1e-9 }
    : { name: r.name, rule: r.rule, theory: r.theory, sim: r.exactVal ?? 0, se: 0, rounds: 0, exact: true, min: r.min, max: r.max, pass: Math.abs((r.exactVal ?? 0) - r.theory) < 0.02 });
}

// ---- randomness self-test of the real HMAC generator ----------------------------------------------------------------
/** Draws `count` floats from a throw-away seed with the real generator and runs a chi-square uniformity test (20 bins). */
export async function uniformityTest(count = 20000): Promise<{ bins: number[]; n: number; mean: number; chi: number; pass: boolean; crit: number }> {
  const seed = crypto.getRandomValues(new Uint8Array(16)).join(''), bins: number[] = Array(20).fill(0);
  let sum = 0, done = 0, nonce = 0;
  while (done < count) {
    const batch = await floatsFor(seed, 'selftest', nonce++, 400);
    for (const f of batch) { const b = Math.min(19, Math.floor(f * 20)); bins[b] = (bins[b] as number) + 1; sum += f; done++; }
  }
  const exp = done / 20, chi = bins.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
  // df = 19: critical values 30.14 (5%) and 36.19 (1%); fail only beyond 1% so an honest generator rarely flags.
  return { bins, n: done, mean: sum / done, chi, pass: chi < 36.19, crit: 36.19 };
}

// ---- standalone verifier (Node) users can copy ---------------------------------------------------------------------
export const SNIPPET = `// Node 18+ · node verify.js   (no dependencies)
const crypto = require('crypto');
const serverSeed = 'PASTE REVEALED SERVER SEED', clientSeed = 'PASTE CLIENT SEED', nonce = 0;

// 1) the seed must hash to the value you were shown BEFORE you played
console.log('hash', crypto.createHash('sha256').update(serverSeed).digest('hex'));

// 2) floats: HMAC_SHA256(serverSeed, clientSeed:nonce:round), 4 bytes per float, 8 floats per round
function floats(count) {
  const out = [];
  for (let round = 0; out.length < count; round++) {
    const h = crypto.createHmac('sha256', serverSeed).update(clientSeed + ':' + nonce + ':' + round).digest('hex');
    for (let i = 0; i + 8 <= 64 && out.length < count; i += 8) out.push(parseInt(h.slice(i, i + 8), 16) / 2 ** 32);
  }
  return out;
}
const f = floats(1)[0];
console.log('roll', f);
console.log('case ticket   ', Math.floor(f * 100000));                        // 0-99,999 → item by ticket range
console.log('crash point  ', Math.max(1, Math.floor(97 / (1 - f)) / 100));    // 3% edge
console.log('double tile  ', Math.floor(f * 15));                              // 0 green, odd purple, even gray
console.log('coinflip     ', f < 0.5 ? 'bolt' : 'star');
// Plinko: floats(rows).map(x => x >= 0.5 ? 'R' : 'L')  ·  Mines: Fisher-Yates over floats(tiles - 1), see the Fairness page
`;
