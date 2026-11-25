# Live multiplayer

Added 2026-11-21. Signed-in cloud players can now play **case battles** and **coinflip** against each other, chat in a shared chat, and see each other's bets and drops. Everything is still play money.

## What is live, and what is not

| Part | Live? | How |
|---|---|---|
| Case battles | Yes | Lobbies in `live_battles`; seats, bots and the start are handled by SQL functions; every browser derives the result from the revealed seed |
| Coinflip | Yes | `live_coinflips`; the database draws the result when someone joins, or when the creator calls a house bot |
| Chat | Yes | The existing `chat_messages` table plus Supabase Realtime; the online counter uses Realtime presence |
| Bet and drop feed | Yes | Realtime broadcast between browsers (no table) |
| **Crash** and **Double** | Yes (needs `0005_rounds.sql`) | One round per game run by the database clock; every player sees the same round, everyone's bets on the right, the same result |
| Other games (plinko, mines, cases, upgrade) | Solo, as before | They have no second player |
| Daily race leaderboard | Yes (needs `0012_rewards.sql`) | The race board and yesterday's prize come from the database |
| Coin rain | Yes, since `0024` | Started by staff on the admin site's Events page, joined from the chat, split and paid by the database. The simulated rain is shown only when live games are off |

Simulated opponents, lobbies, chat lines and coin rain are shown only when live games are **off** (signed out, no cloud backend, or `0002_live.sql` not applied yet).

**Status (2026-11-21):** on the live project `0002` and `0005` (and everything up to `0016`) are applied, so signed-in players get the real lobbies and shared rounds. A test with two real people at once has **not** been confirmed (see [setup-status.md](setup-status.md)).

## Turning it on

1. Cloud accounts must already work (see [deploy-and-workflow.md](deploy-and-workflow.md)).
2. In the Supabase SQL editor, run `supabase/migrations/0002_live.sql` once, after `0001_core.sql`. It also adds the two tables to the `supabase_realtime` publication.
3. Nothing else: the site asks the server `live_ready()` after sign-in. If the call fails (migration missing, offline) it silently keeps the simulated mode.

## Shared Crash and Double rounds (0005)

The database keeps **one current round per game**. Nothing runs in the background: any browser may call `advance_round(game)` and the function does whatever the clock says is due (open the next round, start it, finish and settle it). It is idempotent and serialised per game, so it does not matter who calls it or how often. Browsers call it at the moments they expect a change (when betting ends, when a round should finish) and, during a running Crash round, every 250 ms if they hold a bet and every second otherwise; the first call that sees the crash ends the round and every other browser hears about it through realtime.

| | Crash | Double |
|---|---|---|
| Betting | 7 s | 12 s |
| Round | multiplier `e^(0.00008 x ms)` (migration 0013; it was 0.00012) until the crash point | the reel rolls for 5.2 s to the drawn tile |
| Pause | 3.5 s | 2.6 s |
| Secret | the crash point stays hidden until the crash instant (the seed is revealed when the round is finished) | the tile is revealed when betting closes, since nobody can bet any more |
| Bets | one per player; optional auto cash-out | several lanes per player, but not purple with gray; repeating a lane adds to it |
| Cash-out | requested by the player, timed by the **server clock** (the multiplier is the server's, not the browser's); partial shares like before (7 at most) | n/a |
| Auto cash-out | applied by the server at the crash if the target is below the crash point | n/a |

Fairness: the seed hash is public from the round's creation; `float = HMAC-SHA256(seed, "<round id>:0:0") / 2^32`; crash point `min(10000, max(1, floor(97 / (1 - f)) / 100))`; double tile `floor(f x 15)`. `tests/rounds-db.test.ts` recomputes both from the revealed seed.

**Money.** As with battles and coinflip, stakes and payouts are handled by the browser. The server records the bets and computes what each is worth (`round_bets.locked`). A browser pays itself the difference between what the server says and what it has already been paid (`state.liveCredit`, per bet id), so repeated or stale updates never pay twice and a reload catches up (`reconcileAll`). Leaving the Crash page takes back a bet that has not started or cashes out a running one; leaving Double with bets in the round follows the round in the background (`settleLater`) so it is paid when it ends.

**What is still simulated here:** the Triple Green pool in Double (it still creeps up locally) and the history of rounds before you arrived (loaded from the database when available). Without `0005`, or when signed out, Crash and Double fall back to the earlier solo rounds with simulated players.

> **Update 2026-11-21:** with migrations 0008 to 0012 the server now holds the stakes and pays the winners for every game, so the browser-side payout bookkeeping described in this section no longer applies once the server wallet is on. See [server-wallet.md](server-wallet.md). The text below describes the earlier play-money design that the page still falls back to without the wallet migrations.

## Trust model (read this before relying on it)

