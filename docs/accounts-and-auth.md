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

## Two modes

### 1. No backend (default): browser accounts

Used when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set.

- `accounts.ts` stores accounts in `localStorage`: username, email, a PBKDF2-SHA256 hash (200,000 iterations, per-account salt). After 5 wrong attempts a 30-second lockout applies. The same generic error is shown for an unknown user and a wrong password.
- Each account has its own state and fairness keys. Registering starts a fresh account (100 play coins); old guest progress is not carried over.
- Google and Steam say they need a backend.
- This is a demonstration. Anyone with access to the browser can edit its storage, so it protects nothing.

### 2. With Supabase: cloud accounts

Used when the two Supabase variables are set. Email and password, Google and Steam all go through Supabase Auth. Wallet, bets and seeds can live in Postgres (only Crash runs server-side so far). Setup is in [deploy-and-workflow.md](deploy-and-workflow.md) and [../supabase/README.md](../supabase/README.md).

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
