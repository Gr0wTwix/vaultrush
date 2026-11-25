# The admin site (steps A, B, C and D built, step E in progress; live since 2026-11-25)

A **separate website** for running Vaultrush. It lives in this repository and uses the same database, but it is its own page, its own build and (when deployed) its own address. The plan, the decisions and the open questions are in [admin-panel-proposal-2026-11-21.md](admin-panel-proposal-2026-11-21.md). This page describes what exists now.

## What is built (step A)

| Part | What it does |
|---|---|
| Three-step sign-in | Steam, then an authenticator (TOTP) code, then a separate admin password. The page never decides who gets in: it asks the database (`admin_status()`) and shows the missing step. |
| Roles | Owner (rank 100), Admin (80), Moderator (60), Compliance (50), Read-only (10). **Players have no role.** Only the Owner exists in practice; the others are ready to switch on. |
| Permissions | 62 permissions covering every planned module. Each is a switch per role. A higher rank can switch permissions for a **lower** rank, only for ones it holds itself. The Owner holds everything, including permissions added later, and cannot be restricted. |
| Audit log | Append-only. Every admin action writes one row (who, role, what, on whom, before and after, reason, time) inside the same transaction. No update, delete or insert is granted to anyone, the Owner included. |
| Data explorer | A read-only query tool for the Owner. Every attempt is logged first, including refused and failing ones. |
| Site controls (step B1) | Maintenance mode, site notice, per-game switches, sign-ups open or closed, country restrictions. Details below. |
| Wallets (step D) | Every coin in the database: economy totals, player search, one player's wallet, ledger and bets, and the owner's audited coin adjustment. Details below. |
| Pages | Overview, Dashboard, Players, Chat, Live rooms, Rounds, Catalogue, Rewards, Announcements, Events, Site controls, Wallets, Staff and roles, Permissions, Audit log, Data explorer. |

## Site controls (step B1)

One settings row in the database, changed from the **Site controls** page and obeyed by the game site. Every change needs a reason and is written to the audit log with before and after. Looking at the page needs `dashboard.view`; changing needs the matching switch: `site.maintenance`, `site.notice`, `site.games`, `site.signups`, `site.countries` (the Owner and the Admin role hold them by default; Moderator and Read-only can look, not change).

| Control | What players experience |
|---|---|
| Maintenance | A page that is already open gets a warning bar for **one minute**, then a full-screen message (yours, up to 200 characters). A page loaded during maintenance shows the message at once. New live games, bets, free-crate claims and sign-ups are refused by the database. |
| Notice | A bar under the top menu (information or warning, up to 300 characters). Does not stop play. |
| Game switch | The game's page shows "paused", and the live games (Battles, Coinflip, Crash, Double) refuse new games and bets in the database. |
| Sign-ups | A new profile is refused ("sign-ups are closed"); players who already have an account log in and play as usual; the sign-up form says so. |
| Countries | Players whose connection comes from a listed country see "not available in your country" and are refused new games, crates and sign-up. |

Rules that hold for all of them:

- **Leaving is never blocked.** Cancelling a coinflip or battle, leaving a lobby and cashing out in Crash stay open, so pausing a game cannot trap anyone's stake. Open Crash and Double bets keep running while maintenance is on (turn maintenance on between rounds if that matters).
- **Staff are never locked out.** Anyone with an admin role is not held back by maintenance, paused games or country rules, so the Owner can always switch things back.
- **Country is not stored.** It is read from the connection's country header (Supabase sits behind Cloudflare), compared with the list at the moment of the request and thrown away. No IP address is saved either. If the header is missing or unknown the visitor is let in. The Privacy page states this. Collecting an IP address or a device marker for risk checks is a different thing (step F) and will update the Privacy and Cookie pages first.
- **Honest limit.** Cases, Upgrade, Plinko and Mines still run in the player's browser (their coins are kept there until the full wallet, step D). Pausing them hides the page but cannot technically stop someone determined. The Site controls page labels each game "database" or "browser" so this is visible.
- The game site asks for the status when it opens, every 30 seconds, when the tab comes back and after sign-in. A failed check keeps what it knew: a hiccup never closes or opens the site.
- How the guard is added: `0007_site_controls.sql` edits the stored text of the existing entry points to call `site_guard()` (and `site_guard_signup()` for sign-up) and fails loudly if it cannot find where. A later migration that rewrites one of these functions must keep the guard line; `tests/site-db.test.ts` calls every guarded entry point with its switch off, so a lost guard fails the tests.

