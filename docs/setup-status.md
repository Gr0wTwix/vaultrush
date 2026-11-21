# What is set up, and what is not

A plain list of the state of the real project, so nobody has to guess. **Last checked: 2026-11-21.** "Checked" means a command or request was run that day; "owner confirmed" means the owner said it worked; "not confirmed" means it was done or planned but nobody has verified it since. Keep this page current (see the ground rules in [README.md](README.md)); private identifiers are deliberately not written here.

## Set up and working

| Part | State | How we know |
|---|---|---|
| **The site** | Live at the production address on Vercel, running the latest commit of the `compliance` branch | Checked at each deploy: the served JavaScript file is the one built locally |
| **Supabase variables** | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_STEAM_LOGIN` are **set** in the owner's local `.env` and in Vercel Production. So the live site runs in **cloud mode** (Supabase accounts), not the browser-only fallback | Checked: names listed from `.env` and from `vercel env ls production`; the live bundle contains the project address and the publishable key |
| **Database migrations** | `0001` to `0016` have all been run | Owner confirmed `0007` to `0016`; `0001` to `0006` are in place because everything built on them works (not each confirmed one by one) |
| **Server wallet** | On: coins, items and every game and reward are handled by the database | Owner has used it; the migration tests pass. Not tested by me signed in on the live site |
| **Real CS2 catalogue and case art** | Deployed; the database holds all 14,411 items and the first 27 cases (the 25 high-stakes cases are built but not live yet, see below) | Owner ran `0014`/`0015` and confirmed; pictures and files checked on the live site |
| **Steam sign-in functions** | `steam-login` and `close-login` are deployed and answer | Checked: they respond (400 without Steam's parameters, 401 without a signed-in user) |
| **Site controls** | Maintenance is **off**, no notice, no game switched off, sign-ups open | Checked: the public status function of the live database |
| **GitHub CI** | Runs the type-check, tests and build on pushes to **every branch** and on pull requests (widened on 2026-11-21; before that only `main` and pull requests, so nothing since PR #2 had been checked) | Checked: the first run on the `compliance` branch (commit `34412dc`, 2026-11-21) passed on GitHub's servers: type-check, all 664 tests and the build, in about 40 seconds (`gh run list`) |
| **n8n alerts and the daily report** | On. Alerts reach the owner's Discord; the report works. n8n runs on the owner's PC (Docker, a gate, an ngrok tunnel) | Owner confirmed both messages arrived |
| **Operator alerts in the database** | Switched on (`ops_settings.enabled`) with the webhook address and secret | Owner confirmed the test message |

## Set up, but not confirmed

| Part | What is unclear |
|---|---|
| **Google sign-in** | The provider was switched on and the redirect to Google works; a complete sign-in round trip has not been confirmed |
| **Steam profile picture** | The function's code saves the picture; whether the updated function was redeployed afterwards is not confirmed (the name works) |
| **Daily report schedule in n8n** | The test run works; whether the workflow is published so it also runs at 09:00 by itself is not confirmed |
| **Two-factor (TOTP) in Supabase** | The site and admin code expect it; whether it is enabled under Authentication is not confirmed |
| **Two real players at once** | Battles, coinflip, Crash and Double with two people on the real project have not been tried |

## Not set up, or not done

| Part | State |
|---|---|
| **25 high-stakes cases, the 10,000 verification limit, the Double history fix** | Built and tested locally (738 tests), but **not live**: not yet committed or deployed, and the SQL (`0015` re-run for the new cases, `0017` for the caps) has not been run. The pictures of the 25 new cases are recoloured placeholders |
| **Admin site** | Built (sign-in chain, roles, audit log, explorer, site controls) but it runs **only on localhost** and is not deployed. That the Owner role has been created and that `http://localhost:5174` is allowed for sign-in is not confirmed ([admin-site.md](admin-site.md)) |
| **Pull request into `main`** | Not opened; `main` has PR #2 but none of the later work |
| **Always-on n8n** | n8n runs on the owner's PC, so alerts arrive only while the PC and Docker are on (the database does not retry). The server version (`n8n/docker-compose.server.yml`) is written but not tested or set up |
| **Server-side limits** | Weekly and monthly loss limits, the daily wager limit and time limits are enforced only in the browser; KYC and AML are sandbox demonstrations; the Triple Green pot in Double is simulated |
| **Admin wallet tools** | Owner adjustments and a ledger viewer in the admin site are not built (coins are given by SQL, see [server-wallet.md](server-wallet.md)); the rest of the admin plan is not built |
| **Free-coin amounts** | Not rescaled for the 1.64 coins-per-dollar item prices |
| **Pictures** | Item pictures are loaded from Valve's servers (not mirrored into our own storage) |
| **Custom domain, e-mail sending, backups** | None set up: the site is on the Vercel address, no e-mail provider is connected, and no database backup job exists (check the Supabase plan) |
| **Supabase CLI link** | The local project is not linked: run `supabase link` again before the next function deploy |

## How to re-check

- Which variables are set: `vercel env ls production` (names only), and look at the names in `.env`.
- Maintenance, notice, paused games: call the public `site_status` function with the publishable key (`POST <project address>/rest/v1/rpc/site_status`, header `apikey`).
- Alerts: `select enabled, webhook_url <> '' as has_address from public.ops_settings;` in the SQL editor, then `select public.ops_notify('test', '{}');`.
- CI: `gh run list`.
