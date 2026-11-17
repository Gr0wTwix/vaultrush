// Provably fair: result floats = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:${round}`), 4 bytes per float.
// DEMO NOTE: here the server seed lives in the browser. In production it must stay on the server
// and only its SHA-256 hash is shown until the player rotates seeds.
const KEY = 'vaultrush.fair.v1';
const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const randHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256(str) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

export async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** Deterministic floats in [0,1) for one bet. */
export async function floatsFor(serverSeed, clientSeed, nonce, count) {
  const out = [];
  for (let round = 0; out.length < count; round++) {
    const h = await hmac(serverSeed, `${clientSeed}:${nonce}:${round}`);
    for (let i = 0; i + 8 <= h.length && out.length < count; i += 8) out.push(parseInt(h.slice(i, i + 8), 16) / 2 ** 32);
  }
  return out;
}

let fair;
function persist() { try { localStorage.setItem(KEY, JSON.stringify(fair)); } catch { /* ignore */ } }

const newSeed = async () => { const serverSeed = randHex(32); return { serverSeed, serverHash: await sha256(serverSeed) }; };

export async function initFair() {
  try { fair = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { fair = null; }
  if (!fair) {
    const cur = await newSeed();
    fair = { ...cur, clientSeed: randHex(8), nonce: 0, revealed: [], history: [] };
  }
  // The NEXT server seed is committed (hash shown) before it is ever used, like the reference sites.
  if (!fair.next) fair.next = await newSeed();
  persist();
  return fair;
}

export const getFair = () => fair;

/** Consume one nonce and return `count` floats for a bet. */
/**
 * Consume one nonce and return `count` floats for a bet.
 * `params` are the public inputs of the game (case id, grid size, rows, ...). They are stored with the bet so
 * the Fairness page can recompute the result from the revealed seed.
 */
export async function bet(game, count, params) {
  const nonce = fair.nonce++;
  const floats = await floatsFor(fair.serverSeed, fair.clientSeed, nonce, count);
  const entry = { id: `${fair.serverHash.slice(0, 6)}-${nonce}`, game, nonce, clientSeed: fair.clientSeed, serverHash: fair.serverHash, at: Date.now(), count };
  if (params) entry.params = params;
  fair.history.unshift(entry);
  fair.history.length = Math.min(fair.history.length, 200);
  persist();
  return { floats, entry };
}

/** `result` is the readable text; `key` is the canonical outcome (ticket, tile, path...) the verifier recomputes and compares. */
export function annotate(entry, result, key) { entry.result = result; if (key !== undefined) entry.key = String(key); persist(); }

export function setClientSeed(seed) {
  fair.clientSeed = String(seed).slice(0, 64) || randHex(8);
  persist();
}

/** Reveal the current server seed and start a new pair. */
export async function rotate() {
  fair.revealed.unshift({ serverSeed: fair.serverSeed, serverHash: fair.serverHash, clientSeed: fair.clientSeed, nonces: fair.nonce, at: Date.now() });
  fair.revealed.length = Math.min(fair.revealed.length, 40);
  // The seed that was committed as "next" becomes active; a fresh next seed is committed.
  fair.serverSeed = fair.next.serverSeed;
  fair.serverHash = fair.next.serverHash;
  fair.next = await newSeed();
  fair.nonce = 0;
  persist();
}

// ---- Game math shared by the games and the verifier -------------------------------------------
export const HOUSE = { cases: 0.9, crash: 0.97, mines: 0.97, upgrade: 0.95, plinko: 0.97, coinflip: 0.97, double: 0.9333 };

export const crashPoint = f => Math.min(10000, Math.max(1, Math.floor((100 * HOUSE.crash) / (1 - f)) / 100));

// ---- Double: 15 tiles, 0 = green, odd = purple, even = gray; bait = tiles 1 and 14 ----------------
export const DOUBLE_TILES = 15;
export const doubleRoll = f => Math.floor(f * DOUBLE_TILES);
export const doubleColor = n => (n === 0 ? 'green' : n % 2 ? 'purple' : 'gray');
export const DOUBLE_PAY = { purple: 2, gray: 2, green: 14, bait: 7 };
export const doubleWins = (lane, n) => (lane === 'bait' ? n === 1 || n === 14 : doubleColor(n) === lane);

// ---- binomial helpers ----------------------------------------------------------------------------
const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
const round2 = n => Math.round(n * 100) / 100;

// ---- Plinko: each row the ball goes right if its float >= 0.5; bucket = number of rights ---------
const PLINKO_BASE = { low: 1.18, normal: 1.42, high: 1.85 };
const plinkoCache = {};
export function plinkoTable(rows, risk) {
  const key = `${rows}-${risk}`;
  if (plinkoCache[key]) return plinkoCache[key];
  const p = [...Array(rows + 1).keys()].map(k => choose(rows, k) / 2 ** rows);
  const raw = p.map((_, k) => Math.pow(PLINKO_BASE[risk], Math.abs(k - rows / 2) * (12 / rows) * 1.1));
  const ev = raw.reduce((s, v, k) => s + v * p[k], 0);
  const table = raw.map(v => { const m = (v / ev) * HOUSE.plinko; return m >= 10 ? Math.round(m) : round2(m); });
  return (plinkoCache[key] = table);
}
export const plinkoPath = (floats, rows) => floats.slice(0, rows).map(f => (f >= 0.5 ? 1 : 0));



export function pickWeighted(entries, f) {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let x = f * total;
  for (const e of entries) { if ((x -= e.weight) < 0) return e; }
  return entries[entries.length - 1];
}

/** Fisher–Yates using (tiles - 1) floats -> mine positions. */
export function minePositions(floats, mines, tilesN = 25) {
  const tiles = [...Array(tilesN).keys()];
  for (let i = tilesN - 1; i > 0; i--) {
    const j = Math.floor(floats[tilesN - 1 - i] * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, mines);
}

export function minesMultiplier(mines, picks, tilesN = 25) {
  let m = HOUSE.mines;
  for (let i = 0; i < picks; i++) m *= (tilesN - i) / (tilesN - mines - i);
  return Math.floor(m * 100) / 100;
}

export const UPGRADE_MAX = 0.8;
export const upgradeChance = (stake, target) => Math.min(UPGRADE_MAX, (stake / target) * HOUSE.upgrade);
