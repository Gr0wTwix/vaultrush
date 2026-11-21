// Builds the real Counter-Strike 2 catalogue from two public feeds and writes everything the site and the database need.
//   Catalogue (names, wear, rarity, image): ByMykel's CSGO-API, skins_not_grouped.json   (MIT licensed code; data and images belong to Valve)
//   Prices (USD): Skinport bulk items API  (no key; Brotli required; cached 5 minutes; 8 requests per 5 minutes)
// The two are matched by market_hash_name. An item's value in coins = its lowest Skinport listing in USD x COINS_PER_USD (items with no listing have no price and are left out).
// COINS_PER_USD is the rate a credit-card deposit pays on the reference sites: 1.61 coins per $1 (CSGOWIN, $5 gives 8.05) and 1.666 per $1 (Payabl page, $5 gives 8.33),
// averaged to 1.64. Their item prices sit at about 1.8 to 1.9 coins per Skinport dollar, so a coin is worth roughly $0.55 to $0.6 of items. Change it with --rate=<n> (or here).
// Run:  npm run build:catalogue            (downloads, then writes the files below; add --offline to reuse the last download)
// Writes (all committed, regenerate on demand; prices change, so the files carry the time they were built):
//   public/catalogue/manifest.json, index.json, s/<n>.json    the whole catalogue for the browser (loaded lazily)
//   src/catalogue/cases.generated.json                        the cases and the items inside them (bundled with the page)
//   supabase/migrations/0014_real_items_*.sql, 0015_real_cases.sql   the database copy (values and drop tickets), in order
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { request } from 'node:https';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CACHE = `${ROOT}.cache/catalogue/`;
const OFFLINE = process.argv.includes('--offline');
const COINS_PER_USD = Number((process.argv.find(a => a.startsWith('--rate=')) ?? '--rate=1.64').slice(7));
if (!(COINS_PER_USD > 0)) throw new Error('--rate must be a positive number');
mkdirSync(CACHE, { recursive: true });

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  request(url, { headers: { 'User-Agent': 'vaultrush-catalogue-build', ...headers } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(new URL(res.headers.location, url).href, headers));
    if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
    const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => {
      let buf = Buffer.concat(parts); const enc = res.headers['content-encoding'];
      try { if (enc === 'br') buf = brotliDecompressSync(buf); else if (enc === 'gzip') buf = gunzipSync(buf); } catch (e) { return reject(e); }
      resolve(buf);
    });
  }).on('error', reject).end();
});
async function feed(name, url, headers) {
  const file = CACHE + name;
  if (OFFLINE || (existsSync(file) && Date.now() - +readFileSync(file + '.at', 'utf8') < 4 * 60_000)) { if (!existsSync(file)) throw new Error(`no cached ${name}`); return JSON.parse(readFileSync(file, 'utf8')); }
  console.log('downloading', name);
  const buf = await get(url, headers);
  writeFileSync(file, buf); writeFileSync(file + '.at', String(Date.now()));
  return JSON.parse(buf.toString('utf8'));
}

