// The item catalogue and the cases. The items are the real Counter-Strike 2 skins (names, grades and pictures from ByMykel's CSGO-API; prices from
// Skinport's lowest listing in USD x 1.64 coins per dollar, the rate a credit-card deposit pays on the reference sites). Everything below the cases is built by `npm run build:catalogue` (scripts/build-catalogue.mjs); the
// whole catalogue (all ~14,000 priced items) is loaded on demand by src/catalogue.ts, only the items inside the cases are bundled with the page.
import cat from './catalogue/cases.generated.json';
import type { Case, CaseEntry, Item, Rarity } from './types.js';

/** CS2's grades, lowest first, with the colours the game uses. */
export const RARITY: Record<Rarity, { label: string; color: string }> = {
  consumer: { label: 'Consumer', color: '#b0c3d9' },
  industrial: { label: 'Industrial', color: '#5e98d9' },
  milspec: { label: 'Mil-Spec', color: '#4b69ff' },
  restricted: { label: 'Restricted', color: '#8847ff' },
  classified: { label: 'Classified', color: '#d32ce6' },
  covert: { label: 'Covert', color: '#eb4b4b' },
  extraordinary: { label: 'Extraordinary', color: '#ffcc33' },
  contraband: { label: 'Contraband', color: '#ff9a3d' },
};
export const RARITY_ORDER: Rarity[] = ['consumer', 'industrial', 'milspec', 'restricted', 'classified', 'covert', 'extraordinary', 'contraband'];
/** The grades that get the big celebration when they drop. */
export const isBigDrop = (r: Rarity): boolean => r === 'covert' || r === 'extraordinary' || r === 'contraband';
export const isHugeDrop = (r: Rarity): boolean => r === 'extraordinary' || r === 'contraband';

/** Where the pictures live: Valve's community CDN (the key is the part after /economy/image/). Items from newer drops use another host and carry the whole URL. */
const IMG_BASE = 'https://community.akamai.steamstatic.com/economy/image/';
export const itemImage = (key: string, size = '256fx192f'): string => (/^https?:/.test(key) ? key : `${IMG_BASE}${key}/${size}`);

/** The wear label for a "Factory New (FN) … Battle-Scarred (BS)" code. */
export const WEAR_NAME: Record<string, string> = { FN: 'Factory New', MW: 'Minimal Wear', FT: 'Field-Tested', WW: 'Well-Worn', BS: 'Battle-Scarred' };

/** Every item the page knows right now: the ones inside the cases, plus whatever src/catalogue.ts has loaded since. */
export const ITEM: Record<string, Item> = {};
export const ITEMS: Item[] = [];                                  // the items inside the cases, cheapest first
/** Add an item to the registry (a no-op if it is already there). Returns the registered item. */
export function registerItem(it: Item): Item {
  const have = ITEM[it.id];
  if (have) return have;
  ITEM[it.id] = it;
  return it;
}
for (const r of cat.items as any[]) ITEMS.push(registerItem({ id: r.id, weapon: r.weapon, skin: r.skin, type: r.type, rarity: r.rarity as Rarity, value: r.value, img: itemImage(r.img), wear: r.wear, st: !!r.st, souv: !!r.souv }));
ITEMS.sort((a, b) => a.value - b.value || (a.id < b.id ? -1 : 1));

/** How many priced items the full catalogue has (the page can search all of them on the Upgrade page). */
export const CATALOGUE_TOTAL: number = (cat as any).total;
/** The version of the catalogue and prices this page was built with. */
export const CATALOGUE_VERSION: string = (cat as any).v;

/** An item for an id the page has not loaded yet: shown greyed out until src/catalogue.ts has fetched it. Never has a value, so nothing is ever sold or staked on it. */
export const missingItem = (id: string): Item => ({ id, weapon: 'Loading…', skin: '', type: 'rifle', rarity: 'consumer', value: 0, wear: '', st: false });
/** The item for an id, or a greyed-out stand-in while it is still being fetched. */
export const itemOf = (id: string): Item => ITEM[id] ?? missingItem(id);
/** "AK-47 | Redline (Field-Tested)" */
export const itemName = (i: Item): string => `${i.st ? 'StatTrak™ ' : ''}${i.weapon}${i.skin ? ` | ${i.skin}` : ''}${i.wear ? ` (${WEAR_NAME[i.wear] ?? i.wear})` : ''}`;

// The cases, with their drop tables, prices and expected values, are generated (see the top of this file). A price keeps the 90% return: price = expected value / 0.9.
const build = (c: any): Case => ({
  id: c.id, name: c.name, hue: c.hue, tag: c.tag, reward: c.reward || undefined,
  img: `assets/cases/${c.id}.webp`,                               // every case has its own picture: public/assets/cases/<id>.webp
  entries: c.entries.map((e: any): CaseEntry => ({ item: ITEM[e.id] as Item, weight: e.chance, chance: e.chance, from: e.from, to: e.to })),
  ev: c.ev, price: c.price,
});
const ALL = (cat.cases as any[]).map(build);
export const CASES: Case[] = ALL.filter(c => !c.reward);
export const REWARD_CASES: Case[] = ALL.filter(c => c.reward);
export const CASE: Record<string, Case> = Object.fromEntries(ALL.map(c => [c.id, c]));

/** How risky a case is, measured honestly: the chance that one opening gives an item worth at least the price (`back`, 0 to 1).
 *  22% or more is Low, 12% or more is Medium, less is High. (Idea from the L / M / H labels on CSGOBig's cases.) */
export type CaseRisk = { level: 'low' | 'medium' | 'high'; back: number };
export function caseRisk(c: Case): CaseRisk {
  const back = c.entries.reduce((s, e) => s + (e.item && e.item.value >= c.price ? e.chance : 0), 0);
  return { level: back >= 0.22 ? 'low' : back >= 0.12 ? 'medium' : 'high', back };
}
export const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const;

/** Ticket number (0–99,999) for a roll, and the entry that owns it. */
export const ticketOf = (f: number): number => Math.floor(f * 100000);
export const entryForTicket = (c: Case, ticket: number): CaseEntry => c.entries.find(e => ticket >= e.from && ticket <= e.to) || (c.entries[c.entries.length - 1] as CaseEntry);

export const BOTS: string[] = ['frostbyte', 'kappa_kid', 'm0nkey', 'Zeroday', 'lucky_lou', 'N1ghtowl', 'spray&pray', 'Vexx', 'tilted', 'rngesus', 'Bricktop', 'ozzy', 'Kaiju', 'pixelpete', 'Sable', 'noScope', 'jynx', 'Halcyon', 'grizz', 'Mirage'];
export const randomBot = (exclude: string[] = []): string => {
  const pool = BOTS.filter(b => !exclude.includes(b));
  return pool[Math.floor(Math.random() * pool.length)] as string;
};
