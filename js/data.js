// Original item catalog and cases (invented names: swap in your own art and items).
import { HOUSE } from './fair.js';

export const RARITY = {
  common: { label: 'Common', color: '#9aa6bd' },
  uncommon: { label: 'Uncommon', color: '#4f9dff' },
  rare: { label: 'Rare', color: '#8f6bff' },
  epic: { label: 'Epic', color: '#ff4fc8' },
  legendary: { label: 'Legendary', color: '#ff5a4f' },
  mythic: { label: 'Mythic', color: '#ffc53d' },
};

const RAW = [
  ['p1', 'Viper P9', 'Static', 'pistol', 'common', 0.08],
  ['s1', 'Hornet SMG', 'Grid Rot', 'smg', 'common', 0.12],
  ['p2', 'Viper P9', 'Sandblast', 'pistol', 'common', 0.15],
  ['r1', 'Ranger AR', 'Field Kit', 'rifle', 'common', 0.22],
  ['s2', 'Hornet SMG', 'Night Tide', 'smg', 'uncommon', 0.45],
  ['p3', 'Duke .50', 'Ember', 'pistol', 'uncommon', 0.9],
  ['n1', 'Longshot R8', 'Mossback', 'sniper', 'uncommon', 1.2],
  ['r2', 'Ranger AR', 'Ice Vein', 'rifle', 'uncommon', 1.6],
  ['c1', 'Charm', 'Neon Fang', 'charm', 'rare', 2.5],
  ['s3', 'Hornet SMG', 'Acid Bloom', 'smg', 'rare', 3.4],
  ['p4', 'Duke .50', 'Circuit', 'pistol', 'rare', 4.8],
  ['r3', 'Vanguard AR', 'Redline', 'rifle', 'rare', 7.5],
  ['n2', 'Longshot R8', 'Tidebreaker', 'sniper', 'rare', 9.9],
  ['c2', 'Charm', 'Crystal Skull', 'charm', 'epic', 14],
  ['p5', 'Duke .50', 'Prism', 'pistol', 'epic', 18],
  ['r4', 'Vanguard AR', 'Solar Flare', 'rifle', 'epic', 24],
  ['n3', 'Longshot R8', 'Thunderhead', 'sniper', 'epic', 38],
  ['r5', 'Ranger AR', 'Voidwalker', 'rifle', 'legendary', 95],
  ['k1', 'Talon Knife', 'Rust Edge', 'knife', 'legendary', 140],
  ['n4', 'Phantom AWR', 'Dragon Coil', 'sniper', 'legendary', 180],
  ['k2', 'Crescent Knife', 'Night Bloom', 'knife', 'legendary', 260],
  ['r6', 'Vanguard AR', 'Aurora', 'rifle', 'mythic', 520],
  ['k3', 'Talon Knife', 'Molten Gold', 'knife', 'mythic', 890],
  ['k4', 'Crescent Knife', 'Galaxy Fade', 'knife', 'mythic', 1650],
  ['n5', 'Phantom AWR', 'Starforged', 'sniper', 'mythic', 2400],
  // ---- expansion pack (48 items, art in assets/items/web/x01..x48.png) ----
  ['x44', "Explorer Sleeping Bag", "Moonlit Meadow", 'sleeping bag', 'common', 0.11],
  ['x43', "Expedition Backpack", "Moss Lantern", 'backpack', 'common', 0.14],
  ['x41', "Ranger Jacket", "Cinder Scout", 'jacket', 'common', 0.17],
  ['x40', "Drifter Hoodie", "Midnight Arcade", 'hoodie', 'common', 0.2],
  ['x42', "Mechanic Gloves", "Copper Pulse", 'gloves', 'common', 0.24],
  ['x08', "Trail Boots", "Copper Canyon", 'boots', 'common', 0.28],
  ['x09', "Scout Goggles", "Bubble Riot", 'goggles', 'common', 0.35],
  ['x34', "Nomad Camp Stove", "Patchwork Parade", 'camp stove', 'common', 0.42],
  ['x45', "Salvage Crate", "Coral Vault", 'storage crate', 'uncommon', 0.6],
  ['x12', "Traveler Canteen", "Koi Undertow", 'canteen', 'uncommon', 0.75],
  ['x21', "Salvage Wrench", "Scrapyard Carnival", 'wrench', 'uncommon', 0.95],
  ['x35', "Outpost Radio", "Rust Circuit", 'radio', 'uncommon', 1.3],
  ['x24', "Mechanist Toolbox", "Clockwork Fern", 'toolbox', 'uncommon', 1.7],
  ['x06', "Miner Helmet", "Hazard Current", 'helmet', 'uncommon', 2.1],
  ['x30', "Survey Compass", "Glacier Forge", 'compass', 'uncommon', 2.6],
  ['x03', "Nomad Rifle", "Desert Relay", 'rifle', 'uncommon', 3],
  ['x11', "Cricket SMG", "Honeycomb Drift", 'smg', 'rare', 3.8],
  ['x10', "Comet SMG", "Violet Velocity", 'smg', 'rare', 4.6],
  ['x13', "Condor Pistol", "Sunken Treasure", 'pistol', 'rare', 5.5],
  ['x14', "Lynx Pistol", "Sugar Quartz", 'pistol', 'rare', 6.8],
  ['x15', "Basilisk Pistol", "Carbon Mirage", 'pistol', 'rare', 8.5],
  ['x29', "Trail Hatchet", "Amber Fossil", 'hatchet', 'rare', 10.5],
  ['x36', "Outrider Rifle", "Tape Deck", 'rifle', 'rare', 12],
  ['x05', "Sanctum Lantern", "Jade Cathedral", 'lantern', 'rare', 13.5],
  ['x02', "Jackal Rifle", "Petrol Mosaic", 'rifle', 'epic', 16],
  ['x04', "Warden Rifle", "Sakura Static", 'rifle', 'epic', 20],
  ['x31', "Prospector Pickaxe", "Meteor Rust", 'pickaxe', 'epic', 24],
  ['x32', "Artisan Hammer", "Kintsugi Signal", 'hammer', 'epic', 29],
  ['x38', "Wasteland Helmet", "Deep Diver", 'helmet', 'epic', 34],
  ['x33', "Dune Bow", "Sandglass", 'bow', 'epic', 41],
  ['x28', "Origami Fox Charm", "Neon Origami", 'charm', 'epic', 48],
  ['x47', "Trophy Charm", "Mecha Acorn", 'charm', 'epic', 56],
  ['x46', "Reliquary Charm", "Astral Moth", 'charm', 'epic', 66],
  ['x48', "Beacon Charm", "Prism Jelly", 'charm', 'epic', 78],
  ['x37', "Sentinel Mask", "Oni Foundry", 'metal facemask', 'legendary', 95],
  ['x39', "Bastion Chestplate", "Lotus Alloy", 'chest armor', 'legendary', 120],
  ['x22', "Mammoth Shotgun", "Obsidian Bloom", 'shotgun', 'legendary', 150],
  ['x23', "Bison Machine Gun", "Foundry Spirit", 'machine gun', 'legendary', 190],
  ['x16', "Monarch Revolver", "Royal Patina", 'revolver', 'legendary', 240],
  ['x07', "Vesper Rifle", "Ink Serpent", 'rifle', 'legendary', 310],
  ['x01', "Kestrel Rifle", "Porcelain Storm", 'rifle', 'legendary', 400],
  ['x26', "Tide Knife", "Pearl Undertow", 'knife', 'mythic', 560],
  ['x27', "Scarab Knife", "Verdigris Relic", 'knife', 'mythic', 720],
  ['x17', "Osprey Scoped Rifle", "Polar Oracle", 'sniper', 'mythic', 950],
  ['x20', "Boreal Scoped Rifle", "Emerald Monsoon", 'sniper', 'mythic', 1250],
  ['x19', "Orion Scoped Rifle", "Sunset Ronin", 'sniper', 'mythic', 1600],
  ['x25', "Rift Knife", "Opal Fracture", 'knife', 'mythic', 2100],
  ['x18', "Harrier Scoped Rifle", "Cosmic Cartographer", 'sniper', 'mythic', 3200],
];