const variants = await feed('skins_not_grouped.json', 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json', { 'Accept-Encoding': 'gzip' });
const market = await feed('skinport-usd.json', 'https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0', { 'Accept-Encoding': 'br' });

// ---------------------------------------------------------------- prices: the cheapest live listing per market name
const best = new Map(); let newest = 0;
for (const p of market) {
  newest = Math.max(newest, p.updated_at || 0);
  if (p.min_price == null || !(p.min_price >= 0.01)) continue;
  const cur = best.get(p.market_hash_name);
  if (!cur || p.min_price < cur.min_price) best.set(p.market_hash_name, p);
}

// ---------------------------------------------------------------- items
const RARITY = { 'Consumer Grade': 'consumer', 'Industrial Grade': 'industrial', 'Mil-Spec Grade': 'milspec', Restricted: 'restricted', Classified: 'classified', Covert: 'covert', Extraordinary: 'extraordinary', Contraband: 'contraband' };
const RARITY_ORDER = ['consumer', 'industrial', 'milspec', 'restricted', 'classified', 'covert', 'extraordinary', 'contraband'];
const WEAR = { 'Factory New': 'FN', 'Minimal Wear': 'MW', 'Field-Tested': 'FT', 'Well-Worn': 'WW', 'Battle-Scarred': 'BS' };
const TYPE = { Knives: 'knife', Gloves: 'gloves', Rifles: 'rifle', SMGs: 'smg', Pistols: 'pistol', Heavy: 'heavy', Equipment: 'equipment' };
const TYPE_ORDER = ['knife', 'gloves', 'rifle', 'sniper', 'smg', 'pistol', 'heavy', 'equipment'];
const SNIPERS = new Set(['AWP', 'SSG 08', 'SCAR-20', 'G3SG1']);
const steamKey = u => (u.startsWith('https://community.akamai.steamstatic.com/economy/image/') ? u.slice('https://community.akamai.steamstatic.com/economy/image/'.length) : u);

const items = [];
const seen = new Set();
for (const v of variants) {
  const p = best.get(v.market_hash_name);
  if (!p || seen.has(v.id)) continue;
  const rarity = RARITY[v.rarity?.name]; if (!rarity || !v.image) continue;
  seen.add(v.id);
  const weapon = v.weapon?.name ?? '', skin = v.pattern?.name || 'Vanilla';
  const sniper = SNIPERS.has(weapon);
  items.push({
    id: v.id, name: v.market_hash_name.replace(/^★ /, ''), weapon, skin, wear: WEAR[v.wear?.name] ?? '', st: !!v.stattrak, souv: !!v.souvenir,
    type: sniper ? 'sniper' : TYPE[v.category?.name] ?? 'rifle', rarity, value: Math.max(0.01, Math.round(p.min_price * COINS_PER_USD * 100) / 100), img: steamKey(v.image), qty: p.quantity ?? 0,
  });
}
items.sort((a, b) => a.value - b.value || (a.id < b.id ? -1 : 1));
console.log(`rate ${COINS_PER_USD} coins per USD; variants ${variants.length}, priced items ${items.length}, cheapest ${items[0].value}, dearest ${items[items.length - 1].value}`);

// ---------------------------------------------------------------- the browser files
const OUT = `${ROOT}public/catalogue/`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT + 's', { recursive: true });
const SHARD = 50, shardOf = i => Math.floor(i / SHARD);
const stamp = createHash('sha256').update(items.map(i => `${i.id}:${i.value}`).join('|')).digest('hex').slice(0, 10);
const flags = i => (i.st ? 1 : 0) | (i.souv ? 2 : 0);
items.forEach((it, i) => { it.shard = shardOf(i); });
const nShards = shardOf(items.length - 1) + 1;
for (let s = 0; s < nShards; s++) writeFileSync(`${OUT}s/${s}.json`, JSON.stringify(items.slice(s * SHARD, (s + 1) * SHARD).map(i => [i.id, i.weapon, i.skin, i.wear, flags(i), RARITY_ORDER.indexOf(i.rarity), i.value, i.img, i.type])));
writeFileSync(`${OUT}index.json`, JSON.stringify({ v: stamp, rarities: RARITY_ORDER, types: TYPE_ORDER, items: items.map(i => [i.id, i.name, i.value, RARITY_ORDER.indexOf(i.rarity), i.shard, flags(i), TYPE_ORDER.indexOf(i.type)]) }));
writeFileSync(`${OUT}manifest.json`, JSON.stringify({ v: stamp, builtAt: new Date().toISOString(), priceUpdatedAt: new Date(newest * 1000).toISOString(), currency: 'USD', coinsPerUsd: COINS_PER_USD, items: items.length, shards: nShards, shardSize: SHARD,
  sources: ['ByMykel CSGO-API (skins_not_grouped.json)', 'Skinport items API (USD, lowest listing)'] }));

// ---------------------------------------------------------------- the cases
const byId = new Map(items.map(i => [i.id, i]));
const plain = items.filter(i => !i.souv && !i.st && i.value >= 0.03 && !i.img.startsWith('http'));   // cases hold plain skins (no StatTrak, no Souvenir) whose picture is on the Steam CDN
const inCat = (...t) => i => t.includes(i.type);
const re = rx => i => rx.test(i.name);
const logd = (a, b) => Math.abs(Math.log(a / b));

