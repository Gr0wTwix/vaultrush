# Architecture

## Stack

TypeScript 7, Vite 8, Vitest 5 with happy-dom. No UI framework: each view is a module that renders HTML strings into `#view` and wires its own events. State lives in `localStorage` (and, optionally, in Supabase).

Two TypeScript configs: `tsconfig.json` is loose and covers the whole app; `tsconfig.strict.json` has `strict: true` and covers the core modules (fairness, responsible gambling, KYC, AML, RNG, accounts, sign-up rules, profile stats). `npm run typecheck` runs both.

## Layout

```
src/
  app.ts            shell: sidebar, top bar, router, avatar menu, start-up order
  state.ts          the player state, debit/credit/grant, the sign-in gate (requireLogin)
  accounts.ts       browser accounts: PBKDF2 hashes, lockout, per-account storage keys
  auth.ts           Log in / Register modal, finish-profile step, click guard, session wiring
  backend.ts        optional Supabase client (lazy-loaded), auth, 2FA, rpc wrappers
  company.ts        fictional operator details used by the footer and legal pages
  footer.ts         the site footer (operator, disclaimers, 18+ strip, link columns)
  live.ts           live multiplayer client: lobbies, realtime, chat, shared feed, settle-once helpers (see live-multiplayer.md)
  signup.ts         username, email and password rules, terms version
  fair.ts           provably fair seeds, HMAC floats, game mappings
  rg.ts, rgui.ts    responsible-gambling rules and their UI (limits, cool-off, reality check)
  kyc.ts, aml.ts    sandbox verification tiers and monitoring rules
  rng.ts, rnglab.ts NIST SP 800-22, FIPS 140-2, SP 800-90B health monitor and the lab UI
  account*.ts       the account window and its tabs
  profile-stats.ts  numbers for the account overview
  views/            one module per page (home, cases, battles, crash, double, ...)
  css/              app.css plus one file per area; compliance.css holds auth, limits, KYC, overview
supabase/
  migrations/0001_core.sql   schema, row-level security, functions
  migrations/0002_live.sql   live battles and coinflip lobbies, server-drawn seeds, realtime publication
  migrations/0003_live_erasure.sql   delete_account() also replaces the name in live games
  functions/steam-login      Steam OpenID sign-in
  functions/close-login      finishes account deletion
  functions/_shared          Steam OpenID verification and name/avatar parsing (unit-tested)
tests/               fairness, SQL (PGlite), RNG, KYC, AML, accounts, sign-up, Steam, avatar, state
```

## Start-up order

`app.ts` renders the shell, then `initRg()` (age gate for signed-in accounts, play-time ticks), then `initAuth()`.

`initAuth()` decides who is signed in:

- **No backend configured:** signed in means a browser account is active (`vaultrush.active` in `localStorage`).
- **Backend configured:** signed in means a Supabase session exists; this is checked asynchronously and the page starts signed out until it is known.

It then calls `setAuthed(...)` in `state.ts`.

## State

`state` is one mutable object, loaded from `localStorage` under a per-account key (`vaultrush.state.v1.<id>`). Signed-out visitors use `vaultrush.state.v1`, which is never written to.

`setAuthed(false)` replaces the object's contents with a blank state (no balance, items, seeds or history) and turns `save()` into a no-op. `setAuthed(true)` reloads the real state. Because the object is shared, every view sees the change.

**One key per account.** Browser accounts use their local id; cloud accounts use `c-<Supabase user id>`, so `vaultrush.state.v1.c-<uuid>`. `setAuthed(on, id)` switches the key and reloads that person's state, and `useFairFor(id)` does the same for seeds. Before 2026-11-20 cloud accounts all used the shared guest key, so every account on one browser showed the same balance; that old shared data is no longer read, and each cloud account starts with 100 coins. Game state (everything except Crash) is still kept in the browser, so an account does not follow the player to another browser or device.

Fairness seeds are separate (`fair.ts`, key `vaultrush.fair.v1.<id>`). The Fairness page hides "Your seeds" while signed out.

## The gates

Two layers stop signed-out visitors from acting. Both live in `state.ts` and `auth.ts`.

1. **State layer (cannot be bypassed from the UI).** `debit()` and `grant()` call `requireLogin()`. If nobody is signed in, the login popup opens and the call returns false (or does nothing). `debitError()` reports "Log in or register to place bets."
2. **Click guard (explains the action).** `guardActions()` in `auth.ts` listens in the capture phase. It only acts on elements that opt in with `data-needs-auth="<kind>"` (`bet`, `battle`, `claim`, `upgrade`, `inventory`, `chat`, `rain`, `seeds`). For those it stops the event, opens the popup with the reason for that kind, and never runs the page's own handler. It also stops the promo and chat forms while signed out. Public tools (Verify, the RTP check, the RNG lab) never carry the attribute, so they keep working. Buttons with `data-auth-open="register|login"` simply open the popup on that tab.

Browsing, filters, tabs and normal links are not guarded.

A bet also passes through `betBlockReason()` in `rg.ts` (age, self-exclusion, cool-off, max bet, loss limits, verification-tier cap). That is the single bet gate for responsible-gambling rules.

## Avatars

`avatar(name, size)` in `ui.ts` draws a letter avatar. For the signed-in player's own name it draws `state.avatar` instead, but only when it is an `https:` URL (Steam's and Google's pictures). Other players always get letters.

## Adding things

- **A new game or action:** take the wager with `debit()` (it applies every gate), pay out with `credit()`, log bonuses with `grant()`. Put `data-needs-auth="bet"` (or another kind) on its button.
- **A new stored setting:** add it to `newGameState()` and `GameState` (`types.ts`). `load()` merges saved data over the defaults, so old saves keep working.
- **A new page:** add a module under `views/`, import it in `app.ts`, add a route to `ROUTES`. Note the Race page route is `#/leaderboard`.

## Accessibility building blocks

- `modal()` in `ui.ts` is the one dialog helper: it names the dialog (from `label` or its first heading), moves focus in, traps Tab, makes `.app` inert, returns focus to the opener, and supports `locked` and `backdropClose: false`. The age gate and reality check in `rgui.ts` follow the same rules.
- `toast()` messages go to a polite live region. `toastKeep()` (or `force`) is for messages that Settings > Notifications must never hide: limits, sign-in, breaks.
- One global `:focus-visible` ring in `app.css`; `--dim` is for decoration only, small text uses `--muted`.
- Account window redraws keep keyboard focus (`keepFocus` in `account.ts`).
- Signed-in state changes emit an `auth` event; `app.ts` re-renders the current page on it.
- The phone bottom bar shows Home, Cases, Battles and Crash plus a **More** sheet with every page.
