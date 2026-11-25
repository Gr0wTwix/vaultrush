# Technical requirements

What Vaultrush is built on, what it must do, and the limits it works within. Last updated 2026-11-25. For the folder layout see [architecture.md](architecture.md); for what is set up on the real project see [setup-status.md](setup-status.md).

## Purpose and hard limits

- A **play-money** skin-game demo: case openings, case battles, Upgrade, Crash, Double, Plinko, Mines, Coinflip, rewards, a daily race and chat.
- **No real money.** Coins can never be bought, sold or withdrawn, and no gambling licence is held. Nothing may add a deposit, a withdrawal or a cash-out.
- **Adults only.** An 18+ confirmation is required (a tickbox at sign-up, re-checked by the database).
- **Honest about simulation.** KYC, AML, the Triple Green pot and coin rain are demonstrations and are labelled so.

## Stack

| Layer | Choice |
|---|---|
| Page | TypeScript 7, Vite 8, no UI framework; hash routes (`#/…`) in `src/app.ts` |
| Hosting | Vercel, static build (`dist/`); the admin site is a separate build (`dist-admin/`) with its own project config (`vercel.admin.json`) |
| Database and accounts | Supabase: Postgres with row-level security, Auth (Google, e-mail, Steam through an Edge Function), Realtime |
| Server code | SQL functions in `supabase/migrations/` (security definer, fixed search path); Edge Functions `steam-login` and `close-login` |
| Tests | Vitest 5 with happy-dom (page) and PGlite (every migration runs in an in-process Postgres) |
| Runtime packages | One: `@supabase/supabase-js`, loaded only when the backend is configured |
| Node | 22.12 or newer |

## Two modes

| Mode | When | Where coins, items and limits live |
|---|---|---|
| Cloud (the live site) | `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set | In the database. The page only mirrors them and cannot change them |
| Browser-only fallback | Variables empty | In the browser's storage, per local account. For local demos and testing |

## Functional requirements

- **Accounts:** sign up and sign in with Google, Steam or e-mail; sign-out clears the view; an account with an authenticator app enters its code after every sign-in method; each account has its own data; account deletion anonymises the profile and closes the login.
- **Games:** every stake goes through one database gate (`wallet_gate`): age, self-exclusion, cool-off, maximum bet, verification cap (10,000 / 25,000 / 50,000), daily wager, daily, weekly and monthly loss, and play time. Outcomes come from server seeds that can be re-checked (provably fair).
- **Cases:** 50 paid cases plus reward crates built from real Counter-Strike 2 items (14,411 priced items, 1.64 coins per US dollar); every case shows each item's chance and ticket range and a risk label.
- **Live play:** battles (1v1 up to 6 players and teams, 7 modes), coinflip, shared Crash and Double rounds, chat and a bet feed between real players.
- **Responsible play:** limits that tighten at once and loosen after 24 hours, cool-off, self-exclusion, reality check, self-assessment.
- **Admin site:** three-step sign-in (Steam, authenticator, admin password), roles and permissions, append-only audit log, read-only data explorer, site controls, Wallets page.
- **Operator alerts:** optional, through n8n (big wins, coins added by hand, admin actions, maintenance, a daily report).

## Non-functional requirements

| Area | Requirement |
|---|---|
| Security | No secret in the page or the repository; row-level security on every table; clients cannot call helper functions; strict security headers (CSP with scripts only from the site, no framing); rate limits on chat and promo codes; admin actions audited. See the security sections of [audit-2026-11-22.md](audit-2026-11-22.md) |
| Privacy | No IP address or country is stored (the country header is read and thrown away); personal data never in the public repository |
| Integrity | A stake and its result happen in one database transaction; a payout is never made twice; a repeated admin adjustment pays once |
| Layout | Works from 375 px phones to wide desktops without sideways page scrolling; big battles scroll sideways on phones |
| Accessibility | Every control has a name; dialogs take and return focus; Escape closes them; reduced motion is respected |
| Performance | Main bundle about 545 KB (180 KB compressed); the database client (216 KB) loads only when needed; item files load on demand |
| Quality | Typecheck, all tests and the build must pass before a commit; CI runs them on every branch |

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `.env` and Vercel | The database address and its publishable key (safe in the browser) |
| `VITE_STEAM_LOGIN` | `.env` and Vercel | `on` shows the Steam button |
| `VERCEL_PROJECT_PRODUCTION_URL` | Set by Vercel itself during the build | The production address, written into the link-preview tags (`og:image`, `og:url`); never stored in the repository |
| `SITE_URLS` | Supabase secret | Addresses the Steam sign-in may return to |
| n8n settings | `n8n/.env` (never committed) | See [n8n.md](n8n.md) |

## Constraints and known simplifications

- The play-time limit is estimated from stakes (the server cannot see an open page).
- A live game's stake counts toward the loss limits only when its round settles.
- Item pictures load from Valve's servers.
- The 25 newest case pictures are placeholders.
- SQL changes are run by hand by the owner, in order, before the matching site deploy.
