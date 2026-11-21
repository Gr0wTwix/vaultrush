# The admin site (step A, the site controls of step B and the wallet tools of step D built 2026-11-21)

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
| Pages | Overview, Site controls, Wallets, Staff and roles, Permissions, Audit log, Data explorer. |

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

1. **Run the SQL** in the Supabase SQL editor, in order: `0004_claims_bots_caps.sql`, `0005_rounds.sql`, `0006_admin.sql`, then `0007_site_controls.sql` (all run). For the Wallets page also the server wallet (`0008` to `0013`, run) and, newer, `0018_server_limits.sql` then `0019_admin_wallet.sql` (**not run yet**).
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
| 1 | You | Run `0017`, `0018` and `0019` (and re-run `0015`) in the Supabase SQL editor |
| 2 | You | If not done: make yourself the Owner (the one SQL statement in step 2 above) |
| 3 | You | Supabase, Authentication, Multi-factor: make sure **TOTP** is enabled (step 2 of the sign-in needs it) |
| 4 | Me, once you say go | Create the second Vercel project (a name you choose), give it the same three public variables as the game site (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STEAM_LOGIN`; no secret is involved), export the branch into a clean folder, copy `vercel.admin.json` over `vercel.json` there, link the folder to the new project and deploy it to production |
| 5 | You | Supabase, Authentication, URL Configuration, Redirect URLs: add the new address followed by `/**` |
| 6 | Me (with the private deploy notes) or you | Add the new address to the Steam function's allow-list (`SITE_URLS`, keeping the addresses already there) and redeploy that function |
| 7 | You | Open the admin address, sign in with Steam, scan the QR code with an authenticator app, set the admin password. You are in |

The address is public but shows only a Steam sign-in; everything behind it is checked again by the database on every call (staff role, two-factor session, unlocked admin session, permission). A custom domain is optional and can be added later.

## Files

| File | Role |
|---|---|
| `supabase/migrations/0006_admin.sql` | Tables, permissions, sign-in chain, audit log, role and permission functions, e-mail reveal, explorer |
| `supabase/migrations/0007_site_controls.sql` | The settings row, the guards, the status function the game site reads, the five admin switch functions |
| `supabase/migrations/0019_admin_wallet.sql` | The Wallets page's functions: totals, search, overview, ledger, bets, the audited adjustment |
| `vercel.admin.json` | The admin site's own Vercel project: build and security headers |
| `src/site.ts` | Game-site side: notice bar, maintenance and country screens, paused-game panel, status polling |
| `admin/index.html`, `admin/main.ts`, `vite.admin.config.ts` | The separate site's page and build |
| `src/admin/app.ts` | The sign-in state machine and the panel shell |
| `src/admin/pages.ts` | Overview, Site controls, Wallets, Staff and roles, Permissions, Audit log, Data explorer |
| `src/admin/api.ts` | The one interface to the outside world (real calls here, a fake in tests) |
| `tests/admin-db.test.ts` | 26 database tests (sign-in chain, lockout, hierarchy, switches, audit immutability, explorer) |
| `tests/admin-app.test.ts` | 47 screen tests against a fake API (including the Site controls and Wallets pages) |
| `tests/admin-wallet-db.test.ts` | 15 database tests: who may look and change, each viewer, paging, credit and debit, refusals, repeats |
| `tests/admin-deploy.test.ts` | 6 tests: the deployment config, its security headers, and that the admin code holds no service key |
| `tests/site-db.test.ts` | 27 database tests: who may change what, every guarded entry point, staff exempt, leaving never blocked, sign-ups, countries, no country or IP stored |
| `tests/site-client.test.ts` | 18 tests of the game page's behaviour (banner, grace minute, overlay, paused games, polling, failed checks) |

## Not built yet

Everything in the plan except steps A, B1 and D: dashboard, players list and profile, account actions, chat moderation, live rooms, round control (the rest of step B); the catalogue editor (C); rewards and operations (E); the rest of compliance, fairness, economy, risk signals and analytics (F), including admin tools to apply a limit, cool-off or exclusion to a player (`rg.apply`); legal editor, system health, developer tools (G). **Collecting IP addresses and a device marker** (your decision 9) belongs to step F; the Privacy and Cookie pages will be updated in the same change, before any collection starts. Notifications stay in-app only. Support inbox is skipped.

## Alerts to the owner

If the operator alerts are on (`0016_ops_events.sql`, see [n8n.md](n8n.md)), every row written to the audit log (a wallet adjustment included) also sends an "admin action" alert (what, who, their role, the target and the reason; never the before and after values), and switching maintenance mode on or off sends a "maintenance" alert, whether it was done from the Site controls page or by SQL. Nothing is sent until the owner switches the alerts on.
