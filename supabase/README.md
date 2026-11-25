# Vaultrush backend (Supabase)

The live site uses it (the two Supabase variables are set; see [../docs/setup-status.md](../docs/setup-status.md)). Without it (a fresh clone with no `.env`) the site runs entirely in the browser. With it, a signed-in player's wallet, items, rewards, bets and seeds live in Postgres.

## What is implemented

| Feature | Where |
|---|---|
| Accounts (email link sign-in), wallet, append-only ledger | `ensure_account()`, tables `profiles`, `wallets`, `ledger` |
| **Server-side fairness**: the seed is secret, the roll is drawn by the database | `place_bet()`, `seed_pairs` (no client access), view `my_seeds` |
| Commit and reveal: next seed hash is stored before use, `rotate_seed()` reveals the old one | `rotate_seed()` |
| Same maths as the browser: `HMAC-SHA256(serverSeed, clientSeed:nonce:0)`, crash point | tested against `src/fair.ts` in `tests/db.test.ts` |
| Responsible-gambling gate on every bet (age, exclusion, cool-off, max bet, daily loss limit, verification tier cap) | `place_bet()` |
| Tighten limits now, loosen after 24 h; exclusion can only grow | `request_limit_change()`, `self_exclude()` |
| Nonce can never repeat; retried requests cannot double-bet | `unique (seed_id, nonce)`, `unique (user_id, idem_key)` |
| Row-level security; clients cannot write money, bets, seeds, controls or the ledger | policies and revoked grants |
| Real leaderboard | view `daily_race` |
| Realtime chat (database side) | `chat_messages` and the `supabase_realtime` publication |
| **Live multiplayer** (case battles and coinflip between real players, secret seed revealed at the start) | `migrations/0002_live.sql`: `live_battles`, `live_coinflips`, `create_/join_/leave_live_battle()`, `call_live_bot()`, `create_/join_/cancel_live_coinflip()`; tested in `tests/live-db.test.ts`. See `../docs/live-multiplayer.md` |
| **Server wallet**: coins, items and rewards in the database; every game (cases, upgrade, plinko, mines, coinflip, battles, crash, double) and every reward is drawn and paid by the database | `migrations/0008` to `0013` (see `../docs/server-wallet.md`) |
| **Real CS2 catalogue**: all priced items, the cases and their drop tickets | `migrations/0014_real_items_*.sql`, `0015_real_cases.sql` (generated, see `../docs/real-catalogue.md`) |
| **Admin and site controls**: roles, permissions, audit log, maintenance, notice, game switches, sign-ups, countries | `migrations/0006_admin.sql`, `0007_site_controls.sql` (see `../docs/admin-site.md`) |
| **Verification only above 10,000 coins**: the stake caps by verification level are 10,000 / 25,000 / 50,000, and the live games' hard limit is 50,000 | `migrations/0017_bet_caps.sql` (patches `wallet_gate`, `place_bet`, the three live-game entry points and the coinflip table rule; see `../docs/compliance.md`) |
| **Every responsible-play limit enforced by the database**: weekly and monthly loss, daily wager, play time, cool-off and self-exclusion (plus the older max bet and daily loss); `my_limits()` for the page | `migrations/0018_server_limits.sql` (rewrites `wallet_gate`, `request_limit_change`; adds `start_cool_off`; see `../docs/compliance.md`) |
| **Admin wallet tools**: totals, player search, wallet overview, ledger and bets viewers, the owner's audited coin adjustment | `migrations/0019_admin_wallet.sql` (see `../docs/admin-site.md`) |
| **Admin step E part 1**: reward settings (faucet, rakeback, calendar, race prizes) read by the reward functions and the page, promo-code management, announcements shown through the site status | `migrations/0023_rewards_admin.sql` (after 0022) |
| **Admin step C, the catalogue editor**: case versions you can restore, the published catalogue the game site reads, editing cases with checks (chances add up to 100%, 70% to 98% return, real items only, no re-pricing while a waiting battle uses the case), switching cases on and off. **Re-running 0015 afterwards undoes edits** | `migrations/0022_catalogue_editor.sql` (after 0021) |
| **Admin step B**: player notes and tags, mutes, warnings, betting and site bans, sign-out, rename, claim reset, closing accounts; chat moderation (remove, clear, pin, staff messages, lock, slow mode, links, blocked words, player reports); live-room and round tools; the dashboard | `migrations/0021_admin_control.sql` (after 0020) |
| **Rate limits**: chat at most one message per 2 seconds and 10 a minute; promo codes at most 10 wrong tries per 10 minutes | `migrations/0020_rate_limits.sql` (a chat trigger, `promo_attempts`, a new `redeem_promo`; see `../docs/audit-2026-11-22.md`) |
| **Operator alerts and a daily report** for n8n (off until switched on, and now switched on in the live project; the settings table is readable by nobody but the owner) | `migrations/0016_ops_events.sql`: `ops_settings`, `ops_notify()`, `ops_daily_report()` (see `../docs/n8n.md`) |

