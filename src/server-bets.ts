// Turns a bet that the DATABASE made (supabase/migrations/0010_solo_games.sql) into the inputs of the browser's own verifier (src/verify.ts), so a player can
// re-check it from the revealed seed: same HMAC, same maths, nothing taken on trust. Bets of the live games (Battles, Coinflip, Crash and Double rounds) have no
// personal seed: they use the game's own seed, which is revealed on that game's page, so they are not checkable here.
import type { BetParams } from './types.js';

export interface ServerBetRow {
  id: number; game: string; amount: number; payout: number; multiplier: number; nonce: number | null; client_seed: string | null; server_hash: string | null;
  params: Record<string, any> | null; result: Record<string, any> | null; created_at: string;
}
export interface Checkable { game: string; params: BetParams; key: string }

export function checkable(b: ServerBetRow): Checkable | null {
  if (b.nonce == null || !b.client_seed || !b.server_hash) return null;
  const p = b.params ?? {}, r = b.result ?? {};
  switch (b.game) {
    case 'cases': return { game: 'cases', params: { case: String(p['case']) }, key: `${r['ticket']}:${r['item']}` };
    case 'plinko': return { game: 'plinko', params: { rows: Number(p['rows']) }, key: ((r['path'] as number[] | undefined) ?? []).map(x => (x ? 'R' : 'L')).join('') };
    case 'mines': return { game: 'mines', params: { grid: Number(p['grid']), mines: Number(p['mines']) }, key: ((r['bombs'] as number[] | undefined) ?? []).join(',') };
    case 'upgrade': return { game: 'upgrade', params: { chance: Number(r['chance']), over: !!p['over'] }, key: `${Number(r['roll']).toFixed(6)}:${r['win'] ? 1 : 0}` };
    case 'crash': return { game: 'crash', params: {}, key: Number(r['crash_point']).toFixed(2) };
    default: return null;
  }
}

/** A short readable result for the bets table. */
export function resultText(b: ServerBetRow): string {
  const r = b.result ?? {};
  switch (b.game) {
    case 'cases': return `ticket #${r['ticket']}`;
    case 'plinko': return `bucket ${r['bucket']} · ${r['mult']}×`;
    case 'mines': return `${r['outcome'] ?? ''} · ${(r['picks'] as number[] | undefined)?.length ?? 0} gems`;
    case 'upgrade': return `${r['win'] ? 'win' : 'miss'} · roll ${(Number(r['roll']) * 100).toFixed(2)}`;
    case 'crash': return `crashed at ${r['crash_point'] ?? r['point']}×`;
    case 'double': return `tile ${r['n']}`;
    case 'coinflip': return String(r['result'] ?? '');
    case 'battles': return `seat ${Number(r['seat']) + 1}`;
    default: return '';
  }
}
