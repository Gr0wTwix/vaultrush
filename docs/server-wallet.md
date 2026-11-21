# The server wallet (built 2026-11-21)

From this change on, **coins and items live in the database, not in the browser**, for every game. The page asks, the database decides, the answer comes back with the new balance. Nothing in the browser can add a coin or an item: editing the page or its storage only changes a copy that the next sync puts right.

It is for **play money**. No deposits or withdrawals exist. The design keeps real money possible later (one ledger, one place that moves coins), but that needs a legal review first.

## What moved to the server

| Area | What the database now does |
|---|---|
| **Wallet** | One balance per player (`wallets.balance`, never below 0), a ledger row for every movement (`ledger`, with `balance_after`), items in `inventory`. New accounts start with **0 coins**. |
| **Cases** | Opens 1 to 10 cases: checks the site switch and the responsible-play gate, takes the price, draws each ticket from the player's secret seed, puts the items in the inventory. |
| **Upgrade** | Checks the staked items are yours (at most 4), takes them and any coins, draws the roll, gives the target on a win. Chance = 95% x stake / target, at most 80%. |
| **Plinko** | Takes the stake, draws the ball's path (one float per row), pays the multiplier. The multiplier tables are computed in SQL and equal `plinkoTable()` in the browser. |
| **Mines** | Starts a game (bombs drawn from the seed and kept secret), reveals one tile per call, cashes out at the server multiplier. One game at a time; a reload or another device resumes it; a game left a day is settled for the player. |
| **Coinflip** | Stake when created or joined, the winner is paid 1.94x the stake the moment the second player (or a house bot) is in. |
| **Battles** | Cost of all cases at create and join. When the last seat fills, the database draws every pull from the battle's seed, decides the winners (all seven modes, solo and team formats) and pays them the pot, the total value pulled by everyone. Bots play for the house. |
| **Crash and Double** | Stake at the bet, cash-outs paid at once (server clock), auto cash-outs and winning lanes paid when the round ends. |
| **Rewards** | The free-coins faucet (25 every 10 minutes), rakeback (0.4% instant, 0.3% daily, 0.3% weekly of every stake), the login calendar, promo codes (table `promo_codes`), the welcome / daily / level crates, and the daily race prize for yesterday's top 10. |
| **Selling** | Items sell for their catalogue value; the database checks they are yours and not sold already. |
| **History and race** | Every finished game writes a row to `bets` (amount, payout, result), so the account history, the XP and the daily race all come from one place. |

Leaving never traps coins: cancelling a coinflip, leaving a battle that has not started (the creator cancels it for everyone), cancelling a crash bet before the round, and cancelling a mines game before the first tile all refund the stake. A lobby left waiting for 30 minutes is closed and refunded.

## How a game works inside the database

Every game function runs in **one transaction**: site switch (`site_guard`), responsible-play gate (`wallet_gate`: age, self-exclusion, cool-off, maximum bet, verification-tier cap 1,000 / 2,500 / 5,000, daily loss limit), draw the result from the secret seed (`fair_draw`), write the bet, move the coins and items. If anything fails, everything is undone: a stake is never taken without a result and a result is never given without a stake. Players have no write access to any money table; the helper functions (`wallet_debit`, `wallet_credit`, `inventory_add`, `bet_record`, `fair_draw`) cannot be called by clients at all.

Provable fairness is unchanged in principle: the seed's hash is committed first, `rotate_seed` reveals it, and each result is `HMAC-SHA256(serverSeed, "clientSeed:nonce:round")`. The Account window's **Cloud account** tab lists the latest bets of every game and re-checks the ones made from the player's own seed (Cases, Upgrade, Plinko, Mines, the Crash demo) with the same code as the Fairness page. Battles, Coinflip, Crash and Double rounds use the game's own seed, shown on that game.

## How the page uses it

| File | Role |
|---|---|
| `src/wallet.ts` | Switches the server wallet on (`wallet_ready()`), loads the snapshot (`wallet_me`), keeps it fresh (realtime on `wallets` and `inventory`, a 20-second poll, on tab focus), wraps every call that moves coins or items. |
| `src/state.ts` | While the server wallet is on, `credit`, `grant`, `addItems` and `removeItems` change **nothing**, and `debit` only refuses what cannot be afforded. This is the safety net: even a forgotten code path cannot mint. |
| `src/battle-math.ts` | The winner rules of every battle mode, shared by the page and the tests; `battle_outcome` in SQL is a port of it and the tests compare the two on real draws. |
| `src/server-bets.ts` | Maps a bet the database made to the browser verifier's inputs. |

**Revealing a payout at the right moment.** When a result is known before its animation ends (a plinko ball, a coinflip, a battle), the shown balance leaves the payout out until the animation is over: `holdPayout` / `freezeBalance`, released by `credit()` or when the reels stop. A hold that is never released ends by itself after two minutes.