- **The server decides the shared random result.** Each battle or coinflip gets a secret seed when it is created; only its SHA-256 hash is public. The seed is revealed when the game starts (battle full, coinflip joined), and anyone can recompute the result: `HMAC-SHA256(seed, "<clientSeed>:0:<round>")` for battles (same as `src/fair.ts`), `HMAC-SHA256(seed, "<id>:0:0")` for coinflip. The creator cannot see the seed, and it exists before anyone joins, so nobody can choose it.
- **Stakes.** With the server wallet (every cloud account, since `0011_live_wallet.sql`) the database takes each stake and pays the winners inside the same transaction, so nobody can edit a balance. The rest of this point describes the browser-only fallback: coins live in each browser's storage. A browser takes its own stake when it creates or joins, and pays itself the winnings once the result is known. `state.liveSettled` remembers which games were already paid or refunded, so a reload or a duplicate realtime event never pays twice, and `reconcileAll()` (run after sign-in) settles games that finished while the tab was closed.
- In that browser-only fallback a determined player can edit their own balance. With the server wallet they cannot: the database holds every balance.
- Responsible-gambling limits (max bet, loss limits, wager and play-time limits, self-exclusion, cool-off, age) apply at the moment of staking: with the server wallet on, every stake passes `wallet_gate()` in the database (see [compliance.md](compliance.md)); in the browser-only fallback `debit()` checks them.
- Bots in a battle are "called" by the creator through `call_live_bot()`. Bots play for the house: if a bot wins, the pot is gone.

## Rules enforced by the database

Tested in `tests/live-db.test.ts` (runs the real SQL in PGlite):

- Only signed-in players with a profile can call the live functions; helpers are private; the tables cannot be written directly; the secrets tables and seeds are unreadable until the game starts.
- Battle: 1 to 20 case ids, a known format and mode (team formats allow only normal, crazy, terminal), at most 3 open battles per player (a game setting since `0025`), a seat can be taken once, only the creator may call bots (and only when bots are switched on, with a listed bot name, since `0025`), the creator leaving cancels the battle, a joiner leaving frees the seat, nobody can leave after the start, and a lobby older than 30 minutes (a game setting since `0025`) cannot be joined.
- Coinflip: bolt or star, 0.10 to 50,000 (the verification cap decides: 10,000 for a new account, see [compliance.md](compliance.md)), at most 5 open games, you cannot join your own game, only the creator can cancel and only while nobody joined, 30-minute expiry.
- Coinflip bot (`0004`): the creator of a waiting game can call a house bot (`call_live_coinflip_bot`). The server draws the result with the same seed maths; if the bot's side wins, `winner` stays empty and nobody is paid (the house keeps the pot). Only the creator can call it, only while the game is waiting.

## Client files

| File | Role |
|---|---|
| `src/live.ts` | Data layer: RPC wrappers, realtime watchers, presence and broadcast, settle-once helpers, the reconcile registry |
| `src/rounds.ts` | Shared Crash and Double rounds: server-aligned clock, `advanceRound`, bet and cash-out calls, realtime watchers, `payBet` (pay once), `settleLater` |
| `src/views/crash.ts`, `src/views/double.ts` | `LIVE` branch: the round, the bets and the result come from the server; the solo version remains as the fallback |
| `src/views/coinflip.ts` | `LIVE` branch: lobby from the server, `upsert()` applies each server row, stake and payout handling |
| `src/views/battles.ts` | `renderLiveBattle()` loads a battle by id, `drawBattle()` is the shared view, `toBattle()`/`resolveLive()` derive the result, `b.onRow()` follows the server |
| `src/chat.ts` | Swaps the simulated chat for the real one when `live` turns on |
| `src/feed.ts` | Sends my bets and drops, shows other players' (validated) |
| `src/auth.ts` | Calls `initLive(userId)` after sign-in and `stopLive()` after sign-out |

`isLive()` is synchronous. Pages are drawn first in simulated mode and redrawn when the `live` event arrives (about a second after sign-in).

## Known limits

- Tested with a fake server in `tests/live-client.test.ts` and `tests/live-battles.test.ts`, and the SQL in PGlite. The owner has since played with two real people at once on the live project (confirmed 2026-11-22); there is still no automated test against a real Supabase project.
- Chat messages carry the profile name, so Anonymous mode cannot hide it; chatting while Anonymous is on shows an explanation instead of sending.
- A waiting game is cancelled and refunded when its creator leaves the page. If the tab is closed instead, the next sign-in cancels and refunds it (or pays it, if someone joined meanwhile).
- The browser that stakes can disappear before the server confirms; in that rare case the stake can be lost or, for a refund, delayed to the next sign-in.
- Realtime events for other players' bets are trusted for display only (validated, never counted as the viewer's money).
