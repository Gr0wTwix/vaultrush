# Testing guide

How Vaultrush is tested, how to add tests, and what to check by hand before a release. Last updated 2026-11-25.

## Commands

| Command | What it runs |
|---|---|
| `npm run typecheck` | TypeScript, loose config for the whole app and strict config for the game core |
| `npm test` | Every test (about 930 in 59 files), usually 15 to 20 seconds |
| `npx vitest run tests/<file>.test.ts` | One file |
| `npm run build` and `npm run build:admin` | The production builds (each also type-checks) |

GitHub CI runs the typecheck, the tests and the build on every push to every branch (`.github/workflows/ci.yml`). There is no lint script.

## Kinds of tests

| Kind | Environment | Examples |
|---|---|---|
| Rules and maths | happy-dom or node | `fair.test.ts`, `rg.test.ts`, `battle-math` through `live-battles.test.ts` |
| Database | node + PGlite: the real migrations run in an in-process Postgres with Supabase-style roles | `wallet-db.test.ts`, `server-limits-db.test.ts`, `admin-wallet-db.test.ts`, `rate-limits-db.test.ts` |
| Page against a fake server | happy-dom, `vi.mock('../src/backend.js')` replaces `call` | `wallet-client.test.ts`, `rg-server.test.ts`, `admin-app.test.ts` |
| Screens | happy-dom, render a view into a `<main>` and click | `reference-ideas.test.ts`, `audit-fixes.test.ts` |
| Configuration guards | node, read files | `security-headers.test.ts`, `admin-deploy.test.ts`, `mobile-css.test.ts` |

## Writing a test

- **Database tests:** copy the setup of `tests/rate-limits-db.test.ts` (the prelude with `auth.uid()`, roles, the `as()` and `rpc()` helpers), list the migrations the feature needs, and set `vi.setConfig({ testTimeout: 60_000 })`. Give every test its own player so nothing leaks between tests. Move time by updating `created_at` columns rather than waiting.
- **Page tests:** mock `call` in `src/backend.js`, and make new database calls go through `call` in the module under test so the fake intercepts them.
- **Files:** a test that reads a file needs `// @vitest-environment node` (happy-dom cannot build a `file:` URL); `import x from '…?raw'` returns an empty string for CSS here.
- **Animations:** stub `Image` (happy-dom never fires `onload`) and use fake timers for reels.
- **Timing:** heavy files may exceed the default 5 s under a full parallel run; raise the file's timeout instead of making the test weaker. Run the whole suite two or three times after touching timing.
- **Check the test fails without the fix** before relying on it.

## Testing in a browser

- **Without the real database:** run the site with the Supabase variables set to empty strings (they then override `.env`), register a throw-away local account and play freely. Nothing reaches the real project.
- **Security headers:** build, then serve `dist` with the headers from `vercel.json` (a tiny Node static server is enough) and watch for `securitypolicyviolation` events and console errors on every page.
- **Phones:** check at 375 px wide; look for sideways scrolling, clipped text and controls hidden behind the bottom bar.

## Before a release (by hand)

1. Sign in (Google or Steam) and out; switch accounts.
2. Open a case; the item is in the inventory and the balance changed by the price.
3. Play one round of a live game with a second person or a bot.
4. Sell an item; try a wrong promo code.
5. Open Account → Responsible Play; set and loosen a limit.
6. Look at a phone-width window.
7. On the live site after the deploy: the served script file is the one built locally, there are no console errors, the security headers are present.

## What automated tests cannot cover

The real Supabase project (Realtime delivery, the Auth settings in the dashboard), Steam and Google themselves, real phones, and n8n. These are checked by hand and recorded in [setup-status.md](setup-status.md).