/** n items spread evenly (in log value) from `low` to `high`; among the candidates near each target the most traded one wins; a weapon repeats only when it must. */
function pick(filter, n, low, high, used = new Set()) {
  const pool = plain.filter(filter).filter(i => i.value >= low * 0.8 && i.value <= high * 1.25);
  if (pool.length < n) throw new Error(`pool of ${pool.length} too small for ${n} items between ${low} and ${high}`);
  const out = [], weaponCount = new Map();
  for (let k = 0; k < n; k++) {
    const target = n === 1 ? low : low * Math.pow(high / low, k / (n - 1));
    const near = pool.filter(i => !used.has(i.id) && logd(i.value, target) < 0.16).sort((a, b) => b.qty - a.qty);
    const cand = near.find(i => (weaponCount.get(i.weapon) ?? 0) < 2) ?? near[0] ?? pool.filter(i => !used.has(i.id)).sort((a, b) => logd(a.value, target) - logd(b.value, target))[0];
    out.push(cand); used.add(cand.id); weaponCount.set(cand.weapon, (weaponCount.get(cand.weapon) ?? 0) + 1);
  }
  return out;
}
const near1 = (filter, target, used) => { const c = plain.filter(filter).filter(i => !used.has(i.id)).sort((a, b) => logd(a.value, target) - logd(b.value, target) || b.qty - a.qty)[0]; used.add(c.id); return c; };

