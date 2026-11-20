# The admin site (step A and the site controls of step B built 2026-11-21)

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
| Pages | Overview, Site controls, Staff and roles, Permissions, Audit log, Data explorer. |

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

1. **Run the SQL** in the Supabase SQL editor, in order: `0004_claims_bots_caps.sql`, `0005_rounds.sql`, `0006_admin.sql` (done), then `0007_site_controls.sql` (new).
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

**Deploying it as its own site** (later, with your permission, because it creates a new project in your Vercel account): a second Vercel project on this repository with build command `npm run build:admin` and output folder `dist-admin`, then add its address to the Supabase redirect list and the Steam allow-list. Send it with security headers (no framing, no referrer) when it goes live.

## Files

| File | Role |
|---|---|
| `supabase/migrations/0006_admin.sql` | Tables, permissions, sign-in chain, audit log, role and permission functions, e-mail reveal, explorer |
| `supabase/migrations/0007_site_controls.sql` | The settings row, the guards, the status function the game site reads, the five admin switch functions |
| `src/site.ts` | Game-site side: notice bar, maintenance and country screens, paused-game panel, status polling |
| `admin/index.html`, `admin/main.ts`, `vite.admin.config.ts` | The separate site's page and build |
| `src/admin/app.ts` | The sign-in state machine and the panel shell |
| `src/admin/pages.ts` | Overview, Staff and roles, Permissions, Audit log, Data explorer |
| `src/admin/api.ts` | The one interface to the outside world (real calls here, a fake in tests) |
| `tests/admin-db.test.ts` | 26 database tests (sign-in chain, lockout, hierarchy, switches, audit immutability, explorer) |
| `tests/admin-app.test.ts` | 36 screen tests against a fake API (including the Site controls page) |
| `tests/site-db.test.ts` | 27 database tests: who may change what, every guarded entry point, staff exempt, leaving never blocked, sign-ups, countries, no country or IP stored |
| `tests/site-client.test.ts` | 18 tests of the game page's behaviour (banner, grace minute, overlay, paused games, polling, failed checks) |

## Not built yet

Everything else in the plan: dashboard, players, account actions, chat moderation, live rooms, round control (the rest of step B); the catalogue editor (C); the full server wallet (D); rewards and operations (E); compliance, fairness, economy, risk signals and analytics (F); legal editor, system health, developer tools (G). **Collecting IP addresses and a device marker** (your decision 9) belongs to step F; the Privacy and Cookie pages will be updated in the same change, before any collection starts. Notifications stay in-app only. Support inbox is skipped.
