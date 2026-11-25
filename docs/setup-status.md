# What is set up, and what is not

A plain list of the state of the real project, so nobody has to guess. **Last checked: 2026-11-25.** "Checked" means a command or request was run that day; "owner confirmed" means the owner said it worked; "not confirmed" means it was done or planned but nobody has verified it since. Keep this page current (see the ground rules in [README.md](README.md)); private identifiers are deliberately not written here.

## Set up and working

| Part | State | How we know |
|---|---|---|
| **The site** | Live at the production address on Vercel, running the latest commit of the `compliance` branch (`017e6b1`, deployed 2026-11-25: admin step B and the game site's chat moderation; before it `cc3f1fb`, the brand kit and the loading screen; `e6dc78b`, the authenticator step after every sign-in, and `2bbd97d`, the security pass, and `2169155`, the audit fixes and the ideas from reference sites, see [audit-2026-11-22.md](audit-2026-11-22.md)) | Checked at each deploy: the served JavaScript file is the one built locally |
| **Supabase variables** | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_STEAM_LOGIN` are **set** in the owner's local `.env` and in Vercel Production. So the live site runs in **cloud mode** (Supabase accounts), not the browser-only fallback | Checked: names listed from `.env` and from `vercel env ls production`; the live bundle contains the project address and the publishable key |
| **Database migrations** | `0001` to `0022` have all been run | Owner confirmed `0007` to `0019` (the `0015` re-run, `0017`, `0018` and `0019` on 2026-11-21, `0020`, `0021` and `0022` on 2026-11-25); `0001` to `0006` are in place because everything built on them works (not each confirmed one by one) |
| **Server wallet** | On: coins, items and every game and reward are handled by the database | Owner has used it; the migration tests pass. Not tested by me signed in on the live site |
| **Real CS2 catalogue and case art** | Deployed; the database holds all 14,411 items and the first 27 cases (the 25 high-stakes cases are built but not live yet, see below) | Owner ran `0014`/`0015` and confirmed; pictures and files checked on the live site |
| **Steam sign-in functions** | `steam-login` and `close-login` are deployed and answer | Checked: they respond (400 without Steam's parameters, 401 without a signed-in user) |
| **Site controls** | Maintenance is **off**, no notice, no game switched off, sign-ups open | Checked: the public status function of the live database |
| **GitHub CI** | Runs the type-check, tests and build on pushes to **every branch** and on pull requests (widened on 2026-11-21; before that only `main` and pull requests, so nothing since PR #2 had been checked) | Checked: the first run on the `compliance` branch (commit `34412dc`, 2026-11-21) passed on GitHub's servers: type-check, all 664 tests and the build, in about 40 seconds (`gh run list`) |
| **n8n alerts and the daily report** | On. Alerts reach the owner's Discord; the report works. n8n runs on the owner's PC (Docker, a gate, an ngrok tunnel) | Owner confirmed both messages arrived |
| **Operator alerts in the database** | Switched on (`ops_settings.enabled`) with the webhook address and secret | Owner confirmed the test message |
| **Google sign-in** | Works end to end on the live site | Owner confirmed 2026-11-22 |
| **Steam sign-in with profile picture** | The Steam name and picture show after signing in | Owner confirmed 2026-11-22 |
| **Security pass (headers, rate limits)** | Live: strict security headers on the game site; chat and promo-code rate limits (`0020`) | Owner ran `0020` 2026-11-25; checked after the deploy: headers served, no policy violations, Steam sign-in still works |
| **Session security (Supabase Auth)** | Access tokens 1 hour, compromised refresh tokens detected and revoked, refresh-token reuse window 10 seconds (the recommended values). Session time-box and inactivity timeout are off: they need the Pro plan | Owner screenshot of the dashboard, 2026-11-25 |
| **Two-factor (TOTP) in Supabase** | Enabled, with "Limit duration of AAL1 sessions" **on**: a signed-in account that has an authenticator but has not entered its code is signed out after 15 minutes. The game site now asks for the code after every sign-in method and on a restored session (live since 2026-11-25, commit `e6dc78b`; checked after the deploy: the served script file is the local build and contains the step, signed-out pages show no errors. Not yet tried with a real account that has an authenticator) | Owner screenshot of the dashboard, 2026-11-25 |
| **Two real players at once** | Live games with two people on the real project work | Owner confirmed 2026-11-22 (which games were tried was not specified) |
| **25 high-stakes cases, the 10,000 verification limit, the Double history fix** | Live (deployed 2026-11-21 with the SQL `0015` re-run and `0017`). The pictures of the 25 new cases are recoloured placeholders | Owner ran the SQL ("all sqls success"); checked after the deploy: the live bundle is the new build and a new case picture loads |
| **Server-side limits (`0018`), the admin Wallets page's database part (`0019`), the phone layout fixes, the slower battle rounds** | Live (commit `1f005be`, deployed 2026-11-21). The limits are now enforced by the database for every stake; the Wallets page itself only exists in the admin site, which is still localhost-only | Owner ran `0018` and `0019` ("all sqls success"); checked after the deploy: the live bundle contains the new limit calls and the sideways battle board, the public status function answers, maintenance is off. **Not tried by me signed in on the live site**, and the phone fixes were only seen in a 375 px browser window |

## Set up, but not confirmed

| Part | What is unclear |
|---|---|
| **Daily report schedule in n8n** | The test run works. A screenshot of the Discord channel (2026-11-22) shows only that test report (21 Nov, 18:48) and no 09:00 report on 22 Nov: either the workflow is not published or n8n was not running at 09:00. Alerts themselves arrive |

## Not set up, or not done

| Part | State |
|---|---|
| **Admin site** | **Deployed 2026-11-25** (now with step B, commit `017e6b1`; owner ran `0021`) to its own Vercel project (the address is in the owner's private notes) with the strict headers of `vercel.admin.json`; the Steam allow-list includes it (checked). Still to do by the owner: add the address to Supabase's Redirect URLs, then sign in (Steam, authenticator, admin password). Not yet tried with a real sign-in. The rest of the admin plan (steps B, C, E, F, G) is being built step by step; see [admin-site.md](admin-site.md) |
| **Pull request into `main`** | Not opened; `main` has PR #2 but none of the later work |
| **Always-on n8n** | n8n runs on the owner's PC, so alerts arrive only while the PC and Docker are on (the database does not retry). The server version (`n8n/docker-compose.server.yml`) is written but not tested or set up |
| **KYC, AML, Triple Green** | KYC and AML are sandbox demonstrations; the Triple Green pot in Double is simulated |
| **The rest of the admin plan** | Players list and actions, chat moderation, round control, the catalogue editor, rewards tools, the compliance, economy and risk pages, legal editor and system pages are not built (what exists: [admin-site.md](admin-site.md)) |
| **Free-coin amounts** | Not rescaled for the 1.64 coins-per-dollar item prices |
| **Pictures** | Item pictures are loaded from Valve's servers (not mirrored into our own storage) |
| **Custom domain, e-mail sending, backups** | None set up: the site is on the Vercel address, no e-mail provider is connected, and no database backup job exists (check the Supabase plan) |
| **Supabase CLI link** | The local project is not linked: run `supabase link` again before the next function deploy |

## How to re-check

- Which variables are set: `vercel env ls production` (names only), and look at the names in `.env`.
- Maintenance, notice, paused games: call the public `site_status` function with the publishable key (`POST <project address>/rest/v1/rpc/site_status`, header `apikey`).
- Alerts: `select enabled, webhook_url <> '' as has_address from public.ops_settings;` in the SQL editor, then `select public.ops_notify('test', '{}');`.
- CI: `gh run list`.