const ANY = () => true, GUNS = inCat('rifle', 'smg', 'pistol', 'heavy', 'sniper');
const SPECS = [
  { id: 'starter', name: 'Starter Crate', hue: 200, tag: 'official', items: () => pick(inCat('rifle', 'pistol', 'smg'), 10, 0.15, 35) },
  { id: 'flip', name: 'Coinflip Crate', hue: 95, tag: '50%', odds: u => [[near1(inCat('rifle', 'pistol'), 1.6, u), 0.5], [near1(inCat('pistol'), 0.12, u), 0.5]] },
  { id: 'neon', name: 'Neon Nights', hue: 300, tag: 'official', items: () => pick(re(/Neon|Neo-Noir|Hyper Beast|Cyrex|Chantico|Fade|Nuclear|Atomic|Fuel Injector|Hydroponic|Asiimov|Printstream|Bright Water|Vulcan|Cortex|Decimator/i), 11, 0.4, 160) },
  { id: 'charmed', name: 'Glove Locker', hue: 160, tag: 'official', items: () => pick(inCat('gloves'), 7, 80, 2500) },
  { id: 'sniper', name: "Sniper's Den", hue: 30, tag: 'official', items: () => pick(inCat('sniper'), 8, 0.5, 600) },
  { id: 'phantom10', name: '10% AWP', hue: 260, tag: '10%', odds: u => [[near1(i => i.weapon === 'AWP', 180, u), 0.1], [near1(i => i.weapon === 'AWP', 1.2, u), 0.3], [near1(inCat('rifle'), 0.22, u), 0.6]] },
  { id: 'blade', name: 'Blade Vault', hue: 350, tag: 'official', items: () => pick(inCat('knife'), 10, 60, 2500) },
  { id: 'high', name: 'Highroller', hue: 48, tag: 'official', items: () => pick(GUNS, 9, 8, 4000) },
  { id: 'wasteland', name: 'Wasteland Supply', hue: 28, tag: 'official', items: () => pick(re(/\b(Rust|Desert|Sand|Dune|Scorched|Safari|Copper|Oxide|Hazard|Rusty|Wasteland|Mud|Camo)\b/i), 12, 0.2, 150) },
  { id: 'gearup', name: 'Gear Up', hue: 125, tag: 'official', items: () => pick(inCat('heavy'), 10, 0.1, 80) },
  { id: 'canyon', name: 'Copper Canyon', hue: 22, tag: 'official', items: () => pick(inCat('rifle'), 9, 0.5, 250) },
  { id: 'arcade', name: 'Midnight Arcade', hue: 275, tag: 'official', items: () => pick(inCat('smg'), 10, 0.3, 200) },
  { id: 'foundry', name: 'Foundry Forge', hue: 15, tag: 'official', items: () => pick(inCat('pistol'), 11, 0.2, 300) },
  { id: 'deeptide', name: 'Deep Tide', hue: 190, tag: 'official', items: () => pick(re(/\b(Water|Ocean|Tide|Blue|Aqua|Marine|Sea|Coral|Kraken|Cobalt|Ice|Frost|Glacier|Lagoon|Cyan|Abyss)\b|Ultraviolet/i), 8, 0.3, 200) },
  { id: 'blossom', name: 'Sakura Bloom', hue: 335, tag: 'official', items: () => pick(re(/\b(Pink|Blossom|Sakura|Rose|Flower|Flowers|Floral|Orchid|Lotus|Hibiscus|Candy|Bubble|Cherry|Peony|Tulip|Sugar)\b/i), 8, 0.3, 400) },
  { id: 'relic', name: 'Relic Hunter', hue: 82, tag: 'official', items: () => pick(re(/\b(Ancient|Relic|Hieroglyph|Scarab|Pharaoh|Tomb|Temple|Aztec|Jungle|Medusa|Fossil|Ruins|Idol|Warrior|Gold)\b/i), 8, 0.3, 450) },
  { id: 'scopes', name: 'Long Range', hue: 205, tag: 'official', items: () => pick(i => i.type === 'sniper' || ['AUG', 'SG 553'].includes(i.weapon), 7, 1, 900) },
  { id: 'charmparade', name: 'Pistol Parade', hue: 312, tag: 'official', items: () => pick(inCat('pistol'), 6, 0.5, 120) },
  { id: 'heavy', name: 'Heavy Metal', hue: 220, tag: 'official', items: () => pick(i => i.type === 'heavy' || i.weapon === 'AK-47' || i.weapon === 'M4A4', 10, 3, 400) },
  { id: 'gilded', name: 'Gilded Armory', hue: 60, tag: 'official', items: () => pick(i => ['pistol', 'rifle'].includes(i.type), 9, 20, 1500) },
  { id: 'aurora', name: 'Aurora Vault', hue: 168, tag: 'official', items: () => pick(ANY, 10, 2, 2000) },
  { id: 'knifeedge', name: 'Knife Edge', hue: 355, tag: 'official', items: () => pick(inCat('knife'), 6, 90, 4000) },
  { id: 'fox33', name: '33% Redline', hue: 18, tag: '33%', odds: u => [[near1(i => i.weapon === 'AK-47' && i.skin === 'Redline', 20, u), 0.33], [near1(inCat('smg'), 0.5, u), 0.34], [near1(inCat('pistol'), 0.15, u), 0.33]] },
  { id: 'blade20', name: '20% Knife', hue: 195, tag: '20%', odds: u => [[near1(inCat('knife'), 140, u), 0.2], [near1(inCat('rifle'), 0.6, u), 0.5], [near1(inCat('pistol'), 0.2, u), 0.3]] },
  { id: 'cosmic5', name: '5% Cosmic', hue: 250, tag: '5%', odds: u => [[near1(inCat('rifle', 'sniper'), 1500, u), 0.05], [near1(inCat('pistol', 'rifle'), 4, u), 0.25], [near1(inCat('smg', 'pistol'), 0.2, u), 0.7]] },
  { id: 'daily', name: 'Daily Crate', hue: 140, reward: true, items: () => pick(inCat('rifle', 'pistol', 'smg', 'sniper'), 9, 0.1, 140) },
  { id: 'welcome', name: 'Welcome Crate', hue: 75, reward: true, items: () => pick(inCat('rifle', 'pistol', 'smg', 'sniper', 'knife'), 8, 0.25, 160) },
];
const HOUSE_CASES = 0.9;
const used = new Set();
const cases = SPECS.map(spec => {
  const entries = spec.odds ? spec.odds(used).map(([item, chance]) => ({ item, weight: chance })) : spec.items().map(item => { used.add(item.id); return { item, weight: 1 / Math.pow(item.value, 1.25) }; });
  const total = entries.reduce((s, e) => s + e.weight, 0);
  entries.forEach(e => { e.chance = e.weight / total; });
  entries.sort((a, b) => b.item.value - a.item.value);
  let t = 0;
  entries.forEach((e, i) => { const n = i === entries.length - 1 ? 100000 - t : Math.max(1, Math.round(e.chance * 100000)); e.from = t; e.to = t + n - 1; t += n; });
  const ev = entries.reduce((s, e) => s + e.chance * e.item.value, 0);
  const price = Math.round((ev / HOUSE_CASES) * 100) / 100;
  if (!(price >= 0.05 && price <= 1500)) throw new Error(`case ${spec.id} price ${price} is out of range`);
  return { id: spec.id, name: spec.name, hue: spec.hue, tag: spec.tag, reward: !!spec.reward, price, ev: Math.round(ev * 10000) / 10000, entries: entries.map(e => ({ id: e.item.id, chance: e.chance, from: e.from, to: e.to })) };
});
const caseItemIds = [...new Set(cases.flatMap(c => c.entries.map(e => e.id)))];
const caseItems = caseItemIds.map(id => { const i = byId.get(id); return { id: i.id, name: i.name, weapon: i.weapon, skin: i.skin, wear: i.wear, st: i.st, souv: i.souv, type: i.type, rarity: i.rarity, value: i.value, img: i.img }; });
mkdirSync(`${ROOT}src/catalogue`, { recursive: true });
writeFileSync(`${ROOT}src/catalogue/cases.generated.json`, JSON.stringify({ v: stamp, builtAt: new Date().toISOString(), total: items.length, items: caseItems, cases }));
for (const c of cases) console.log(`${c.id.padEnd(12)} ${c.name.padEnd(18)} price ${String(c.price).padStart(8)}  items ${c.entries.length}  top ${byId.get(c.entries[0].id).name} (${byId.get(c.entries[0].id).value})`);