**Fallback.** The page uses the server wallet only when `wallet_ready()` answers true, which migration 0012 creates last. Browser-only accounts and a database that has not been migrated keep the old browser-side behaviour.

## Setting it up (you do this)

Run these in the Supabase SQL editor, in order, after 0007 (each is one paste):

1. `0008_wallet.sql` (wallet, inventory, catalogue tables, money helpers; new accounts start at 0)
2. `0009_catalogue.sql` (the cases and items; **generated**, see below)
3. `0010_solo_games.sql` (Cases, Upgrade, Plinko, Mines)
4. `0011_live_wallet.sql` (Coinflip, Battles, Crash, Double use the wallet). It **closes every game that was waiting or running** and deletes undecided round bets, **without refunds**: their stakes were in browsers, not in the database.
5. `0012_rewards.sql` (rewards, race, and the switch)
6. `0013_crash_pace.sql` (a slower Crash: 2x after 8.7 s instead of 5.8 s; deploy the site right after, the page and the database must share the pace)

Then redeploy the game site. Existing browser coins are **not** migrated (your decision). Existing cloud accounts keep the server balance they had (100 from sign-up); new accounts start at 0 and earn from the faucet, crates, rewards and promo codes. To change a balance, use SQL for now: the owner wallet adjustment and the ledger viewer are part of the admin plan (step D, admin side) and are not built yet.

### Giving coins to an account (until the admin wallet tool exists)

Players cannot change a balance; the owner can, in the Supabase SQL editor (it runs with full rights). Replace `YOUR_NAME` with the player's name on the site (not case sensitive). Both statements write an `adjustment` line to the ledger, so the ledger still adds up to the wallet. They are tested in `tests/wallet-db.test.ts`.

Add an amount:

```sql
with me as (select id from public.profiles where lower(display_name) = lower('YOUR_NAME')),
  upd as (update public.wallets w set balance = w.balance + 100000, updated_at = now() from me where w.user_id = me.id returning w.user_id, w.balance)
insert into public.ledger (user_id, kind, amount, balance_after) select user_id, 'adjustment', 100000, balance from upd;
```

Set an exact balance:

```sql
with me as (select id from public.profiles where lower(display_name) = lower('YOUR_NAME')),
  cur as (select w.user_id, w.balance from public.wallets w join me on me.id = w.user_id),
  upd as (update public.wallets w set balance = 5000, updated_at = now() from cur where w.user_id = cur.user_id returning w.user_id, w.balance, cur.balance as before)
insert into public.ledger (user_id, kind, amount, balance_after) select user_id, 'adjustment', balance - before, balance from upd;
```

The page shows the new balance within moments (realtime) or at the next 20-second sync. A name that does not exist changes nothing. A single bet is still limited by the verification tier (1,000 / 2,500 / 5,000), whatever the balance. The other way is a promo code of any size: `insert into public.promo_codes (code, amount) values ('MYCODE', 100000);`, then redeem it on the Rewards page (once per player).

### The catalogue

`0009_catalogue.sql` is generated from `src/data.ts` by `npm run gen:catalogue`. The tests check the database copy equals `src/data.ts` (every item value, every price, every ticket range, all 100,000 tickets covered). Prices keep a 90% return. **If you change `src/data.ts`, run `npm run gen:catalogue` and run the new file again.** The admin catalogue editor (step C) will replace this by editing the tables directly.

## What is still simplified

- **Responsible-play limits.** The database enforces age, self-exclusion, cool-off, the maximum bet, the verification-tier cap and the daily loss limit. The weekly and monthly loss limits, the daily wager limit and the time limit that the page offers are still only checked in the page; moving them to the database belongs to the compliance step (F).
- **Triple Green** in Double is a simulated pot: with the server wallet it pays nothing (a toast says so). Coin rain in chat is not shown next to real players.
- **Bots** in Battles and the Coinflip bot play for the house, as before.
- **Owner tools** for the wallet (adjustments, ledger viewer, per-player balance) are not built yet.

## Tests

| File | What it proves |
|---|---|
| `tests/wallet-db.test.ts` (37) | New accounts start at 0; nobody can touch money or items directly; the catalogue equals `src/data.ts`; every game's math equals the browser's (case tickets, upgrade chance, plinko tables, mines multiplier and bomb positions); results are recomputable from the revealed seed; refusals change nothing; the gate and the site switches hold. |
| `tests/wallet-live-db.test.ts` (30) | Coinflip, Battles (all 7 modes and 6 formats against `battle-math.ts` on real draws), Crash and Double take stakes and pay; leaving refunds; the rewards are the only source of free coins; **a ledger replays to the wallet**. |
| `tests/wallet-client.test.ts` (25) | The page mirrors the server, mints nothing, holds payouts until the animation ends, never lets an old poll overwrite a newer answer; Cases, Inventory and Rewards ask the server. |
| `tests/wallet-live-client.test.ts` (7) | Coinflip and Battles show the stake at once and a win only when the animation ends. |