## Wallets (step D, admin side: `0019_admin_wallet.sql`)

The **Wallets** page needs `ledger.view` to look (Owner, Admin and Read-only hold it by default) and `wallet.adjust` to change coins (**Owner only** by default; the Owner can switch it on for another role on the Permissions page).

| Part | What it shows or does |
|---|---|
| Totals | Coins in all wallets, how many wallets hold coins and the largest one, bets today and over 7 days (count, staked, paid back), and the adjustments of the last 30 days |
| Search | Players by part of the name (at least 2 letters, closed accounts left out), with balance and wagered, the richest first |
| A player's wallet | Balance, wagered and won, the **ledger check** (what all ledger rows add up to, and any difference: a balance that went through the ledger from the start shows "matches"; a balance from before the ledger can differ), coins by kind (bonus, bet, win, rakeback, adjustment, ...), bets summary, inventory (count and value), and, for staff who also hold `rg.view`, the player's limits with how much of each is used, the breaks and the verification level |
| Ledger and bets | Newest first, 50 at a time with "Load older" |
| Change coins | An amount (up to 10,000,000, at most 2 decimals), give or take, and a reason |

How a change is made safe:

- **A reason is required** (3 characters or more) and goes to the audit log with the balance **before and after**, the amount and the ledger row.
- It is a real ledger row of kind `adjustment`, so the player sees it in their transactions and the ledger still adds up. It is **not a wager and not a win**: no XP, no rakeback, not counted in "won", not counted by the limits.
- A **debit can never take the balance below zero** (`debit_exceeds_balance`); the page also stops it before asking. Only coins can be changed here, never items.
- Every request carries a **key**. Pressing the button twice, or retrying after a lost answer, pays **once** and the second answer says it was already done; the same key for a different amount or player is refused. The page keeps the same key for a retry of the same request and makes a new one for anything different.
- **Looking is not written to the audit log** (it would only be noise, and every audit row alerts the owner); the data explorer, which can read anything, is logged. If operator alerts are on, an adjustment sends the "admin action" alert and the "coins added by hand" alert ([n8n.md](n8n.md)).
- Tested by `tests/admin-wallet-db.test.ts` (who may look and who may change, each viewer, paging, credit, debit, refusals, repeats) and the Wallets part of `tests/admin-app.test.ts`.

## Control and visibility (step B: `0021_admin_control.sql`, built 2026-11-25)