// ---------------------------------------------------------------- the database files (run in order after 0013)
const MIG = `${ROOT}supabase/migrations/`;
for (const f of readdirSync(MIG)) if (/^001[45]_real_/.test(f)) rmSync(MIG + f);
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const CHUNK = 3600, chunks = Math.ceil(items.length / CHUNK);
for (let c = 0; c < chunks; c++) {
  const part = items.slice(c * CHUNK, (c + 1) * CHUNK);
  writeFileSync(`${MIG}0014_real_items_${c + 1}.sql`, `-- Vaultrush 0014 (part ${c + 1} of ${chunks}): the real Counter-Strike 2 items (id, value in coins = Skinport lowest USD listing x ${COINS_PER_USD}, rarity). GENERATED by scripts/build-catalogue.mjs: do not edit.
-- Run the parts in order (1, 2, ...), then 0015_real_cases.sql. Items already present are updated; old (invented) items are kept for the inventories that still hold them.
${c === 0 ? `
alter table public.catalog_items alter column weapon drop not null, alter column skin drop not null, alter column type drop not null;
alter table public.catalog_items drop constraint if exists catalog_items_rarity_check;
alter table public.catalog_items add constraint catalog_items_rarity_check check (rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', ${RARITY_ORDER.map(q).join(', ')}));
alter table public.catalog_items add column if not exists name text;
alter table public.catalog_items add column if not exists legacy boolean not null default false;
update public.catalog_items set legacy = true where rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic');
` : ''}
insert into public.catalog_items (id, rarity, value${c === 0 ? '' : ''}) values
${part.map(i => `  (${q(i.id)}, ${q(i.rarity)}, ${i.value})`).join(',\n')}
on conflict (id) do update set rarity = excluded.rarity, value = excluded.value, active = true;
`);
}
const names = caseItems.map(i => `  (${q(i.id)}, ${q(i.name)}, ${q(i.weapon)}, ${q(i.skin)}, ${q(i.type)})`).join(',\n');
writeFileSync(`${MIG}0015_real_cases.sql`, `-- Vaultrush 0015: the cases, made of real Counter-Strike 2 items. GENERATED by scripts/build-catalogue.mjs: do not edit.
-- Run after every 0014_real_items_*.sql. Replaces the cases and their drop tickets; prices keep a 90% return (price = expected value / 0.9).

update public.catalog_items as t set name = v.name, weapon = v.weapon, skin = v.skin, type = v.type
  from (values
${names}
  ) as v (id, name, weapon, skin, type) where t.id = v.id;

delete from public.catalog_case_entries;
delete from public.catalog_cases;
insert into public.catalog_cases (id, name, reward, price) values
${cases.map(c => `  (${q(c.id)}, ${q(c.name)}, ${c.reward}, ${c.price})`).join(',\n')};
insert into public.catalog_case_entries (case_id, item_id, ticket_from, ticket_to) values
${cases.flatMap(c => c.entries.map(e => `  (${q(c.id)}, ${q(e.id)}, ${e.from}, ${e.to})`)).join(',\n')};

-- Items the players already own: each invented item is swapped for the real item of the new cases closest in value (nobody loses value), then the invented items go.
update public.inventory i set item_id = (
    select r.id from public.catalog_items r
     where not r.legacy and r.id in (select item_id from public.catalog_case_entries)
     order by abs(ln(greatest(r.value, 0.01)) - ln(greatest(o.value, 0.01))), r.id limit 1)
  from public.catalog_items o where o.id = i.item_id and o.legacy;
delete from public.catalog_items where legacy;
`);
console.log(`wrote ${chunks} item file(s), 0015_real_cases.sql, ${nShards} browser shards, version ${stamp}`);
