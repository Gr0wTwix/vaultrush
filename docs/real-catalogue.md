# The real item catalogue (Counter-Strike 2)

The items in the cases, the Upgrade page, the inventory and the live feed are the real Counter-Strike 2 weapon skins, knives and gloves: real names, grades, wear levels and pictures, with a price in coins. They replace the invented items the site started with. The coins are still play money.

**Status (2026-11-21):** deployed. `0014_real_items_1..5.sql` and `0015_real_cases.sql` have been run on the live project (owner confirmed) and the page is live; the case pictures and the home tile are in too. Open points: pictures are hotlinked from Valve's servers and the free-coin amounts were not rescaled (see [setup-status.md](setup-status.md)).

## Where the data comes from

| What | Source | Notes |
|---|---|---|
| Names, grade, wear, StatTrak / Souvenir, weapon type, picture | ByMykel's CSGO-API, `skins_not_grouped.json` | The code is MIT licensed; the names, pictures and trademarks belong to Valve |
| Price | Skinport's public items API, lowest listing in **USD** (`min_price`) | No key; one request returns everything; cached 5 minutes; 8 requests per 5 minutes; Brotli required |
| Picture files | Valve's community image servers, hotlinked | Steam's `/256fx192f` suffix returns a 256 x 192 picture (about 30 KB) instead of the default 512 x 384 |

The two lists are joined on `market_hash_name`. An item with no Skinport listing has no price and is left out (14,411 of about 22,600 variants are priced). When two Skinport entries share a name (Doppler phases), the cheapest listing is used. About 650 items (mostly newer knives) have pictures that are not on Steam's servers but in ByMykel's image repository on GitHub; they work in the Upgrade list but no case holds one.

## Coins and prices (how the rate was chosen)

An item's value in coins = **its lowest Skinport price in USD x 1.64**.

The 1.64 comes from what comparable sites pay for a credit-card deposit (read from screenshots of their deposit pages): one site pays **1.61 coins per $1** ($5 gives 8.05), another **1.666 per $1** ($5 gives 8.33); a third pays 1 coin per $1 plus a 40% bonus (1.4); the fourth pays 20 "gold coins" per $1 plus a separate bonus currency, which does not compare. The two exact quotes average **1.64**. Their item prices were also compared with Skinport's: across 36 items the median was about **1.8 to 1.9 coins per Skinport dollar** (the spread is wide, 0.5 to 4.4, because those sites price from their own sources), so a coin on those sites buys roughly $0.55 to $0.6 of items. Pricing items at 1.64 per dollar is the parity point: a deposit would buy exactly the Skinport value of what it is spent on.

Nothing here can be bought: Vaultrush has no deposit. The rate only sets the scale of item prices. To change it: `npm run build:catalogue -- --rate=1.9` (or edit `COINS_PER_USD` in the script), then run the new SQL files (below). Case **prices** follow by themselves (price = expected value / 0.9, so every case still returns 90%), but the case **contents** are chosen by value bands written in coins in the script, so a higher rate means cheaper real skins in the same case.

Free coins (the 10-minute faucet, calendar, promo codes, rakeback) were not changed: at 1.64 coins per dollar a coin buys less than when items were 1 EUR per coin, so check that the free coins still feel right.

## What is bundled and what is loaded on demand

- **Bundled with the page** (`src/catalogue/cases.generated.json`, about 90 KB): the 27 cases, their drop tables (tickets out of 100,000, price, expected value) and the 166 items inside them.
- **Loaded on demand** (`public/catalogue/`, about 6 MB of static files, none of it fetched until needed): `index.json` (one short row per item: id, name, value, grade, file, flags, weapon type; searched in the browser) and `s/<n>.json` (the items themselves, 50 per file, cheapest first, so a page of "items worth a bit more than your stake" needs one or two files). `manifest.json` records the build time, the price time, the rate and the sources.
- `src/catalogue.ts` is the loader: `loadIndex`, `queryItems` (search, grade and weapon filters, min and max value, sort, paging), `ensureItems` (fetch the items an inventory holds that are not bundled, never throws), `cheapestAtLeast` (the 2x / 5x / 10x buttons).
- The Upgrade page searches all 14,411 skins; inventory items that came from an upgrade are fetched when the inventory loads. Until an item arrives it is shown as a greyed-out "Loading..." card with no value.

## The database

`supabase/migrations/0014_real_items_1.sql` ... `_5.sql` (all items: id, grade, value in coins) and `0015_real_cases.sql` (names for the case items, the 27 cases and their tickets) are **generated**; do not edit them. Run them **in order after 0013**, one paste each (about 165 KB each for the items).

Existing players are not left with invented items: 0015 swaps every old inventory item for the real item **of the new cases closest in value** (nobody loses value), then deletes the invented items. Browser-only saves (no cloud account) simply drop old items. Running the files again is safe and is how a **price refresh** works: it updates every value and rebuilds the cases; inventories are untouched.

## Refreshing prices

```powershell
npm run build:catalogue          # downloads both lists (cached 4 minutes in .cache/), rewrites public/catalogue, src/catalogue, the SQL
npm run build:catalogue -- --offline   # reuse the last download
```

Then commit, deploy the site, and run the new SQL files in order. The page and the database should be updated together: a case whose price or tickets differ between them is refused or priced differently. The tests check the bundled cases against the database copy (every item value, price and ticket range) and the index against the item files.

## Things to know

- **Terms and brands.** Names and pictures are Valve's, and Skinport's prices are public listings. The footer, Terms and Disclaimer say so and that nothing can be bought, sold or withdrawn. Hotlinking Steam's image servers is common but not guaranteed; if it must be safe, mirror the pictures (about 430 MB for everything, far less for the cases and Upgrade) into your own storage, where the terms of use allow it.
- **Rarity.** Grades are CS2's (Consumer ... Contraband) with the game's colours. A big celebration on a drop needs Covert or higher and a win of at least 5x the price, or Extraordinary / Contraband.
- **Prices move.** Values are a snapshot (`manifest.json` has the time). A 5-minute-old Skinport price is as fresh as the API gives.
- **Lowest listing is not "worth".** Rare or low-volume items can have a thin or odd lowest listing; the loader keeps it as is and an item with no listing has no price.
- **Pictures of the cases** are separate from the item pictures: `public/assets/cases/<case id>.webp` (one per case, 640 x 640, transparent) and the home page tiles in `public/assets/home/`; see [architecture.md](architecture.md) (Assets).