Every game and reward now runs on the server (migrations 0008 to 0012, see ../docs/server-wallet.md). Every responsible-play limit is on the server since migration 0018, and the admin wallet tools since 0019. Still to come: KYC and AML on the server, and wiring the chat UI to the realtime table.

## Set it up

1. Create a project at supabase.com (the free tier is enough).
2. Run the schema: paste `migrations/0001_core.sql` into the SQL editor, or use the CLI (`supabase link`, then `supabase db push`). Then run `migrations/0002_live.sql` the same way to switch on live battles and coinflip, `migrations/0003_live_erasure.sql` so deleting an account also removes the name from live games, and `migrations/0004_claims_bots_caps.sql` for once-per-account free crates, the coinflip bot and the 1,000-coin unverified bet cap, and `migrations/0005_rounds.sql` for shared Crash and Double rounds with everyone's bets visible, and `migrations/0006_admin.sql` for the admin site (roles, permissions, audit log; see `../docs/admin-site.md`), and `migrations/0007_site_controls.sql` for the switches the admin site uses on the game site (maintenance, notice, games, sign-ups, countries), and `migrations/0008_wallet.sql` to `0012_rewards.sql` for the server wallet (coins and items in the database, every game server-side; see `../docs/server-wallet.md`), `migrations/0013_crash_pace.sql`, then `migrations/0014_real_items_1.sql` to `_5.sql` and `migrations/0015_real_cases.sql` for the real Counter-Strike 2 catalogue (generated; see `../docs/real-catalogue.md`), and optionally `migrations/0016_ops_events.sql` for alerts and a daily report through n8n (see `../docs/n8n.md`).
3. Authentication > Providers: keep **Email** on. Authentication > URL configuration: add your site URL (and `http://localhost:5173`) as a redirect URL.
4. Project settings > API: copy the **Project URL** and the **anon public** key.
5. Locally: copy `.env.example` to `.env` and fill in the two values. On Vercel: add them as environment variables.
6. Open the site, then Account > **Cloud Account**.

Never put the `service_role` key in the website: it bypasses every protection here. It is only for trusted server code, for example an Edge Function that sets `account_controls.kyc_tier` after a real KYC vendor approves someone.

## Tests

`npm test` runs `tests/db.test.ts`, which applies this migration to an in-process Postgres (PGlite) with Supabase-style roles and checks the bet maths against the TypeScript game code, the gate rules, seed handling and row-level security. It does not talk to a real Supabase project.

## Sign-in methods

| Method | Set up |
|---|---|
| Email and password | Authentication > Providers > Email (keep "Confirm email" on). Add your site URL and `http://localhost:5173` under URL configuration. |
| Google | Google Cloud Console > APIs & Services > Credentials > Create OAuth client ID (Web application). Add Supabase's callback URL (shown on Authentication > Providers > Google, `https://<ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI. Paste the client ID and secret into that Supabase page and turn Google on. |
| Two-factor authentication (TOTP) | Authentication > Multi-factor: enable TOTP. Players set it up under Account > Security. The site asks for the code after every sign-in method, so "Limit duration of AAL1 sessions" (sign out after 15 minutes without the code) can stay on. |
| Steam | Not built into Supabase. Deploy the `steam-login` Edge Function: `supabase secrets set SITE_URLS=https://your-site.example,http://localhost:5173`, then `supabase functions deploy steam-login`, and set `VITE_STEAM_LOGIN=on`. |
| Account deletion | Deploy `close-login` as well: `supabase functions deploy close-login`. |

Every new player finishes through `complete_signup()`: the database checks that they confirmed they are an adult (a tickbox, no date of birth is collected), that a terms version was accepted, and that the username is valid and unused, then creates the wallet and the first two seeds. Google and Steam players pick a username in a one-step form after their first login.

The Edge Functions have not been run against live Steam or Supabase. Their logic is covered by `tests/steam.test.ts`.