Five pages, each shown only to staff holding its permission. Every change asks for a reason, is checked again by the database and is written to the audit log (and, with operator alerts on, sent to the owner's chat).

| Page | What it shows | What it can do |
|---|---|---|
| **Dashboard** (`dashboard.view`) | Players active in the last 15 minutes and today (a bet or a chat message), new players, bets and chat in the last 15 minutes, open and stuck lobbies, the current Crash and Double rounds, open chat reports, active restrictions, paused games, bets per hour (24 hours) and new players per day (7 days). Refreshes every 15 seconds | Links to the pages behind each tile |
| **Players** (`players.view`) | Every account with status (muted, banned, warned, self-excluded, closed, staff) and tags; search by name or id; one player's profile: sign-in method and last sign-in, balance (with `ledger.view`), live games, free crates taken, restrictions and their history, staff notes, tags, recent chat, recent bets, every staff action on the player | Notes (`players.notes`), tags VIP / watch / friend / tester / streamer (`players.tags`), and the account actions below |
| **Chat** (`chat.view`) | The English room's messages with reports and removals, the open and handled report queues, the room rules | Remove a message, clear the last N minutes, pin and unpin, post as staff (`chat.post`, shown with a STAFF badge), lock the room, slow mode, block links, blocked words (`chat.settings`), dismiss a report |
| **Live rooms** (`rooms.view`) | Every case battle and coinflip: seats (bots marked), stake, status, age, the seed once revealed; lobbies waiting more than 30 minutes are marked "stuck" | Cancel a waiting lobby with every stake refunded (`rooms.cancel`); mark a game suspicious (`rooms.cancel`) or void (`rooms.void`) |
| **Rounds** (`rounds.view`) | The last Crash and Double rounds with bets, staked and paid; each round's bets; the seed of finished rounds only (the Crash point of a round in play is never shown) | **Check** recomputes a finished round from its seed (hash and result); pause or resume the game (`site.games`, the same switch as Site controls); mark a round void (`rounds.void`) |

**Account actions** (from a player's profile):

| Action | Permission | Effect on the player |
|---|---|---|
| Mute | `accounts.mute` | Chat messages refused ("you are muted") for 15 minutes to 30 days, or until lifted |
| Warn | `accounts.mute` | A popup with your message the next time they open the site, shown once; the profile shows whether it was read |
| Betting ban | `accounts.ban` | Every game refuses their bets; chat and rewards still work |
| Site ban | `accounts.ban` | Games, rewards, free crates and chat refused; their sign-in is ended and new sign-ins refused until the ban ends (see the note below) |
| Force sign-out | `accounts.signout` | Every session ends; they can sign in again unless banned |
| Rename | `accounts.rename` | New name under the sign-up rules; old chat messages keep the old name |
| Reset a free crate | `rewards.edit` | The welcome or daily crate can be claimed again |
| Close the account | `accounts.close` | Anonymised like a self-closure (name, coins, chat), sign-in refused for good. You must type the player's name to confirm. Staff accounts cannot be closed here |

Rules kept by the database: an action needs a reason; staff of your rank or above cannot be acted on, nor can you act on yourself; a temporary restriction ends by itself; lifting one is logged with its own reason; staff are never limited by bans, mutes, chat locks or filters. "Suspicious" and "void" are records only: no coins move (correct coins on the Wallets page). A round that is running is never stopped half way: pausing a game lets the current round finish and refuses new bets (rounds last seconds).

**Signing a player out.** Ending a sign-in and refusing new ones changes Supabase's own sign-in tables from the database. If the project does not allow that, the action still works on every request (the bans are checked by the database) and the action's result says the sign-out did not happen. A player who is signed out keeps their current access token until it expires (at most one hour), but every game, reward and chat request is refused by the ban at once.

**On the game site:** removed messages turn into "Message removed by a moderator" for everyone at once; staff messages carry a STAFF badge; a small flag on other players' messages reports them (once per message, at most 20 reports an hour); the pinned message and slow mode or a locked room show above the chat; a warning appears as a popup at the next visit. The refusals have readable texts ("You are muted in chat for now", "Your account is suspended", and so on).

Tested by `tests/admin-control-db.test.ts` (24 database tests), the step B part of `tests/admin-app.test.ts` (10 screen tests) and `tests/chat-moderation.test.ts` (the game site's chat and warning popup).

## Catalogue (step C: `0022_catalogue_editor.sql`, built 2026-11-25)

The **Catalogue** page (`catalogue.view` to look, `catalogue.edit` to change) edits the cases in the database. The server already drew every opening from those tables; now the game site also reads them at start-up (`catalogue_public`, through `src/catalogue-sync.ts`), so a saved change is what players see on their next visit and what every opening uses. If the site cannot reach the database it shows the copy of the cases it was built with.

| Part | What it does |
|---|---|
| Case list | Every case with price, return to the player (average value / price), number of items, openings in the last 7 days, version, and whether a waiting battle uses it. Switched-off cases on request |
| Editor | Name, price, colour, label, picture (its own `public/assets/cases/<id>.webp`, or another case's picture for a new case), order on the page, and the items with their chances in percent (3 decimals; 1% = 1,000 of the 100,000 tickets). Live totals: chances added up, average value, return, items |
| Helpers | "Put the rest on the most likely item" (makes the chances add up to 100%), "Set the price for a 90% return" (the return the generated cases use), item search by name and value range (all 14,411 real items), JSON export and import |
| Checks (also in the database) | Chances add up to exactly 100%; 1 to 60 items, no item twice, only real items; a paid case returns 70% to 98% of its price; a new case's id is 2 to 30 lower-case letters, numbers or dashes and can never change; reward crates (daily, welcome) are never sold, so their price is not checked |
| Versions | Every save is a new version with the full contents, the person and the reason; the first version of every case ("as installed") is recorded when `0022` runs. **Restore** puts an old version back as a new version, so nothing is ever lost. A save based on an older version than the current one is refused, so two people cannot overwrite each other |
| Switching off | Hides the case on the site and the server refuses to open it; nothing is deleted, and it can be switched on again |
| Cases in a waiting battle | Cannot be re-priced or switched off until that battle starts or is cancelled (its refund uses the price); what is inside can still change |

Not built: uploading new case pictures (pick an existing picture, or add a file to `public/assets/cases/` and deploy) and scheduling a case for a later date. Every save, switch and restore is in the audit log.

**Important:** from now on the database holds the cases. Running the generated `0015_real_cases.sql` again (a price refresh with `npm run build:catalogue`) rebuilds every case and would undo edits made here. See [real-catalogue.md](real-catalogue.md).

Tested by `tests/catalogue-editor-db.test.ts` (13 database tests on the real catalogue), the step C part of `tests/admin-app.test.ts` (6 screen tests) and `tests/catalogue-sync.test.ts` (the game site applying the published cases).

## Rewards and announcements (step E, part 1: `0023_rewards_admin.sql`, built 2026-11-25)

| Page | Permission | What it does |
|---|---|---|
| **Rewards** | `rewards.view` to look, `rewards.edit` to change the settings, `promos.manage` for codes | **Settings:** free coins per claim and how often (25 every 10 minutes at the start), the three rakeback shares (0.4% / 0.3% / 0.3% of every stake; at most 5% together), the 7 login-calendar amounts, the daily race prizes (1 to 50 places). A live summary shows what a player can take per hour, per calendar week and per race day. **Cost:** what the faucet, rakeback, calendar, promo codes and race paid today and over 7 days, and the free crates opened. **Promo codes:** create (code, coins, total uses or no limit, end date, note), change, switch off, and see who used a code |
| **Announcements** | `announcements.manage` | Banners (under the top bar until they end; each player can close one) and pop-ups (shown once per player), in three styles, with a start and an optional end; ending one early. They reach open pages within 30 seconds, with the site status the page already asks for |

**How the numbers reach players.** The settings live in one database row; the reward functions (`claim_faucet`, rakeback on every stake, `claim_calendar`, `claim_race_prize`) read it, so a change is paid at once. The game site reads the same row at start-up (`reward_settings_public`, `src/rewards-sync.ts`) for the free-coins button, the Rewards page and the race board; without it (no backend, or before `0023`) the page keeps the same default numbers. The Rewards page no longer lists the demo codes to players on the server wallet.

Rules: every change needs a reason and is logged with the old and new values. A code is 3 to 20 letters, numbers, - or _, saved in capitals, and cannot be renamed. A code that is off, expired or used up answers exactly like a wrong code (and counts toward the 10-wrong-tries limit of `0020`).

Tested by `tests/rewards-admin-db.test.ts` (11 database tests: the settings change what the faucet, rakeback, calendar and race pay; codes; announcements in the site status), `tests/rewards-announcements.test.ts` (the game site applying the settings and showing banners and pop-ups) and the step E part of `tests/admin-app.test.ts`.

## Events: races, coin rain, giveaways (step E, part 2: `0024_events.sql`, built 2026-11-25)

The **Events** page (`rewards.view` to look) has three tabs. Coins paid here appear in the ledger as `race`, `rain` or `giveaway` and on the Rewards page's cost cards.

| Tab | Permission to act | How it works |
|---|---|---|
| **Races** | `races.manage` | A name, a start and an end (at most 31 days), a prize table (1 to 50 places) and the games that count (none ticked = every game). Players rank by the coins they wager in those games inside the window, from the bets the database records; ties go to the earlier account id so the order never changes. When a race has ended, **Pay prizes** pays each ranked player with a prize once and records it. A race can be cancelled until it is paid. The game site shows running, upcoming and recently ended races under the daily race, with the player's own place |
| **Coin rain** | `rain.manage` | A pot (1 to 100,000), a join time (30 seconds to 10 minutes) and an optional minimum level. One rain at a time; it is announced in the chat in your name. Signed-in players join from the chat (the bar shows the pot, the seconds left and how many joined). When the time is up the pot is split equally between everyone who joined (rounded down to the cent) and paid at once; the chat tells each player what they got. A running rain can be cancelled (nobody is paid). For signed-in players this replaces the old simulated rain |
| **Giveaways** | `giveaways.manage` | A title, a prize per winner, 1 to 100 winners, an optional minimum level, and when entries open and close. When it is created a secret seed is drawn and only its SHA-256 fingerprint is published. Players enter once each on the Rewards page (each entry gets a number in order). When entries have closed, **Draw** picks the entries with the lowest SHA-256 of `seed:entry number`, pays each winner and reveals the seed. On the game site **Check the draw** recomputes it in the browser from the seed and the list of entries |

Everything is checked by the database (dates, amounts, levels, one entry per player, paying once) and every staff action is in the audit log. Banned players (site ban) cannot join a rain or enter a giveaway.

Tested by `tests/events-db.test.ts` (13 database tests, including an independent re-check of a draw with Node's own SHA-256), `tests/events-client.test.ts` (the draw check, the race board, the rain bar in the chat) and the step E part of `tests/admin-app.test.ts`.

## How the sign-in works

1. **Steam.** The same Steam account you use on the game, through the existing `steam-login` Edge Function.
2. **Authenticator.** The Supabase session must be "aal2" (two-factor completed). First time: the page shows a QR code to scan. After that: a 6-digit code.
3. **Admin password.** Stored only as a bcrypt hash. At least 14 characters, at least 3 of lower/upper/digit/symbol, nothing obvious, not your name. Five wrong tries lock the admin sign-in for 15 minutes (the counter is saved because a wrong password is *returned*, not raised). Changing it needs the current one and signs you out.

Steps 2 and 3 are re-checked on **every** admin call in the database (`admin_guard()`). The unlocked session ends after **30 idle minutes**, or when you press **Lock now**. A role removed from someone also ends their session at once.

## Rules that are enforced in the database

- Roles are only given by a function that checks rank: never to yourself, never above your own rank, never the Owner role (that is **SQL only**, see below).
- Every change needs a **reason** (at least 3 characters), stored in the log.
- Revealing an e-mail address (`players.view_email`) needs a reason, is logged, and the address itself is never written to the log. **Moderators do not hold this permission by default**; the Owner can switch it on or off for any role from the Permissions page.
- The explorer runs one statement, 5 seconds at most, up to 1,000 rows, inside a read-only transaction. Writes, data-changing CTEs, several statements and functions that write are all refused. It sees everything including secret seeds, so do not play on the account you use to look.

## One-time setup (you do this)

**Status (2026-11-21):** the SQL in step 1 is run. That the Owner role has been created (step 2) and that `http://localhost:5174` is allowed for sign-in (step 3) is **not confirmed**; the admin site has not been deployed and runs only on the owner's PC. See [setup-status.md](setup-status.md).

1. **Run the SQL** in the Supabase SQL editor, in order: `0004_claims_bots_caps.sql`, `0005_rounds.sql`, `0006_admin.sql`, then `0007_site_controls.sql` (all run). For the Wallets page also the server wallet (`0008` to `0013`, run) and, newer, `0018_server_limits.sql` then `0019_admin_wallet.sql` (run by the owner on 2026-11-21). For step B (Dashboard, Players, Chat, Live rooms, Rounds): `0021_admin_control.sql` (after `0020`; run by the owner on 2026-11-25). For step C (Catalogue): `0022_catalogue_editor.sql` (after `0021`; run by the owner on 2026-11-25). For step E part 1 (Rewards, Announcements): `0023_rewards_admin.sql` (after `0022`; run by the owner on 2026-11-25). For step E part 2 (Events): `0024_events.sql` (after `0023`; run by the owner on 2026-11-25).
2. **Make yourself the Owner.** Replace `YOUR_DISPLAY_NAME` with your player name and run only this statement:
   ```sql
   insert into public.admin_roles (user_id, role, granted_by)
   select id, 'owner', id from public.profiles where lower(display_name) = lower('YOUR_DISPLAY_NAME');
   ```
   Nobody can become Owner any other way, so nobody can promote themselves.
3. **Allow the admin address for Steam sign-in.** For local use the address is `http://localhost:5174`. In the Supabase dashboard: Authentication > URL Configuration > Redirect URLs: add `http://localhost:5174/**`. Then add it to the Steam function's allow-list and redeploy it (keep the addresses already in the list). The exact commands are in the private deploy notes, not in the repository.
4. **Run it locally:** `npm run dev:admin`, then open http://localhost:5174.

## Running and building

| Command | Use |
|---|---|
| `npm run dev:admin` | Admin site at http://localhost:5174 (reads the same `.env`) |
| `npm run build:admin` | Builds to `dist-admin/` (about 32 KB of its own code plus the shared database client) |

## Deploying it as its own site

**Status: not deployed.** The configuration is ready and tested; nothing has been created in Vercel and nothing has been changed in Supabase. Deploying creates a new project in your Vercel account and a public address, and changes where Steam sign-in may return to, so it waits for your go-ahead.

`vercel.admin.json` (a second Vercel project on this same repository) holds the build (`npm run build:admin` into `dist-admin`) and the **security headers**: no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), no referrer, no search indexing, scripts only from the site itself (no inline script, no eval, no other host), connections only to itself and `*.supabase.co`, no camera, microphone or location, and the page itself never cached. `tests/admin-deploy.test.ts` checks the file and that the admin code holds no service key. The headers were also tried in a real browser against the built site: the admin page loads and reaches the database, while a connection to another host and an inline script are blocked.

| # | Who | What |
|---|---|---|
| 1 | You | Done (2026-11-21): `0015` re-run, `0017`, `0018` and `0019` were run in the Supabase SQL editor |
| 2 | You | Done (confirmed 2026-11-25): your account holds the Owner role |
| 3 | You | Done (confirmed 2026-11-25): **TOTP** is enabled under Authentication, Multi-factor (step 2 of the sign-in needs it) |
| 4 | Me | Done (2026-11-25): created the second Vercel project (a name you choose), give it the same three public variables as the game site (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STEAM_LOGIN`; no secret is involved), export the branch into a clean folder, copy `vercel.admin.json` over `vercel.json` there, link the folder to the new project and deploy it to production |
| 5 | You | Supabase, Authentication, URL Configuration, Redirect URLs: add the new address followed by `/**` |
| 6 | Me | Done (2026-11-25): the new address was added to the Steam function's allow-list (`SITE_URLS`, the three addresses already there kept). Checked: the function now returns to the admin address and still refuses unknown ones |
| 7 | You | Open the admin address, sign in with Steam, scan the QR code with an authenticator app, set the admin password. You are in |

The address is public but shows only a Steam sign-in; everything behind it is checked again by the database on every call (staff role, two-factor session, unlocked admin session, permission). A custom domain is optional and can be added later.

## Files

| File | Role |
|---|---|
| `supabase/migrations/0006_admin.sql` | Tables, permissions, sign-in chain, audit log, role and permission functions, e-mail reveal, explorer |
| `supabase/migrations/0007_site_controls.sql` | The settings row, the guards, the status function the game site reads, the five admin switch functions |
| `supabase/migrations/0019_admin_wallet.sql` | The Wallets page's functions: totals, search, overview, ledger, bets, the audited adjustment |
| `supabase/migrations/0024_events.sql` | Step E part 2: races and their payouts, coin rain and its joins, giveaways with a committed seed, entries and winners |
| `supabase/migrations/0023_rewards_admin.sql` | Step E part 1: the reward settings row and the reward functions that read it, promo-code management, announcements (also in `site_status`) |
| `supabase/migrations/0022_catalogue_editor.sql` | Step C: case versions and history, the published catalogue the game reads, the editor functions and their checks |
| `supabase/migrations/0021_admin_control.sql` | Step B: notes, tags, account restrictions (and the guard and chat rules that enforce them), chat moderation and reports, live-room and round tools, the dashboard |
| `vercel.admin.json` | The admin site's own Vercel project: build and security headers |
| `src/site.ts` | Game-site side: notice bar, maintenance and country screens, paused-game panel, status polling |
| `admin/index.html`, `admin/main.ts`, `vite.admin.config.ts` | The separate site's page and build |
| `src/admin/app.ts` | The sign-in state machine and the panel shell |
| `src/admin/pages.ts` | Overview, Site controls, Wallets, Staff and roles, Permissions, Audit log, Data explorer, and the menu order |
| `src/admin/pages-events.ts` | Step E part 2: the Events page (races, coin rain, giveaways) |
| `src/events.ts`, special races in `src/views/leaderboard.ts`, rain in `src/chat.ts`, giveaways in `src/views/rewards.ts` | Game-site side of step E part 2 |
| `src/admin/pages-rewards.ts` | Step E part 1: the Rewards and Announcements pages |
| `src/rewards-sync.ts`, `applyRewardSettings()` in `src/state.ts`, announcements in `src/site.ts` | Game-site side of step E part 1 |
| `src/admin/pages-catalogue.ts` | Step C: the Catalogue page and editor |
| `src/catalogue-sync.ts`, `applyCatalogue()` in `src/data.ts` | Game-site side of step C: load the published cases at start-up and swap them in |
| `src/admin/pages-control.ts` | Step B: Dashboard, Players (with the account actions), Chat, Live rooms, Rounds |
| `src/notices.ts`, `src/chat.ts`, `src/live.ts` | Game-site side of step B: the warning popup, removed and staff messages, reports, the pinned message |
| `src/admin/api.ts` | The one interface to the outside world (real calls here, a fake in tests) |
| `tests/admin-db.test.ts` | 26 database tests (sign-in chain, lockout, hierarchy, switches, audit immutability, explorer) |
| `tests/admin-app.test.ts` | 57 screen tests against a fake API (including the Site controls, Wallets and step B pages) |
| `tests/admin-control-db.test.ts` | 24 database tests of step B: who may do what, every account action and its effect on the player, chat rules, reports, rooms, rounds, running the file twice |
| `tests/chat-moderation.test.ts` | The game site's chat with moderation and the warning popup |
| `tests/admin-wallet-db.test.ts` | 15 database tests: who may look and change, each viewer, paging, credit and debit, refusals, repeats |
| `tests/admin-deploy.test.ts` | 6 tests: the deployment config, its security headers, and that the admin code holds no service key |
| `tests/site-db.test.ts` | 27 database tests: who may change what, every guarded entry point, staff exempt, leaving never blocked, sign-ups, countries, no country or IP stored |
| `tests/site-client.test.ts` | 18 tests of the game page's behaviour (banner, grace minute, overlay, paused games, polling, failed checks) |

## Not built yet

Everything in the plan except steps A, B, C, D and the first part of E: game configuration and bots (the rest of E); rewards and operations (E); the rest of compliance, fairness, economy, risk signals and analytics (F), including admin tools to apply a limit, cool-off or exclusion to a player (`rg.apply`); legal editor, system health, developer tools (G). **Collecting IP addresses and a device marker** (your decision 9) belongs to step F; the Privacy and Cookie pages will be updated in the same change, before any collection starts. Notifications stay in-app only. Support inbox is skipped.

## Alerts to the owner

If the operator alerts are on (`0016_ops_events.sql`, see [n8n.md](n8n.md)), every row written to the audit log (a wallet adjustment included) also sends an "admin action" alert (what, who, their role, the target and the reason; never the before and after values), and switching maintenance mode on or off sends a "maintenance" alert, whether it was done from the Site controls page or by SQL. Nothing is sent until the owner switches the alerts on.