const WEARS = ['FN', 'MW', 'FT', 'WW', 'BS'];
// Items with a rendered image (assets/items/web/<id>.png); the rest use the drawn SVG art from art.js.
// Pack items (x01–x48) all have art. Gear/tools/charms have no wear; only guns and knives do.
const WEAPON_TYPES = new Set(['pistol', 'smg', 'rifle', 'sniper', 'knife', 'revolver', 'shotgun', 'machine gun']);
const IMAGES = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 's1', 's2', 's3', 'r2', 'r3', 'r4', 'r5', 'r6', 'n1', 'n2', 'n3', 'n4', 'n5', 'k1', 'k2', 'k3', 'k4', 'c1', 'c2']);
export const ITEMS = RAW.map(([id, weapon, skin, type, rarity, value], i) => ({
  id, weapon, skin, type, rarity, value,
  img: IMAGES.has(id) || /^x[0-9]+$/.test(id) ? `assets/items/web/${id}.png` : undefined,
  wear: WEAPON_TYPES.has(type) ? WEARS[(i * 7) % 5] : '',
  st: WEAPON_TYPES.has(type) && i % 4 === 1,           // StatTrak-style counter variant
}));
export const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));

// `odds` (optional) fixes each item's chance; otherwise drop weight falls with value.
const CASE_DEFS = [
  { id: 'starter', name: 'Starter Crate', hue: 200, tag: 'official', items: ['p1', 'p2', 's1', 'r1', 's2', 'p3', 'r2', 'c1', 's3', 'r4'] },
  { id: 'flip', name: 'Coinflip Crate', hue: 95, tag: '50%', odds: { r2: 0.5, p1: 0.5 } },
  { id: 'neon', name: 'Neon Nights', hue: 300, tag: 'official', items: ['s2', 'p3', 'n1', 's3', 'c1', 'p4', 'r3', 'c2', 'p5', 'r5', 'k1'] },
  { id: 'charmed', name: 'Charmed', hue: 160, tag: 'official', items: ['c1', 'p3', 's3', 'c2', 'p5', 'r5', 'k2'] },
  { id: 'sniper', name: "Sniper's Den", hue: 30, tag: 'official', items: ['n1', 'r2', 'n2', 'p4', 'r3', 'n3', 'n4', 'n5'] },
  { id: 'phantom10', name: '10% Phantom', hue: 260, tag: '10%', odds: { n4: 0.1, n1: 0.3, r1: 0.6 } },
  { id: 'blade', name: 'Blade Vault', hue: 350, tag: 'official', items: ['p4', 'r3', 'n2', 'c2', 'r4', 'p5', 'k1', 'k2', 'k3', 'k4'] },
  { id: 'high', name: 'Highroller', hue: 48, tag: 'official', items: ['r4', 'n3', 'r5', 'n4', 'k2', 'r6', 'k3', 'k4', 'n5'] },
  // ---- expansion cases ----
  { id: 'wasteland', name: 'Wasteland Supply', hue: 28, tag: 'official', items: ['x44', 'x43', 'x41', 'x40', 'x42', 'x08', 'x34', 'x45', 'x35', 'x21', 'x38', 'x06'] },
  { id: 'gearup', name: 'Gear Up', hue: 125, tag: 'official', items: ['x44', 'x43', 'x41', 'x40', 'x42', 'x08', 'x09', 'x34', 'x06', 'x38'] },
  { id: 'canyon', name: 'Copper Canyon', hue: 22, tag: 'official', items: ['x08', 'x42', 'x03', 'x30', 'x29', 'x31', 'x33', 'x15', 'x36'] },
  { id: 'arcade', name: 'Midnight Arcade', hue: 275, tag: 'official', items: ['x40', 'x09', 'x35', 'x11', 'x10', 'x36', 'x04', 'x28', 'x47', 'x48'] },
  { id: 'foundry', name: 'Foundry Forge', hue: 15, tag: 'official', items: ['x21', 'x24', 'x35', 'x42', 'x29', 'x31', 'x32', 'x37', 'x22', 'x23', 'x39'] },
  { id: 'deeptide', name: 'Deep Tide', hue: 190, tag: 'official', items: ['x44', 'x12', 'x09', 'x13', 'x38', 'x48', 'x14', 'x05'] },
  { id: 'blossom', name: 'Sakura Bloom', hue: 335, tag: 'official', items: ['x40', 'x12', 'x14', 'x04', 'x28', 'x46', 'x48', 'x07'] },
  { id: 'relic', name: 'Relic Hunter', hue: 82, tag: 'official', items: ['x30', 'x24', 'x29', 'x31', 'x33', 'x46', 'x27', 'x25'] },
  { id: 'scopes', name: 'Long Range', hue: 205, tag: 'official', items: ['x30', 'x13', 'x14', 'x17', 'x20', 'x19', 'x18'] },
  { id: 'charmparade', name: 'Charm Parade', hue: 312, tag: 'official', items: ['c1', 'x28', 'c2', 'x47', 'x46', 'x48'] },
  { id: 'heavy', name: 'Heavy Metal', hue: 220, tag: 'official', items: ['x35', 'x15', 'x02', 'x36', 'x39', 'x37', 'x22', 'x23', 'x16', 'x01'] },
  { id: 'gilded', name: 'Gilded Armory', hue: 60, tag: 'official', items: ['x13', 'x14', 'x32', 'x05', 'x16', 'x07', 'x01', 'x17', 'x25'] },
  { id: 'aurora', name: 'Aurora Vault', hue: 168, tag: 'official', items: ['x30', 'x14', 'x13', 'x28', 'x48', 'x46', 'r6', 'x17', 'x20', 'x25'] },
  { id: 'knifeedge', name: 'Knife Edge', hue: 355, tag: 'official', items: ['x26', 'k1', 'x27', 'k2', 'x25', 'k3'] },
  { id: 'fox33', name: '33% Origami Fox', hue: 18, tag: '33%', odds: { x28: 0.33, x44: 0.34, x43: 0.33 } },
  { id: 'blade20', name: '20% Tide Knife', hue: 195, tag: '20%', odds: { x26: 0.2, x42: 0.5, x08: 0.3 } },
  { id: 'cosmic5', name: '5% Cosmic', hue: 250, tag: '5%', odds: { x18: 0.05, x13: 0.25, x09: 0.7 } },
];


