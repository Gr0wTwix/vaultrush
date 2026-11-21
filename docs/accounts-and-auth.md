# Accounts and sign-in

## What a visitor can do

| | Signed out | Signed in |
|---|---|---|
| Browse every page, games, cases, leaderboards, legal pages | yes | yes |
| See balance, inventory, seeds, the avatar menu, the "Welcome back" bar | no | yes |
| Bet, open cases, claim rewards or rakeback, sell, upgrade, create or join a battle, chat, redeem promo codes | no: the login popup opens with the reason | yes |

The top-right **Log in** button opens the popup. Signing out is in the avatar menu.

## The Log In / Register popup

- Tabs: **Log In** and **Register**.
- Log in: email (cloud) or email/username (browser accounts), password with a Show button, "Forgot password", and a 2FA code field when a backend is connected.
- Register: email, username, password, confirm password, and two tickboxes: "I am at least 18" and "I agree to the Terms and Privacy Policy".
- Extra options: **Google** and **Steam** only. There is no Twitch or Discord, no date of birth and no "gambling is allowed where I live" tickbox. Age is a tickbox here and stronger checks live in the sandbox verification (see [compliance.md](compliance.md)).
- Password rules (`signup.ts`): at least 10 characters, at most 72 bytes, not a common password, not containing the username or the email name.
- The popup follows the site's own design (lime primary button, dark panels), not any reference site's.
- First-time visitors sent here by a bet or claim land on **Register**; a browser that has had an account lands on **Log in** (`vaultrush.known` in `localStorage`). Typed email and username survive switching tabs; passwords do not.
- Errors are linked to their fields (`aria-describedby`, `aria-invalid`), summarised once above the submit button, and focus moves to the first problem. The tabs are real ARIA tabs with arrow-key support.
- The 2FA code field appears only after the server says the account uses 2FA. Without a backend, Google and Steam are shown switched off with a plain explanation.
- After a cloud sign-up that needs e-mail confirmation the form is replaced by a "Check your inbox" panel with a resend button.
- On phones the Register tab shows Google and Steam first, and the popup states that coins are play money.

## Two modes

The mode is chosen when the site is built, by two variables. **The live site and the owner's local setup run in Supabase mode (cloud accounts):** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set in `.env` and in Vercel Production (checked 2026-11-21, see [setup-status.md](setup-status.md)). The browser-only mode is the fallback for when they are **not** set: a fresh clone with no `.env`, and the test run (which blanks them on purpose).

### 1. With Supabase: cloud accounts (what the live site uses)

Email and password, Google and Steam all go through Supabase Auth. With the server wallet (migrations 0008 to 0012) the wallet, items, rewards, bets and seeds live in Postgres and every game runs on the server (see [server-wallet.md](server-wallet.md)). Setup is in [deploy-and-workflow.md](deploy-and-workflow.md) and [../supabase/README.md](../supabase/README.md).

### 2. No backend: browser accounts (the fallback)

Used when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set.

- `accounts.ts` stores accounts in `localStorage`: username, email, a PBKDF2-SHA256 hash (200,000 iterations, per-account salt). After 5 wrong attempts a 30-second lockout applies. The same generic error is shown for an unknown user and a wrong password.
- Each account has its own state and fairness keys. Registering starts a fresh browser account (100 play coins; cloud accounts start with 0); old guest progress is not carried over.
- Google and Steam say they need a backend.
- This is a demonstration. Anyone with access to the browser can edit its storage, so it protects nothing.

## After the first cloud login

A new cloud user has no profile yet. `initAuth()` calls `hasProfile()`; if there is none:

- **Email sign-up:** the form's metadata (name, terms version, adult flag) completes the profile automatically.
- **Google:** a small "Choose a username" form asks for a username plus the 18+ and Terms boxes.
- **Steam:** the Steam name is used, so only the two boxes are asked ("Almost there. Signed in with Steam as <name>"). If the name is taken or reserved, a short number is added; if that fails too, the username field appears.

The database function `complete_signup(name, terms_version, adult)` enforces the adult flag, the terms version and a valid, unused username. It then creates the wallet and the first two seeds.

## Profile picture

- Steam: the Edge Function reads `avatarFull` from the public Steam profile and stores it as `steam_avatar` in the user's metadata (https `steamstatic.com` addresses only).
- Google: `avatar_url` or `picture` from the login.
- The client copies it to `state.avatar` after login and redraws the top-bar avatar. Failed images fall back to the letter.

## Steam sign-in (Edge Function `steam-login`)

Steam uses OpenID 2.0, which Supabase does not provide. The flow:

1. The site opens `.../functions/v1/steam-login?action=start&site=<site>`.
2. The function redirects to Steam with a return address built from `SUPABASE_URL`. This matters: behind Supabase's gateway the request URL is http and loses the `/functions/v1` prefix, so the return address must not be taken from the request.
3. Steam returns to `action=cb`. The function verifies the assertion with Steam (`check_authentication`) plus local checks (return address, namespace, endpoint, signed fields, nonce age) in `_shared/steam-openid.ts`.
4. It creates or finds a login with a reserved address `steam-<id>@steam.vaultrush.invalid`, reads the Steam name and picture, and stores them in the user's metadata.
5. It redirects to the site with a one-time token (`#steam_token=`). The client exchanges it for a session with `verifyOtp`.

Only origins listed in the `SITE_URLS` secret are accepted as the site address. The function is deployed with `verify_jwt = false` (see `supabase/config.toml`) because Steam, not a logged-in user, calls it. Steam needs no API key.

## Google sign-in

Standard Supabase OAuth. It needs a Google Cloud OAuth client (type Web application) whose authorised redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`, and its client ID and secret pasted into Supabase under Authentication, Providers, Google. If the Google consent screen is in Testing mode, add the people who will sign in as test users.

## Signing out and deleting an account

- Log out: clears the active account (browser mode) or the Supabase session, then reloads.
- Cloud account deletion (Account, Cloud Account): `delete_account()` anonymises the profile and zeroes the wallet; the `close-login` function then scrambles the login email and bans it. Bets and ledger rows stay without a name as financial records.
- Data export: `export_my_data()` returns the player's own data as JSON.
