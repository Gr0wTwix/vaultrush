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

Only **Crash** runs on the server so far. Other games, the full limit set (weekly/monthly loss, time limits), KYC and AML on the server, and wiring the chat UI to the realtime table are the next steps.

## Set it up

1. Create a project at supabase.com (the free tier is enough).
2. Run the schema: paste `migrations/0001_core.sql` into the SQL editor, or use the CLI (`supabase link`, then `supabase db push`).
3. Authentication > Providers: keep **Email** on. Authentication > URL configuration: add your site URL (and `http://localhost:5173`) as a redirect URL.
4. Project settings > API: copy the **Project URL** and the **anon public** key.
5. Locally: copy `.env.example` to `.env` and fill in the two values. On Vercel: add them as environment variables.
6. Open the site, then Account > **Cloud Account**.

Never put the `service_role` key in the website: it bypasses every protection here. It is only for trusted server code, for example an Edge Function that sets `account_controls.kyc_tier` after a real KYC vendor approves someone.

## Tests

`npm test` runs `tests/db.test.ts`, which applies this migration to an in-process Postgres (PGlite) with Supabase-style roles and checks the bet maths against the TypeScript game code, the gate rules, seed handling and row-level security. It does not talk to a real Supabase project.