// Reward-only cases (opened for free from the Rewards hub, never bought).
const REWARD_DEFS = [
  { id: 'daily', name: 'Daily Crate', hue: 140, reward: true, items: ['p1', 's1', 'r1', 's2', 'p3', 'n1', 'c1', 'r3', 'r5'] },
  { id: 'welcome', name: 'Welcome Crate', hue: 75, reward: true, items: ['p2', 'r1', 's2', 'p3', 'r2', 'c1', 'p4', 'k1'] },
];

// Case box art (assets/cases/<id>.webp). Cases without a file fall back to the drawn crate in ui.js.
const CASE_IMG = new Map([...['starter', 'flip', 'neon', 'charmed', 'sniper', 'blade', 'high', 'wasteland', 'gearup', 'canyon', 'arcade', 'foundry', 'deeptide', 'blossom', 'relic', 'scopes', 'charmparade', 'heavy', 'gilded', 'knifeedge', 'fox33', 'daily', 'aurora'].map(id => [id, id]),
  // no dedicated art yet: borrow the closest crate
  ['phantom10', 'arcade'], ['blade20', 'deeptide'], ['cosmic5', 'aurora'], ['welcome', 'daily']]);

// Prices are set so the expected value is HOUSE.cases (90%) of the price.
function buildCase(def) {
  const entries = def.odds
    ? Object.entries(def.odds).map(([id, chance]) => ({ item: ITEM[id], weight: chance }))
    : def.items.map(id => ({ item: ITEM[id], weight: 1 / Math.pow(ITEM[id].value, 1.25) }));
  const total = entries.reduce((s, e) => s + e.weight, 0);
  entries.forEach(e => { e.chance = e.weight / total; });
  entries.sort((a, b) => b.item.value - a.item.value);
  // Ticket ranges out of 100,000 (like the reference sites); the roll picks a ticket.
  let t = 0;
  entries.forEach((e, i) => { const n = i === entries.length - 1 ? 100000 - t : Math.max(1, Math.round(e.chance * 100000)); e.from = t; e.to = t + n - 1; t += n; });
  const ev = entries.reduce((s, e) => s + e.chance * e.item.value, 0);
  return { ...def, img: CASE_IMG.has(def.id) ? `assets/cases/${CASE_IMG.get(def.id)}.webp` : undefined, entries, ev, price: Math.round((ev / HOUSE.cases) * 100) / 100 };
}

export const CASES = CASE_DEFS.map(buildCase);
export const REWARD_CASES = REWARD_DEFS.map(buildCase);
export const CASE = Object.fromEntries([...CASES, ...REWARD_CASES].map(c => [c.id, c]));

/** Ticket number (0–99,999) for a roll, and the entry that owns it. */
export const ticketOf = f => Math.floor(f * 100000);
export const entryForTicket = (c, ticket) => c.entries.find(e => ticket >= e.from && ticket <= e.to) || c.entries[c.entries.length - 1];

export const BOTS = ['frostbyte', 'kappa_kid', 'm0nkey', 'Zeroday', 'lucky_lou', 'N1ghtowl', 'spray&pray', 'Vexx', 'tilted', 'rngesus', 'Bricktop', 'ozzy', 'Kaiju', 'pixelpete', 'Sable', 'noScope', 'jynx', 'Halcyon', 'grizz', 'Mirage'];
export const randomBot = (exclude = []) => {
  const pool = BOTS.filter(b => !exclude.includes(b));
  return pool[Math.floor(Math.random() * pool.length)];
};
