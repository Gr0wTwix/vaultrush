# Vaultrush (play-money prototype)

An original skin-game site prototype. **Play money only**: coins can't be bought or withdrawn.

- **Games**: case opening (1–6 at once, 3 speeds, ticket ranges), case battles (6 formats incl. 2v2/3v3, 7 modes), crash (partial cash-outs), double (Triple Green pool), plinko, mines (4×4–8×8), multi-coin flip, upgrade (under/over).
- **Rewards**: levels/XP, instant/daily/weekly rakeback, welcome and daily free cases, level cases every 10 levels, promo codes, 7-day login streak, daily race leaderboard.
- **Platform**: live drops and bets, chat with coin rain, an account window (profile, history, transactions, settings, self-exclusion), and a provably fair seed system with a verifier for every game.

## Stack

TypeScript, [Vite](https://vite.dev) and [Vitest](https://vitest.dev). No framework: views are plain modules that render into the page, and state is kept in `localStorage`.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-checks, then builds the site into `dist/` |
| `npm run preview` | Serves the production build locally |
| `npm run typecheck` | `tsc` with the loose config (whole app) and the strict config (game core) |
| `npm test` | Unit tests for the fairness maths, odds tables, wallet rules and verifier |

Node 22.12 or newer is required.

## Structure

```
index.html            app shell (Vite entry)
public/assets/        images served as-is: cases, home
public/catalogue/     the whole CS2 item catalogue (search index and item files), loaded on demand; generated
src/app.ts            router, sidebar, top bar, live-drop ticker, chat button
src/types.ts          shared domain types
src/fair.ts           provably fair (HMAC-SHA256) + every game's maths and payout tables   [strict]
src/state.ts          balance, inventory, XP/levels, rakeback, bet history, self-exclusion   [strict]
src/data.ts           the cases and reward cases (generated, with the items inside them), grades, helpers [strict]
src/catalogue.ts      the full real CS2 catalogue, loaded on demand (search, paging, items an inventory holds)
src/verify.ts         bet re-computation, house-edge simulation, uniformity test            [strict]
src/race.ts           daily race standings (simulated rivals) and prize payout              [strict]
src/feed.ts           simulated live drops and bets (stand-in for a WebSocket feed)         [strict]
src/account.ts        account window; src/chat.ts simulated chat and coin rain
src/fx.ts, sfx.ts     canvas particle effects and generated Web Audio sounds
src/ui.ts, art.ts     shared UI helpers, item and case art
src/views/*.ts        one file per page
src/css/*.css         styles, bundled by Vite
tests/                Vitest suites
```

Files marked **[strict]** are checked with `strict: true` (`tsconfig.strict.json`). The view files are checked with the looser `tsconfig.json`, where DOM helpers return `any`; tightening them is the next step.

## House edge settings

`HOUSE` in `src/fair.ts`: cases 90% RTP, crash/mines/plinko/coinflip 97%, upgrade 95% (max 80% chance), double 93.3%. The tests recompute these from the real functions, and the Fairness page can simulate them in the browser. Demo promo codes are in `src/views/rewards.ts`.

## Deploying

`vercel.json` runs `npm ci` and `npm run build` and serves `dist/`. The repository also has a GitHub Actions workflow (`.github/workflows/ci.yml`) that type-checks, tests and builds every push.

## Going to production

Move every outcome and the server seed to a backend (Node + Postgres + Redis + WebSockets), add real auth, and only add deposits or withdrawals with a gambling licence, KYC/AML and responsible-gambling tools.

## Documentation

How it is built, how accounts and Google/Steam sign-in work, the compliance tooling, deployment steps and the project history are in [docs/](docs/README.md).
