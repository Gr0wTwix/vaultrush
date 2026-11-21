import { readdirSync } from 'node:fs';
/** Small deterministic PRNG (mulberry32) so statistical tests never flake. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The migrations that put the real Counter-Strike 2 catalogue in the database, in the order to run them (0014 in numbered parts, then 0015). */
export function realItemMigrations(): string[] {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const parts = readdirSync(dir).filter(f => /^0014_real_items_\d+\.sql$/.test(f)).map(f => f.replace(/\.sql$/, '')).sort((a, b) => Number(a.match(/(\d+)$/)![1]) - Number(b.match(/(\d+)$/)![1]));
  return [...parts, '0015_real_cases'];
}
