# Vaultrush backend (Supabase)

Optional. Without it the site runs entirely in the browser. With it, a signed-in player's wallet, bets and seeds live in Postgres.

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

Only **Crash** runs on the server so far. Other games, the full limit set (weekly/monthly loss, time limits), KYC and AML on the server, and wiring the chat UI to the realtime table are the next steps.

## Set it up

1. Create a project at supabase.com (the free tier is enough).
2. Run the schema: paste `migrations/0001_core.sql` into the SQL editor, or use the CLI (`supabase link`, then `supabase db push`). Then run `migrations/0002_live.sql` the same way to switch on live battles and coinflip, `migrations/0003_live_erasure.sql` so deleting an account also removes the name from live games, and `migrations/0004_claims_bots_caps.sql` for once-per-account free crates, the coinflip bot and the 1,000-coin unverified bet cap, and `migrations/0005_rounds.sql` for shared Crash and Double rounds with everyone's bets visible, and `migrations/0006_admin.sql` for the admin site (roles, permissions, audit log; see `../docs/admin-site.md`), and `migrations/0007_site_controls.sql` for the switches the admin site uses on the game site (maintenance, notice, games, sign-ups, countries).
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
| Two-factor authentication (TOTP) | Authentication > Multi-factor: enable TOTP. Players set it up under Account > Security. |
| Steam | Not built into Supabase. Deploy the `steam-login` Edge Function: `supabase secrets set SITE_URLS=https://your-site.example,http://localhost:5173`, then `supabase functions deploy steam-login`, and set `VITE_STEAM_LOGIN=on`. |
| Account deletion | Deploy `close-login` as well: `supabase functions deploy close-login`. |

Every new player finishes through `complete_signup()`: the database checks that they confirmed they are an adult (a tickbox, no date of birth is collected), that a terms version was accepted, and that the username is valid and unused, then creates the wallet and the first two seeds. Google and Steam players pick a username in a one-step form after their first login.

The Edge Functions have not been run against live Steam or Supabase. Their logic is covered by `tests/steam.test.ts`.
