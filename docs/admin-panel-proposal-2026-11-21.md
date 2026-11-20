# Admin panel: what it could hold (proposal for approval)

> **Status 2026-11-21:** the owner approved the plan (sections 13 to 19). **Step A is built** (admin site shell, roles, permissions, audit log, explorer): see [admin-site.md](admin-site.md). Steps B to G are not built.

Written 2026-11-21. **Nothing in this document is built.** It is the analysis you asked for: everything an admin panel for Vaultrush could contain, grounded in what the site really stores today, with example screens, effort sizes, risks and a list of decisions for you to approve or reject. When you answer the questions in section 11, I build exactly that and nothing else.

Sources used: Vaultrush's own code and database (5 migrations, 16 tables, 5 views, 3 Edge Function folders), the three reference sites observed on 2026-11-20 (see [competitor-live-analysis-2026-11-21.md](competitor-live-analysis-2026-11-21.md)), and their legal pages.

---

## 1. Summary

1. **A useful admin panel is mostly safety and visibility, not buttons that change money.** The highest-value parts are: seeing what is happening live, moderating chat, controlling games and lobbies, switching things off safely, and a trustworthy record of every admin action.
2. **The biggest constraint is where the coins live.** Today only the server-side Crash demo bet has a server wallet. For every other game, balance, items, history, limits and verification state live in each player's browser. **An admin cannot see or change those.** So roughly a third of the panel an operator would normally expect (wallet adjustments, inventory edits, forced limits, per-player P&L for all games) is blocked until the wallet moves to the database (section 3).
3. **Everything else is buildable now** on the data that already exists: accounts, chat, live battles, coinflips, shared Crash/Double rounds, server-recorded bets, free-claim records.
4. **Security comes first and is not optional:** a role table, MFA required, every admin action performed by a checked database function, and an append-only audit log. The powerful "service" key never goes into the website (section 4).
5. I propose **6 phases**. Phase 0 and 1 (foundation, moderation and live control) are the ones worth approving first. Section 9 gives sizes; section 11 gives the questions.

**Sizes used below** (my working time, rough): **S** 1 to 2 hours, **M** about half a day, **L** 1 to 2 days, **XL** several days. They include tests and documentation.

---

## 2. Module index

Status: **Ready** = data already exists on the server. **New tables** = needs new tables and functions but no change to the architecture. **Wallet** = blocked until coins and inventory live in the database. **Content** = blocked until the case and item catalogue moves from code into the database.

| # | Module | Status | Size | Phase |
|---|---|---|---|---|
| 1 | Admin access, roles, MFA | New tables | M | 0 |
| 2 | Audit log and security center | New tables | M | 0 |
| 3 | Live dashboard | Ready (partly) | M | 1 |
| 4 | Players (list, profile, notes, tags) | Ready | M | 1 |
| 5 | Account actions (mute, ban, force sign-out, rename) | New tables | M | 1 |
| 6 | Chat moderation | Ready + new tables | M | 1 |
| 7 | Live rooms monitor (battles, coinflips) | Ready | M | 1 |
| 8 | Round control (Crash, Double) | Ready | M | 1 |
| 9 | Maintenance, global notice, game switches | New tables | M | 1 |
| 10 | Server-recorded bets and ledger viewer | Ready | S | 2 |
| 11 | Server wallet adjustments | Ready for the server wallet only | S | 2 |
| 12 | Responsible-gambling console | Partly (server limits only) | M | 2 |
| 13 | Compliance (sandbox KYC and AML queues) | Wallet | M | 2 |
| 14 | Fairness and RNG audit | Ready | M | 2 |
| 15 | Rewards, promo codes, free claims | New tables | M | 3 |
| 16 | Races and leaderboards | New tables | M | 3 |
| 17 | Rain and giveaways | New tables | L | 3 |
| 18 | Game configuration (limits, timings, house edge) | New tables | M | 3 |
| 19 | Case and item catalogue editor | Content | XL | 4 |
| 20 | Bots management | New tables | S | 3 |
| 21 | Economy monitor (sources, sinks, inflation, whales) | Wallet | L | 4 |
| 22 | Abuse and risk signals | New tables | L | 4 |
| 23 | Announcements and notifications | New tables | M | 3 |
| 24 | Support inbox | New tables | L | 5 |
| 25 | Legal pages, terms versions, privacy requests | New tables | M | 5 |
| 26 | Analytics and reports | Ready (partly) | L | 4 |
| 27 | System health and operations | Ready (partly) | M | 5 |
| 28 | Developer and QA tools | New tables | M | 5 |

---

## 3. What an admin can reach today (data ownership map)

This table decides what is possible. "Server" means in the Supabase database. "Browser" means in the player's own browser storage (`localStorage`), which no admin can read.

| Data | Where it lives | Admin can see it? | Admin can change it? |
|---|---|---|---|
| Account, display name, adult confirmation, terms version | Server (`profiles`) | Yes | Name and closure through new functions |
| Sign-in identity (email, Google or Steam id) | Supabase Auth (`auth.users`) | Only through a service-role Edge Function, with audit | Ban a login through the existing `close-login` function |
| Server wallet, ledger, server bets (Crash demo bet) | Server (`wallets`, `ledger`, `bets`) | Yes | Yes, through audited adjustments |
| Chat messages | Server (`chat_messages`) | Yes | Delete (new function), mute (new table) |
| Live battles and coinflips (lobbies, seats, results) | Server (`live_battles`, `live_coinflips`) | Yes | Cancel, remove a seat (new functions) |
| Shared Crash and Double rounds and bets | Server (`game_rounds`, `round_bets`) | Yes | Pause games, void a round (new functions) |
| Free claims (welcome crate, daily crate) | Server (`free_claims`) | Yes | Reset a claim (new function) |
| Server-side limits and exclusion (for the Crash demo bet) | Server (`account_controls`, `limit_changes`) | Yes | Tighten yes; loosening is deliberately delayed 24 h |
| **Coin balance for every other game** | **Browser** (`state.balance`) | **No** | **No** |
| **Inventory (items), history, XP and level, rakeback, calendar, promo use** | **Browser** | **No** | **No** |
| **Responsible-gambling limits, cool-off, self-exclusion for normal play** | **Browser** (`state.rg`) | **No** | **No** (a determined player can edit them) |
| **Sandbox KYC and AML state** | **Browser** (`state.kyc`, `state.aml`) | **No** | **No** |
| Case and item catalogue (25 cases, 2 reward cases, 73 items), odds, prices | **Code** (`src/data.ts`) | Only by reading the code | Only by deploying new code |
| Economy numbers (house edges, free coins, rakeback, tiers, promo codes, timings) | **Code** (constants) | Only by reading the code | Only by deploying new code |
| Bot names | Code | n/a | Deploy |
| Page views, sessions, errors | Nowhere (no analytics by design) | No | n/a |

### The wallet decision (this unlocks or blocks about a third of the panel)

| Option | What it means | Panel features it unlocks | Cost |
|---|---|---|---|
| **A. Observe only** | Keep coins in the browser. The panel covers accounts, chat, live rooms, rounds, server-recorded bets, claims, config, moderation. | Phases 0 to 3 | None extra |
| **B. Server balance for live and shared games only** | Add a server balance used by battles, coinflip, Crash and Double; other games stay local. Two balances would confuse players unless merged. | Wallet adjustments and real P&L for the live games | L to XL |
| **C. Full server wallet** | Every game debits and credits in the database (the stake taken inside the same transaction as the result). Browser edits become impossible. | Everything in the index, including economy monitor, abuse signals, forced limits, KYC queue, inventory edits | XL, touches every game |

**Recommendation:** approve phases 0 to 3 under option A now, and decide on option C separately. Option C is the honest foundation for an economy monitor, but it is a project of its own and changes how all games work.

---

## 4. Security design (applies to every module)

1. **Roles in the database, not in the browser.** A table `admin_roles (user_id, role, granted_by, granted_at)`. The panel is only shown if the signed-in player has a role; the database refuses everything else even if someone opens the URL.
2. **Every action is a checked function.** Admin buttons call `security definer` functions that first check `has_role(...)`, then do the work, then write the audit row in the same transaction. There is no generic "run any SQL" and no admin write access to tables.
3. **The service-role key never goes into the website, the repository or the browser.** The few things that need it (reading emails from Supabase Auth, banning a login) stay in Edge Functions that check the caller's role and write the audit log.
4. **MFA required.** The site already supports TOTP. Admin functions refuse a session that has not completed two-factor sign-in (the session level is available as `aal2`).
5. **Append-only audit log.** `admin_audit_log` (who, role, action, target, before, after, reason, time). No update or delete is granted to anyone, including admins. Viewing personal data is logged as an action too.
6. **Reasons are mandatory** for sanctions, adjustments, and config changes. The reason is stored and shown to the other admins.
7. **Four-eyes for the riskiest actions** (changing house edge, granting the admin role, mass actions affecting more than N players, voiding a round with bets): a second admin must approve. For a one-person team this can be switched to "confirm with a typed phrase".
8. **Least data.** Moderators see names and chat, not e-mail addresses. Only the owner and compliance roles can reveal an address, and each reveal is logged.
9. **Rate limits and lockouts** on the admin functions; new-admin cooling period; session timeout (for example 30 minutes idle).
10. **Privacy text must match.** If admins can see personal data, the Privacy Policy must say who, why and that access is logged. I would update it with the panel.
11. **No real-money functions.** The panel will not contain deposits, withdrawals, payment providers or anything that moves value outside the demo (the project's ground rule).
12. **Not linked from the public site.** The route is unlisted; it still is protected by roles, not by obscurity.

### Roles

| Role | For | Can do |
|---|---|---|
| Owner | You | Everything, including granting roles, config, and revealing personal data |
| Admin | Trusted operator | Everything except granting roles and changing security settings |
| Moderator | Chat and community helpers | Chat tools, mute, warn, view live rooms, cancel a stuck lobby; sees names only |
| Support | Helpers answering players | Read player profile and history, notes, reset a free claim, open a support ticket |
| Compliance | Whoever handles RG and sandbox KYC/AML | RG console, compliance queues, exports; sees personal data when needed |
| Analyst | Reporting | Read-only dashboards and exports, no personal data |
| Read-only | Auditor or a friend watching | Read-only everything non-personal |

Permission grid (X = allowed):

| Area | Owner | Admin | Moderator | Support | Compliance | Analyst | Read-only |
|---|---|---|---|---|---|---|---|
| Dashboard | X | X | X | X | X | X | X |
| Players (names, status) | X | X | X | X | X | X | X |
| Player personal data (e-mail) | X | | | | X | | |
| Mute, warn | X | X | X | X | X | | |
| Ban, force sign-out | X | X | | | X | | |
| Chat tools | X | X | X | | | | |
| Live rooms (view) | X | X | X | X | X | X | X |
| Live rooms (cancel, void) | X | X | X | | | | |
| Maintenance, game switches | X | X | | | | | |
| Config and house edge | X | X | | | | | |
| Wallet adjustments | X | X | | | X | | |
| RG console (apply and tighten) | X | X | | | X | | |
| Announcements | X | X | X | | | | |
| Roles and security | X | | | | | | |
| Audit log (read) | X | X | | | X | | X |
| Exports | X | X | | | X | X | |

---

## 5. The modules in detail

Each module lists: **Shows**, **Actions**, **Data**, **Today**, **Size**, **Notes**.

### Phase 0: foundation

#### 1. Admin access, roles and MFA
- **Shows:** who has which role, when it was granted and by whom, last sign-in, whether MFA is on.
- **Actions:** grant or revoke a role (owner only, with confirmation and a second admin if there is one), require MFA, force a session to end.
- **Data:** new table `admin_roles`; function `has_role(role)`; RLS helper used by every other module.
- **Today:** New tables. **Size:** M.
- **Notes:** first admin is created by a one-time SQL statement run by you in the Supabase editor (so nobody can promote themselves).

#### 2. Audit log and security center
- **Shows:** a searchable, filterable list of every admin action (who, what, to whom, before and after, reason, time); admin sign-ins; failed attempts; a red banner for unusual activity (many sanctions in a short time, role change, config change at night).
- **Actions:** export; pin an entry; nothing can be edited or deleted.
- **Data:** new table `admin_audit_log` (append-only; no update or delete grant); written by every other module's functions.
- **Today:** New tables. **Size:** M (the table is small; every other module has to call it).

### Phase 1: visibility, moderation and live control

#### 3. Live dashboard
- **Shows:** players online (from realtime presence), signed-in vs guests, bets per minute, open battles and coinflips, current Crash and Double round (phase, countdown, bets and total staked), chat messages per minute, new accounts today, errors in the last hour, Supabase usage against plan limits (connections, messages per second) with a warning near 70 percent, which migrations are applied.
- **Actions:** jump to the relevant module from every tile.
- **Data:** existing tables and presence; a few new counter views; the limits table from the competitor analysis (Free: 200 connections, 100 messages per second).
- **Today:** Ready (partly: page views and errors need a small events table). **Size:** M.

#### 4. Players
- **Shows (list):** name, created, last seen, status (active, muted, banned, self-excluded, closed), signed-in method, server-recorded bets, last chat message, flags. Search by name or id; filter by status and flag.
- **Shows (profile):** account facts; **server** wallet and ledger; server bets; chat history; shared-round and live-game history; free claims taken; notes from other admins; every admin action ever taken on this player; linked evidence (same Steam id used twice is impossible; see module 22 for signals).
- **Actions:** add a note, add or remove a tag (VIP, watch, friend, tester), open the actions menu (module 5), open the player's chat.
- **Data:** `profiles`, `wallets`, `ledger`, `bets`, `chat_messages`, `live_*`, `round_bets`, `free_claims`, new `player_notes`, `player_tags`.
- **Today:** Ready. **Size:** M.
- **Not available until the wallet decision:** coin balance for other games, inventory, XP, history of solo games.

#### 5. Account actions
- **Actions:** mute in chat (duration), warn (shows a message to the player at next sign-in), **ban from betting** (live games and shared rounds refuse the player), ban from the site (disables the login through `close-login`), force sign-out everywhere, reset display name (rule violations), reset a free claim, close and anonymise an account on request, lift any of the above.
- **Rules:** every action needs a reason, is reversible except closure, and is shown on the player's profile and in the audit log. A temporary action expires by itself.
- **Data:** new table `account_flags (user_id, kind, until, reason, by, at)`; the live and round functions check it; chat insert checks mutes.
- **Today:** New tables. **Size:** M.
- **Limit:** a ban cannot stop a browser from playing the **solo** games with the coins it holds. It stops everything that goes through the server.

#### 6. Chat moderation
- **Shows:** the live chat stream (with hidden-name toggle for moderators), a report queue (players flag a message), search by word or player, recently deleted messages.
- **Actions:** delete a message (shows "message removed" like the reference sites' `chat.delete`), mute the sender, slow mode (one message per N seconds), emoji-only or locked chat (temporary), word and link filter (block list and allow list), pin a message, post a staff message, clear the room.
- **Data:** `chat_messages` plus new `chat_reports`, `chat_rules` (word filter, slow mode), `chat_deleted` fields (removed_by, removed_at).
- **Today:** Ready + new tables. **Size:** M.
- **Note:** the reference sites keep moderation info on the message itself (`removedById`).

#### 7. Live rooms monitor
- **Shows:** every open and recent case battle (creator, format, mode, cases, seats and who is a bot, age, status, stake), every coinflip (creator, side, stake, joiner, result, bot or player), stuck lobbies (older than the expiry), the history of finished games, and for each: the seed hash and, after the start, the revealed seed.
- **Actions:** cancel a waiting lobby (stakes come back automatically to each browser), remove a seat, flag a game as suspicious (collusion), export; **void** a finished game (records the void; refunds depend on the wallet decision).
- **Data:** `live_battles`, `live_coinflips`, secrets views; new `admin_cancel_*` functions that reuse the existing cancel logic.
- **Today:** Ready. **Size:** M.

#### 8. Round control (Crash and Double)
- **Shows:** the current round of each game (phase, time left, bets list with names and amounts, total staked, auto cash-out targets, number of players), the last 100 rounds with results, per round the committed hash and (after finishing) the revealed seed with a "verify" button that recomputes the result, bets per round and payouts.
- **Actions:** **pause a game** (the current round finishes, no new round opens; players see "paused"), resume, **emergency stop** (cancel the current round before it starts and refund), void a round after the fact (with a reason and notice to affected players), change the pause between rounds.
- **Data:** `game_rounds`, `round_bets`, seeds view; new `game_settings` row per game (`paused`, timings).
- **Today:** Ready. **Size:** M.
- **Note:** the crash point is secret during a running round; the panel never shows it until the round has finished (so an admin cannot leak it).

#### 9. Maintenance, global notice and game switches
- **Shows:** the state of every switch.
- **Actions:** maintenance mode (site shows a notice, play blocked, staff still allowed), **global notice** banner (text, colour, expiry), per-game on/off (Cases, Battles, Upgrade, Crash, Double, Plinko, Mines, Coinflip), sign-ups on/off, chat on/off, live games on/off, "staff only" mode for testing.
- **Data:** new table `app_settings` (key, value json, version, changed by, at) read by every page at start-up and over realtime. This mirrors what Bandit.camp pushes to every client at connect (`app.conga`: maintenance flag, global notice, staff-only flag).
- **Today:** New tables. **Size:** M. **Effect:** any switch can be thrown without a deploy.

### Phase 2: money records, responsible play, fairness

#### 10. Server-recorded bets and ledger viewer
- **Shows:** every bet recorded by the server (Crash demo bet, shared rounds, live games when recorded), with amount, multiplier, payout, seed id, nonce; the ledger (append-only trail with balance after each entry); totals by game, day and player.
- **Actions:** filter, export CSV. No edits.
- **Data:** `bets`, `ledger`, `round_bets`, live tables. **Today:** Ready. **Size:** S.

#### 11. Server wallet adjustments
- **Shows:** wallet balance and ledger of a player (the server wallet).
- **Actions:** credit or debit with a reason code (bug refund, correction, test), always as a ledger entry of kind `adjustment`; mass adjustment behind four-eyes; zero a wallet on account closure (exists).
- **Today:** Ready **for the server wallet only**. For all other games the browser owns the coins and no adjustment is possible. **Size:** S.

#### 12. Responsible-gambling console
- **Shows:** players who self-excluded or are cooling off (server-side), tightened or pending limit changes (the 24-hour loosening queue), players with unusually heavy play (many bets per hour, long sessions, sudden stake jumps) as a watch list, outcomes of reality checks if recorded, the help-resource list shown on the Responsible Play page.
- **Actions:** apply a cool-off or exclusion on a player (can only extend, never shorten, as the rules say), tighten a limit, add a note, edit the help links and text (versioned).
- **Data:** `account_controls`, `limit_changes`; new `rg_events` if play-time and reality-check stats should be recorded centrally.
- **Today:** Partly. Everything the player sets for **normal play** (limits, cool-off, exclusion) is in the browser. **An admin can only enforce server-side rules** (live games, shared rounds, Crash demo bet). Full enforcement needs the wallet decision. **Size:** M.

#### 13. Compliance: sandbox KYC and AML queues
- **Shows:** the verification tier of each player, pending document reviews (simulated), compliance holds, screening matches against the mock list, AML alerts with their rule codes (K01 to F01), case notes, a "sandbox payout simulator" history.
- **Actions:** approve or reject a simulated review, set or lift a hold, clear an alert with a note, manage the mock screening list, export a case.
- **Data:** today `state.kyc` and `state.aml` are in the browser. **Today:** Wallet (needs this state on the server). **Size:** M.
- **Note:** it is all a simulation of how a real site works; the panel will say so on every page.

#### 14. Fairness and RNG audit
- **Shows:** for any bet or round: committed hash, revealed seed, nonce, inputs, recomputed result and whether it matches; the seed rotation history; the nonce audit (gaps and repeats); RNG lab results (NIST SP 800-22 tests, FIPS tests, health monitor alarms) with history and a trend; a daily "all rounds verify" job result.
- **Actions:** run the RNG lab on demand, mark an anomaly, publish a monthly fairness report.
- **Data:** `seed_pairs` (revealed), seeds views, rounds, live games; new `rng_runs` to store lab results.
- **Today:** Ready. **Size:** M.

### Phase 3: rewards, races, giveaways, configuration

#### 15. Rewards, promo codes and free claims
- **Shows:** claim statistics (how many welcome and daily crates opened), promo codes with uses and remaining, free-coin faucet settings (25 coins every 10 minutes), rakeback rates (0.4%, 0.3%, 0.3%), XP per coin (10), login calendar values (1, 2, 3, 5, 8, 12, 25), level crate unlocks (levels 10 to 60).
- **Actions:** create or disable a promo code (amount, limit, expiry, per-user once), edit the numbers above, reset a player's claim, run a campaign (bonus for everyone who signs in on a day).
- **Data:** these numbers are **constants in code today** (`src/state.ts`, `src/views/rewards.ts`); new tables `promo_codes`, `promo_redemptions`, plus `app_settings` for the rest.
- **Today:** New tables. **Size:** M.
- **Note:** promo redemption and the other free rewards (rakeback, calendar) are still browser-side and can be repeated on another browser. Making them server-enforced (as the daily and welcome crates now are) belongs in this module.

#### 16. Races and leaderboards
- **Shows:** today's race standings (from server-recorded wagers), previous races, prize pools, payouts.
- **Actions:** create a race (start, end, prize table, which games count), close and pay, cancel, add a bonus prize.
- **Data:** view `daily_race` exists for server bets only; new `races`, `race_prizes`.
- **Today:** New tables. **Size:** M. **Note:** a true race needs the wager data of the live games on the server (it is, for shared rounds, battles and coinflip once those record bets).

#### 17. Rain and giveaways
- **Shows:** active and past rains and giveaways, entries, winners.
- **Actions:** start a rain (pot, duration, eligibility such as minimum level), create a giveaway (prize, entries, schedule), draw winners with a published seed so the draw is verifiable, announce in chat automatically.
- **Data:** new `rains`, `rain_joins`, `giveaways`, `giveaway_entries`. Today's rain is a local simulation.
- **Today:** New tables. **Size:** L. **Reference:** Clash.gg updates a rain pot roughly every 2.6 s and shows the number of joins live.

#### 18. Game configuration
- **Shows:** per game: enabled, minimum and maximum bet, house edge, round timings (Crash 7 s betting and 3.5 s pause; Double 12 s, 5.2 s roll, 2.6 s pause), crash growth rate, battle limits (cases per battle, formats and modes allowed), live game expiry (30 minutes), maximum open lobbies per player.
- **Actions:** change values with a mandatory reason, a preview of the effect (expected return, example payouts), schedule a change, roll back to a previous version.
- **Data:** `app_settings` and `game_settings` with versions; the functions in `0005_rounds.sql` currently hard-code timings and the 0.97 factor, so they must read the settings.
- **Today:** New tables. **Size:** M. **Risk:** changing house edge changes what "provably fair" proves; every change is versioned and shown on the Fairness page.

#### 20. Bots management
- **Shows:** the house bot names (20 today), how often they appear, their win rate in battles and coinflip (house result), whether bots are on.
- **Actions:** edit names, turn bots off for a game, set a maximum bot spend per hour, turn the simulated feed on or off.
- **Data:** names are in code; new `bots` table and counters. **Today:** New tables. **Size:** S.

#### 23. Announcements and notifications
- **Shows:** scheduled and past announcements.
- **Actions:** banner, toast to everyone online, targeted message to one player (for example a warning), e-mail digest (needs an e-mail provider), web push (needs a provider; the references use OneSignal and Klaviyo).
- **Data:** `announcements` table plus realtime. **Today:** New tables. **Size:** M for in-app; L if e-mail and push are added.

### Phase 4: catalogue, economy and analytics

#### 19. Case and item catalogue editor
- **Shows:** all cases (25 plus 2 reward cases), their items (73 items today), prices, odds per item, art, rarity, expected return (RTP) per case, popularity.
- **Actions:** create or edit a case, change odds with a **live RTP calculator** that refuses an edge outside a safe range, upload art, schedule a limited case, retire a case, import and export as JSON.
- **Data:** the catalogue is **code** today (`src/data.ts`). It must move to tables (`cases`, `items`, `case_entries`) and be loaded at start-up (with a cached copy for speed). Live battles currently trust case ids the browser knows, so unknown ids are refused; the same check would use the table.
- **Today:** Content. **Size:** XL (every game that uses cases reads this data).
- **Fairness:** the odds used by every opened case must be published and versioned.

#### 21. Economy monitor
- **Shows:** where coins come from (faucet, rewards, promos, rakeback, calendar, free crates, bots paying out) and where they go (house edge, bot wins, sinks); total coins in circulation, median and top balances, daily creation vs destruction, inflation rate, concentration (the biggest holders), payout ratio per game against theory, the biggest wins.
- **Actions:** alerts when a source exceeds a budget; one-click to reduce a faucet.
- **Data:** needs every game's coin movement on the server.
- **Today:** Wallet. **Size:** L.

#### 22. Abuse and risk signals
- **Shows:** several accounts sharing signals (same device fingerprint or IP; privacy-sensitive and needs a legal basis), bursts of free-claim attempts, accounts that never bet but claim everything, battles and coinflips between the same two accounts repeatedly (collusion), win rates beyond statistical expectation (z-score as in the sandbox AML), bot-like timing in bets or cash-outs, name impersonation of staff.
- **Actions:** open a case, tag, apply an account action, export evidence.
- **Data:** new `risk_signals`; IP and device data must be collected deliberately (today none is), and the Privacy and Cookie policies would need updating.
- **Today:** New tables. **Size:** L. **Risk:** false positives; every automatic signal is advisory, never an automatic ban.

#### 26. Analytics and reports
- **Shows:** daily and monthly active players, new sign-ups, retention cohorts (day 1, 7, 30), funnel (visit, register, first bet), most played games, bets and stake per day, average session, concurrency chart, chat volume, live-game fill rate (how many lobbies fill before they expire).
- **Actions:** date range, compare, export CSV, scheduled weekly report.
- **Data:** server tables answer most of it; **page views and sessions need a small first-party events table** (no third-party tracking, to keep the "no analytics" promise in the Privacy Policy accurate; the references use PostHog, Yandex, Google, AdRoll).
- **Today:** Ready (partly). **Size:** L.

### Phase 5: support, legal, operations, tools

#### 24. Support inbox
- **Shows:** tickets with status and priority, the player's profile alongside, canned replies.
- **Actions:** answer, assign, merge, close, link to a sanction or a bug.
- **Data:** new `tickets`, `ticket_messages`; or connect an existing helpdesk (the references use Intercom).
- **Today:** New tables. **Size:** L.

#### 25. Legal pages, terms versions and privacy requests
- **Shows:** the current version of each policy, who accepted which version, pending data requests (export and delete).
- **Actions:** publish a new terms version (bumps `TERMS_VERSION`, optionally forces re-acceptance at next sign-in), handle an access or erasure request from the queue (the self-service export and delete already exist), keep the fictional company details in one place (`src/company.ts`) in a protected editor.
- **Data:** policy texts are in code today; new `legal_docs` and `legal_acceptances`.
- **Today:** New tables. **Size:** M.

#### 27. System health and operations
- **Shows:** migration status (which of 0001 to 000N are applied), Edge Function status and logs, error events from the browser (a small error reporter), database size, table row counts, backup status, Vercel deploy info, realtime connection counts against limits, slow functions.
- **Actions:** run a health check, seed demo data in a test project, trigger a data export.
- **Data:** a thin `system_status` view and an `error_events` table; the rest links to the Supabase and Vercel dashboards.
- **Today:** Ready (partly). **Size:** M.

#### 28. Developer and QA tools
- **Shows:** a "view as player" **read-only** screen (what that player sees, never their login), feature flags per player or role, a test round runner.
- **Actions:** set a test-only flag, create test accounts, simulate a round with a fixed seed in a non-production project, time-travel a round for testing (non-production only).
- **Rule:** no impersonation that can act as a player; no tools that exist in production and bypass the rules.
- **Today:** New tables. **Size:** M.

---

## 6. Example screens (wireframes)

These are text sketches of how the panel could look. Layout, wording and the exact numbers are examples.

### 6.1 Live dashboard

```
 VAULTRUSH ADMIN        [Dashboard] Players  Chat  Live rooms  Rounds  Config  Audit        Mirage (owner)  MFA on
 -------------------------------------------------------------------------------------------------------------
  ONLINE NOW          BETS / MIN        OPEN BATTLES       OPEN COINFLIPS     CHAT / MIN         NEW TODAY
  38  (31 signed in)  64  (+12%)         5 (2 waiting)      3 (1 bot-able)     9                  4 accounts
  -------------------------------------------------------------------------------------------------------------
  CRASH   round #4821  RUNNING 6.2s  x1.74   bets: 9 players, 412.00 staked      [Pause] [Open round]
  DOUBLE  round #3310  BETTING 8.1s          bets: 14 players, 190.50 staked     [Pause] [Open round]
  -------------------------------------------------------------------------------------------------------------
  PLATFORM LIMITS (Supabase Free)                         ALERTS
  Connections   38 / 200   [#####.......................]  ! Chat: 4 reports waiting
  Messages/s    21 / 100   [######......................]  ! Player "xx_bot" claimed 14 free crates in 1 day
  DB size       41 MB / 500 MB                              ! Migration 0005 not applied on this project
  -------------------------------------------------------------------------------------------------------------
  Last admin actions:  14:02 mod Kai muted "spam99" 10 min (reason: spam)   13:40 you paused Double (reason: test)
```

### 6.2 Player profile

```
 PLAYERS > nova                                                       [Mute] [Ban from betting] [More v]
 -------------------------------------------------------------------------------------------------------------
  nova   id 7f3a...  created 2026-11-18  last seen 2 min ago   status: ACTIVE   tags: [friend] [+]
  Sign-in: Steam           18+ confirmed 2026-11-18      Terms 2026-11-21         E-mail: [reveal (logged)]
  -------------------------------------------------------------------------------------------------------------
  [Overview] [Bets] [Live games] [Chat] [Claims] [Ledger] [Notes] [Actions history]
  Server wallet 100.00 (Crash demo)     Server bets 12   staked 340.00   returned 361.20   net +21.20
  Shared rounds  Crash 38 bets / Double 61 bets      Battles 7      Coinflips 11
  Coins in other games: not visible (stored in the player's browser)
  -------------------------------------------------------------------------------------------------------------
  Notes
   14:10 Kai: asked in chat to be unmuted, agreed to rules.
   [ add a note... ]                                                                          [Save]
```

### 6.3 Chat moderation

```
 CHAT   [Live] Reports (4) Filters Deleted     Slow mode: off [10s v]   Lock chat [ ]   Word filter: 23 words
 -------------------------------------------------------------------------------------------------------------
  14:21  Vexx        gg ez                                                            [Delete] [Mute v] [Profile]
  14:21  spam99      JOIN MY GIVEAWAY http://...                                       [Delete] [Mute v] [Profile]
  14:22  nova      lets play battles                                                 [Delete] [Mute v] [Profile]
  14:22  ! reported by 3 players: "spam99"  reason: advertising                         [Delete all] [Ban] [Dismiss]
  -------------------------------------------------------------------------------------------------------------
  Post as staff: [ message...                                         ] [Send]    Pin: [ message... ] [Pin]
```

### 6.4 Live rooms

```
 LIVE ROOMS     [Battles (5)] [Coinflips (3)] [History]                                      auto-refresh on
 -------------------------------------------------------------------------------------------------------------
  Battle a1f2..   2v2 normal     4 cases  9.20/seat    seats: nova, [bot] frostbyte, -, -      waiting 03:12   [Cancel] [View]
  Battle c93b..   1v1 crazy      2 cases  1.15/seat    seats: Mirage, nova                      running 00:08   [View]
  Flip   #212     bolt  5.00     Mirage vs -                                                       waiting 00:41   [Cancel]
  Flip   #211     star  2.00     nova vs [bot] Vexx    result star, nova won 3.88             done            [Verify]
  -------------------------------------------------------------------------------------------------------------
  Stuck lobbies (older than 30 min): 0        Games flagged: 1  (same 2 accounts, 9 coinflips in 20 min)
```

### 6.5 Round control

```
 ROUNDS > CRASH                                                         Status: RUNNING   [Pause after this round]
 -------------------------------------------------------------------------------------------------------------
  Round #4821   hash 9c1e...   started 6.2s ago   multiplier x1.74   (crash point hidden until it crashes)
  Bets (9)   total 412.00      Mirage 25.00   nova 40.00 (cashed x1.50)   Vexx 10.00 ...
  -------------------------------------------------------------------------------------------------------------
  Last rounds:  1.22  2.11  6.40  1.00  3.57  ...                       [Verify round...] [Void round...]
  Settings (versioned): betting 7s | pause 3.5s | growth 0.00012 | house factor 0.97     [Edit with reason...]
```

### 6.6 Configuration editor (with reason and preview)

```
 CONFIG > CRASH                                                       version 4  (changed 2026-11-21 by you)
 -------------------------------------------------------------------------------------------------------------
  Enabled                [x]
  Min bet 0.10   Max bet 1000.00   Round betting time 7 s   Pause 3.5 s
  House factor           [ 0.97 ]   -> expected return 97.00%   (limits: 0.90 to 0.995)
  Preview: a 10.00 bet at x2 pays 20.00; the probability of reaching x2 is 48.5%
  Reason (required): [ lowering house edge for the weekend event                       ]
  [Save as draft] [Schedule for 18:00] [Apply now]  -> asks a second admin when the factor changes
```

### 6.7 Audit log

```
 AUDIT LOG     Who [all v]  Action [all v]  Target [ ]  From [ ] To [ ]                                   [Export]
 -------------------------------------------------------------------------------------------------------------
  2026-11-21 14:02  Kai (moderator)   chat.mute        spam99          10 min          reason: spam
  2026-11-21 13:40  Mirage (owner)    game.pause       double          paused          reason: test
  2026-11-21 13:12  Mirage (owner)    pii.reveal       nova          email           reason: support request
  2026-11-21 12:50  Mirage (owner)    config.change    crash.house     0.97 -> 0.96    reason: event   (approved by Kai)
  entries cannot be edited or deleted; viewing this page is itself logged
```

### 6.8 Economy monitor (needs the wallet decision)

```
 ECONOMY                                                                              last 7 days
 -------------------------------------------------------------------------------------------------------------
  Coins in circulation 18,420   (+3.1%)      Created 2,310   Destroyed 1,740       Median balance 44    Top 10 hold 38%
  Sources:  free coins 41%   rewards 22%   promos 9%   rakeback 14%   calendar 8%   other 6%
  Sinks:    house edge 62%   bot wins 21%   fees 17%
  Payout ratio by game:  Crash 96.8% (theory 97.0)  Double 93.1% (93.3)  Cases 89.7% (90.0)  Coinflip 97.0%
  Alerts: faucet exceeded its weekly budget by 12%   [Reduce faucet 10%]
```

---

## 7. New database objects (summary)

| Object | Purpose | Modules |
|---|---|---|
| `admin_roles`, `has_role()` | who may do what | all |
| `admin_audit_log` | append-only record | all |
| `account_flags` | mutes, betting bans, warnings, with expiry | 5, 6, 7, 8 |
| `player_notes`, `player_tags` | internal notes and labels | 4 |
| `chat_reports`, `chat_rules`; extra columns on `chat_messages` | moderation | 6 |
| `app_settings`, `game_settings` (versioned) | maintenance, switches, house settings, timings | 9, 15, 18 |
| `promo_codes`, `promo_redemptions` | codes and server-enforced redemption | 15 |
| `races`, `race_prizes` | races | 16 |
| `rains`, `rain_joins`, `giveaways`, `giveaway_entries` | rain and giveaways | 17 |
| `bots` | names, behaviour, counters | 20 |
| `announcements` | banners and messages | 23 |
| `cases`, `items`, `case_entries` | the catalogue in the database | 19 |
| `risk_signals` | advisory signals | 22 |
| `events` (first-party page and session events) | analytics without third parties | 26 |
| `tickets`, `ticket_messages` | support | 24 |
| `legal_docs`, `legal_acceptances` | versions and acceptance | 25 |
| `error_events`, `rng_runs`, `system_status` | health and audit | 14, 27 |

Roughly **25 new tables and about 60 new functions** for the full scope; phases 0 to 3 need about 14 tables and 35 functions. Each phase ships as its own numbered migration (as 0001 to 0005 did), with tests for every function and for the access rules (who can and cannot call it).

---

## 8. What the reference sites suggest an admin needs

Signals visible from outside, each tied to an admin capability:

| Signal seen on the reference sites | Admin capability it implies |
|---|---|
| Bandit.camp pushes `app.conga` at connect: maintenance flag, global notice, staff-only, affiliate settings | Module 9 (maintenance, notice, staff-only) |
| Chat events `chat.delete`, a `removedById` field on messages, Discord voice presence | Module 6 (moderation with attribution) |
| Clash.gg `/api/geo-lock` and `/api/payments/blocks` | Country restrictions and blocks (a switch in module 9; payments are out of scope) |
| Rain pot updated every ~2.6 s, joins counter | Module 17 |
| Races with timers (Bandit "5K RACE 2h 12m"), `/api/races` | Module 16 |
| Giveaways (`giveawayV2`, gleam.io, affiliate giveaways) | Module 17 |
| House bots in battles (`join-bots`, `banditcamp-N`, negative ids) | Module 20 |
| Language rooms in chat (`chat_ru`, `lang-en`) | Chat rooms per language in module 6 |
| KYC page, AML policy, code of ethics | Modules 13 and 25 |
| Support widget (Intercom), push (OneSignal), e-mail (Klaviyo) | Modules 23 and 24 |
| Per-round hashes and seeds shown | Module 14 |
| Fraud tooling (Sift, Cloudflare challenge, reCAPTCHA) | Module 22 |
| Analytics stacks (PostHog, Yandex Metrika, GA) | Module 26 (first-party instead) |

---

## 9. Phases and effort

| Phase | Contents | Size (sum) | Unlocks | Prerequisites |
|---|---|---|---|---|
| 0 Foundation | 1 Roles and MFA, 2 Audit log | M + M = about 1 day | everything else | first admin created by SQL |
| 1 Visibility and control | 3 Dashboard, 4 Players, 5 Account actions, 6 Chat moderation, 7 Live rooms, 8 Round control, 9 Maintenance | about 4 to 5 days | day-to-day running of the site | phase 0 |
| 2 Records, RG, fairness | 10 Bets and ledger, 11 Wallet adjustments, 12 RG console, 14 Fairness audit (13 Compliance waits for the wallet decision) | about 2 to 3 days | accountability and trust | phase 0 |
| 3 Rewards and config | 15 Rewards and promos, 16 Races, 17 Rain and giveaways, 18 Game config, 20 Bots, 23 Announcements | about 4 to 6 days | operate without deploys | phase 1 |
| 4 Catalogue, economy, analytics | 19 Catalogue editor, 21 Economy, 22 Risk, 26 Analytics | about 6 to 10 days | the "real operator" tools | wallet decision for 21 and 22 |
| 5 Support, legal, ops, tools | 24 Support, 25 Legal, 27 System health, 28 Dev tools | about 4 to 6 days | polish and process | none |

**A sensible first delivery** (if you approve only one thing): phase 0 plus the first four items of phase 1 (dashboard, players, account actions, chat moderation) plus the maintenance switch. That is about **3 to 4 days of work** and already gives you the ability to see, moderate and switch things off safely.

I would build each phase the way the live games were built: a numbered SQL migration, a data layer file, the screens, a test file with the database rules run in an in-memory Postgres and the pages run against a scripted server, and updated docs.

---

## 10. Risks and things I recommend not building

| Risk or item | Why | Recommendation |
|---|---|---|
| Editing coins, items or limits stored in browsers | Impossible without a server wallet, and a fake button would lie | Do not show it; say "stored in the player's browser" |
| "Impersonate player" with the ability to act | Dangerous and unnecessary | Read-only "view as" only, logged |
| Showing e-mail addresses to everyone | Privacy | Role-gated reveal, logged |
| Admin SQL console | Bypasses every rule | Not in the panel; use the Supabase dashboard for emergencies |
| Automatic bans from risk signals | False positives | Signals are advisory only |
| Collecting IP or device data "just in case" | Legal basis and privacy promises (the Privacy and Cookie pages say no tracking) | Only if you approve it and I update the policies |
| One shared admin login | No accountability | Individual accounts and roles only |
| Real-money tools (payments, payouts, deposits) | Out of scope for a play-money project | Never |
| Putting the service key in the site | Total compromise if leaked | Never; Edge Functions only |
| Config changes without versions and reasons | Cannot explain or undo a change | Versioned, reasoned, auditable |
| Building everything at once | Large, hard to test, easy to get wrong | Phases, each shipped and checked |

---

## 11. Decisions for you (answer by number)

For each, my recommendation is marked **(rec.)**.

1. **Scope.** (a) Minimal: phases 0 and 1. (b) **Standard: phases 0 to 3 (rec.).** (c) Full: phases 0 to 5.
2. **Wallet.** (a) **Keep coins in the browser for now; build phases 0 to 3 and hide anything needing a server wallet (rec.).** (b) Plan option C (full server wallet) as a separate project next.
3. **Where it lives.** (a) **Inside the same site at an unlisted route, protected by roles and MFA (rec.).** (b) A separate admin site.
4. **Roles.** (a) Owner only for now. (b) **Owner, Admin, Moderator, Support, Compliance, Analyst, Read-only (rec.), built so you can grant them later.**
5. **Who are the first admins?** Tell me whether it is only your account, or also friends as moderators (you give me the sign-in names when you are ready; I never choose admins myself).
6. **Four-eyes approvals.** (a) Off for now (typed confirmation instead). (b) **On for config and role changes once there are two admins (rec.).**
7. **Catalogue to the database** (module 19, XL). (a) Not now. (b) Yes, in phase 4.
8. **Personal data.** (a) **Moderators never see e-mail; reveal is owner and compliance only and logged (rec.).** (b) Different.
9. **Risk signals with IP or device data** (module 22). (a) **No collection of IP or device data (rec.); only on-site behaviour signals.** (b) Yes, with updated Privacy and Cookie policies.
10. **Analytics** (module 26). (a) **First-party counters only, no third parties (rec.).** (b) Add a third-party tool.
11. **Notifications** (module 23). (a) **In-app banners and toasts only (rec.).** (b) Also e-mail and push (needs a provider and an account for each).
12. **Support** (module 24). (a) Skip. (b) Internal simple inbox. (c) Connect an existing helpdesk.
13. **Modules to drop.** List any numbers from the index you do not want.
14. **Start with.** (a) **Phase 0 plus the first delivery set in section 9 (rec.).** (b) A different order.

Reply for example: "1b, 2a, 3a, 4b, 5 just me, 6a, 7a, 8a, 9a, 10a, 11a, 12a, 13 drop 28, 14a" and I will start.

---

## 12. Appendix: example action list per module (for acceptance checks)

If you approve a module, these are the checks it must pass before I call it done (each is a test):

- **Roles:** a user without a role cannot call any admin function; a moderator cannot ban; an admin cannot grant roles; removing a role takes effect immediately; MFA-less sessions are refused.
- **Audit:** every admin function writes exactly one audit row; rows cannot be updated or deleted by anyone; a failed attempt is logged.
- **Mute and ban:** a muted player's chat insert is refused until the mute ends; a banned player cannot create or join a battle, coinflip, or place a bet in a shared round; lifting restores access; every step is on the profile.
- **Chat:** deleting a message removes it for everyone in real time and keeps the original in the audit trail; slow mode refuses a second message inside the interval; the word filter blocks listed words.
- **Live rooms:** cancelling a waiting lobby marks it cancelled for all players and each browser refunds once; a started game cannot be cancelled, only voided with a reason.
- **Rounds:** pausing lets the current round finish and stops the next one; resume restarts; voiding never reveals a hidden crash point early; the verify screen recomputes the result from the revealed seed.
- **Maintenance:** with the switch on, non-staff pages show the notice and cannot place bets; staff still can; the switch can be thrown without a deploy.
- **Config:** a change needs a reason, is versioned, can be rolled back, and the games read the new value on the next round, not mid-round.
- **Wallet:** an adjustment always creates a ledger row of kind `adjustment`; the balance cannot go below zero; the player is told.
- **Privacy:** an e-mail reveal appears in the audit log; moderators cannot reveal.

---

## 13. Decisions recorded (2026-11-21, owner's answers)

| # | Your answer | What it means for the build |
|---|---|---|
| 1 Scope | Full | Phases 0 to 5 (all modules unless you drop some, see 13 below) |
| 2 Wallet | Full server wallet | Every game moves its money into the database (section 14). A large project of its own, done after the admin foundation and the catalogue move |
| 3 Where | A separate admin site | A second website (own address, own deployment) using the same database. The code lives in this repository |
| 4 Roles | B, with changes | Roles exist as a framework, but **only Owner is built and used now**. "Support" and "Analyst" are not built. Admin, Moderator, Compliance and Read-only can be switched on later without redoing anything |
| 5 Who | Only you, as Owner | One account has every permission |
| 6 Four-eyes | Off | Dangerous actions ask you to type a confirmation instead |
| 7 Catalogue | Yes, in the database | Cases, items and odds become editable in the panel (add, edit, delete, import, export) |
| 8 Personal data | a (but see open question A) | Owner sees everything. You also said moderators may see e-mail addresses; that conflicts with answer 8a, so I will make "can see e-mail" a switch per role and ask you when you add the first moderator |
| 9 Risk signals and IP data | Ask again after the analysis | Section 16 is the analysis; see open question B |
| 10 Analytics | a | First-party counters only, no third-party trackers |
| 11 Notifications | Not understood | Explained in section 19; see open question C |
| 12 Support inbox | Skip | Not built |
| 13 Modules to drop | Ask again after the explanation | See open question D |
| 14 Order | My choice | Section 17 |

Additional instructions from your notes:
- **The Owner sees and can do everything the Owner decides.** Dangerous actions still ask for a confirmation and still write the audit log. The audit log itself stays append-only even for the Owner (it protects you from mistakes and from a stolen login); the Owner can export it and archive old entries but not rewrite them.
- **Wallet adjustments: Owner only.**
- **Real money is out for now but must stay possible.** The money design (section 14) keeps all value in one ledger with a currency field, so adding real money later is "add a currency and payment providers", not a rewrite. Real money would also need licences, identity checks and legal review first; I would raise that before building it.
- **Country restrictions: kept** (a switch in module 9, see section 16 for how the references do it).
- **Language rooms: English only** for now (the rooms are a setting, so more can be added later).

---

## 14. The wallet decision, in plain words

**Now (what Vaultrush does today):** every player carries their own coin purse in their own pocket (their browser). The server is like a referee: it says who won, but it never holds anybody's coins. So:
- a player with a little technical skill can open their purse and write any number in it;
- you, the owner, cannot look into anybody's purse, cannot fix a mistake in it, cannot take coins away, and cannot even know how many coins exist;
- the coins do not follow the player to another phone or computer.

**Full server wallet (your choice):** all coins sit in the game's own vault (the database). A player only has an account number and the vault keeps the balance. Every bet is a request: "take 5 coins from my account", and the vault does it and writes it in a notebook (the ledger) that nobody can erase. So:
- nobody can invent coins, because the browser can no longer write a balance;
- you can see every player's balance and every coin movement, fix mistakes, and make exact reports;
- coins follow the player everywhere;
- the economy monitor, forced limits, risk checks and the verification queue all become possible;
- and it is the right foundation if you ever add real money.

**What it costs:**
1. Every game has to be rewritten so that the server handles each bet: Cases, Upgrade, Plinko, Mines, Crash, Double, Coinflip, Battles, and the free rewards. Today most of them calculate in the browser.
2. Cases, Upgrade and Battles need the server to know the odds, so **the case and item catalogue must move into the database first** (which you also want).
3. Existing browser coins cannot be moved over safely (the server cannot trust a number in the browser). The options are: everyone restarts with the starting coins, or the owner credits chosen players by hand.
4. Every bet becomes a request to the server, which is slightly slower and uses the server's limits (see the load analysis; the Free plan will be tight with many players).
5. It is a big job (my estimate: one to two weeks of work, with careful tests, because it is the part where mistakes cost trust).

**Plain recommendation:** your choice is the right one for the long term. Do it in the order in section 17: first the admin foundation and the catalogue, then the wallet game by game, so each step can be tested and nothing breaks half way.

---

## 15. Roles are for staff, not for players

The roles (Owner, Admin, Moderator, Compliance, Read-only, and the "Support" and "Analyst" I had proposed) exist **only inside the admin site** and describe people who work on the site. **Players have no roles.** A player is simply a player; nothing about "Support" or "Analyst" touches them. Because you are the only staff member, only Owner is built now. The other roles are a list of permissions you can switch on later for someone you trust.

---

## 16. How the three reference sites handle fraud, devices and countries

Observed on 2026-11-20 from their public pages and what their pages load. Nothing was tested against their defences.

| Topic | Cobalt Lab | Bandit.camp | Clash.gg |
|---|---|---|---|
| What they say they collect | IP address and approximate location, device type, operating system, browser, device identifiers, screen resolution, pages visited, time stamps | Only "cookies" are named in its short privacy page; KYC documents on request | IP address, browser and operating system, a **unique device identifier**, pages viewed, cookies that may be shared with advertisers |
| Multiple accounts | One account per person, strictly | Multi-accounts to get around the rules or the affiliate program are prohibited | Rules against unauthorised scripts and automated means |
| VPN or proxy | **Prohibited** ("to evade restrictions") | Not stated in the terms | Not stated |
| Bots and scripts | Automated abuse prohibited | "Automatic scripts" prohibited | Bots, scrapers and spiders prohibited |
| Fraud tooling seen loading | A first-party PostHog proxy (events, flags, surveys), Yandex Metrika, Facebook pixel, VK | Cloudflare bot challenge and analytics, reCAPTCHA, Google Analytics | **Sift** (a fraud and device-fingerprint service), CookieYes consent banner, ad pixels |
| Countries | "Prohibited countries" section | A list of countries whose residents may not register (Iran, Iraq, Jordan, Afghanistan, Kuwait, North Korea, Pakistan, Yemen, Syria, Thailand, Australia, Netherlands, Switzerland and some US states, as listed in its terms) | A `geo-lock` request on every page load that answers with the visitor's country and a list of restrictions |
| Automated decisions | Says it uses automated fraud detection and offers human review on request | n/a | n/a |
| Identity checks | KYC at the first withdrawal, thresholds and unusual activity | KYC and AML policy, documents on request | A KYC page |
| Voice | n/a | n/a | Battles with voice chat are recorded |

**What this means for Vaultrush (the options for your decision 9):**

| Level | What it means | Privacy cost | Detects |
|---|---|---|---|
| 0. On-site behaviour only | Look at what accounts do: claims, bet patterns, who plays against whom, timing | None extra | Free-coin farming, collusion between two accounts, bot-like timing, abnormal win rates |
| 1. Coarse country only | Read the visitor's country from the hosting provider's request header (not the IP itself, nothing stored), to apply your country restrictions | Very small | Blocked countries |
| 2. Hashed IP or device marker | Store a one-way hash of the IP or a browser marker to link accounts | Real: it is personal data; needs the Privacy and Cookie pages updated and a stated reason | Several accounts from one place |
| 3. A third-party fraud service (like Sift) | An outside company scores each visitor | Highest | More, but contradicts "no tracking" and costs money |

**My recommendation:** levels **0 and 1** now. Level 2 only if you actually see multi-account abuse, with the policy text updated first. Level 3 not recommended for a play-money site.

---

## 17. Recommended build order (revised for the decisions and the dependencies)

The order follows what depends on what, not just what is most visible.

| Step | What | Why it comes here | Size |
|---|---|---|---|
| **A** | **Admin site shell + Owner role + audit log + MFA** (modules 1, 2). A separate website, sign-in, a protected empty panel, the append-only audit log | Everything else sits on it; small | M |
| **B** | **Control and visibility** (3 Dashboard, 4 Players, 5 Account actions, 6 Chat moderation with the English room, 7 Live rooms, 8 Round control, 9 Maintenance, notice, game switches and **country restrictions**) | Gives you control of the live site right away and needs no wallet | L to XL |
| **C** | **Catalogue in the database + editor** (module 19) | A prerequisite of the server wallet: the server must know the odds | XL |
| **D** | **Full server wallet** (the core ledger, then game by game: Coinflip, Crash, Double, Battles, Cases, Upgrade, Plinko, Mines, then free rewards) with Owner-only wallet adjustments (module 11) and the bets and ledger viewer (module 10) | The big foundation; done after A to C so it can be managed from the panel | XL (the biggest step) |
| **E** | **Rewards, promos, races, rain and giveaways, game configuration, bots, in-app announcements** (15, 16, 17, 18, 20, 23) | Server-enforced once the wallet exists | L to XL |
| **F** | **Compliance and responsible play enforced on the server** (12, 13), **fairness audit** (14), **economy monitor** (21), **risk signals at the level you choose** (22), **analytics** (26) | These need the wallet data | L to XL |
| **G** | **Legal editor, system health, developer tools** (25, 27, 28), the read-only owner data explorer | Polish and process | M to L |

Support inbox (24) is skipped. A first usable result (A and the first half of B) is about 3 to 4 days of work.

---

## 18. Open questions after your answers

A. **E-mail for moderators.** You said moderators may see e-mail, but answer 8a says they should not. Since you are the only admin, nothing changes today. Tell me when you add a moderator whether the switch is on or off.
B. **Risk signals (decision 9).** Levels 0 and 1 (my recommendation), also level 2, or something else?
C. **Notifications (decision 11).** See section 19. In-app only (my recommendation), or also e-mail and push?
D. **Modules to drop (decision 13).** See the plain list in section 19.
E. **How do you sign in to the separate admin site?** (1) The same Steam account you use on the site, plus an authenticator-app code (needs the admin site's address added to two allow-lists in Supabase, which I will explain step by step). (2) Google sign-in. (3) E-mail and password with an authenticator-app code. I recommend (1).
F. **Confirm the full server wallet after reading section 14**, and what happens to existing browser coins when it starts: everyone restarts with the starting coins (simplest), or you credit selected players by hand.
G. **Owner data explorer.** A read-only search tool that lets the Owner ask the database any question (nothing can be changed, every query is logged). Yes or no?

---

## 19. Plain explanations of the items you asked about

**Module 25, Legal pages, terms versions and privacy requests.** The site has ten legal pages (terms, privacy, cookies and so on) written in the code. This module lets you edit those pages from the panel, shows which version each player accepted, and lets you require everyone to accept a new version. It also holds a queue for people who ask for their data to be exported or deleted. Players can already do the export and delete themselves, so the queue is a convenience. **If you rarely change the policies you can drop it and edit the text in code.**

**Module 22, Abuse and risk signals.** A free-coins site attracts cheaters: someone making ten accounts to collect the free coins, two friends passing coins to each other through coinflips, or a script clicking buttons faster than a person. This module is a list that points them out ("this account claimed 14 free crates in one day"). It never bans anybody by itself; it only tells you. **It matters more the more real people play; with only you and a friend it is optional now.**

**Module 21, Economy monitor.** Free coins keep arriving (a gift every 10 minutes, daily crates, rewards) and the games take coins back through the house edge. If more coins come in than go out, coins become worthless over time, like printing money. This screen shows how many coins exist, where they come from and where they disappear, and who has the most. **It needs the full server wallet, so it comes late. Useful, not urgent.**

**Decision 11, Notifications.** Option (a): messages that appear **inside the website while a player is on it**, for example a banner at the top ("maintenance at 20:00") or a pop-up. Option (b) adds messages that reach the player **outside the website**: e-mails to their inbox and notifications on their phone or computer even when the site is closed. Those need outside services (an e-mail sender, a push service), accounts and costs, and the player must agree to receive them. **I recommend (a) for now.**

**Decision 13, the modules in plain words** (tell me which numbers to drop):

| # | In one sentence | My advice |
|---|---|---|
| 1 | Who is allowed in the admin site | Keep |
| 2 | A notebook of everything every admin did | Keep |
| 3 | A live screen of what is happening | Keep |
| 4 | Look up any player and see everything about them | Keep |
| 5 | Mute, ban, or log out a player | Keep |
| 6 | Control the chat: delete, mute, slow mode, bad-word filter | Keep |
| 7 | Watch and cancel battles and coinflips | Keep |
| 8 | Control Crash and Double: pause, verify, void a round | Keep |
| 9 | Maintenance mode, site-wide message, game on/off, country restrictions | Keep |
| 10 | See every recorded bet and coin movement | Keep |
| 11 | Give or take coins from a player (Owner only) | Keep |
| 12 | Enforce responsible-play limits and see risky play | Keep |
| 13 | The pretend identity-check and anti-money-laundering queues | Optional (they are a demonstration) |
| 14 | Prove every result was fair | Keep |
| 15 | Promo codes, free coins and reward settings | Keep |
| 16 | Daily races and prizes | Keep |
| 17 | Rain and giveaways | Keep |
| 18 | Change game settings (limits, timings, house edge) | Keep |
| 19 | Edit cases and items (add, edit, delete, odds) | Keep (you asked for it) |
| 20 | Manage the house bots | Keep |
| 21 | Economy overview | Keep, late |
| 22 | Cheating and abuse signals | Optional, later |
| 23 | Banners and messages to players | Keep (in-app only) |
| 24 | Support inbox | Dropped by you |
| 25 | Legal pages editor and privacy requests | Optional |
| 26 | Reports and statistics | Keep |
| 27 | Health of the system and the database | Keep |
| 28 | Developer and test tools | Optional |
