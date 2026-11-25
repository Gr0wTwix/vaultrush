# Deploy and workflow

What is actually set up on this project (and what is not) is listed in [setup-status.md](setup-status.md); this page explains how to do each step.

## Everyday commands

| Command | Use |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173 (restart it after changing `.env`) |
| `npm test` | All tests (about 660) |
| `npm run typecheck` | Loose and strict TypeScript |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run build:catalogue` | Download the CS2 item list and Skinport prices and regenerate `public/catalogue/`, `src/catalogue/cases.generated.json` and `supabase/migrations/0014_*` and `0015_*` (see [real-catalogue.md](real-catalogue.md)) |
| `npm run dev:admin` | The separate admin site at http://localhost:5174 |
| `npm run build:admin` | Build the admin site to `dist-admin/` |

CI (`.github/workflows/ci.yml`) runs the type-check, tests and build on pushes to **every branch** and on pull requests; a newer push to the same branch cancels the run still going. Until 2026-11-21 it ran only on pushes to `main` and on pull requests, so nothing between PR #2 and that date had been checked by CI (the tests were run locally each time). Look at the results with `gh run list`.

Tests always run **without** a backend, whatever is in `.env`: `vite.config.ts` blanks the three variables for the test run.

## Environment variables

| Variable | Meaning |
|---|---|
| `VITE_SUPABASE_URL` | Project URL, `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | The **publishable** key (`sb_publishable_...`) or the legacy anon key. Both are safe in the browser |
| `VITE_STEAM_LOGIN` | `on` once the `steam-login` function is deployed |

On this project all three are set both locally and in Vercel Production. Locally they go in `.env` (gitignored). On Vercel they are project environment variables for Production. Vite reads them at build time, so changing them needs a rebuild or redeploy.

**Never put the `service_role` key or a `sb_secret_...` key in the site, in `.env`, or in the repository.** Only Edge Functions use the service role, and Supabase injects it for them.

## Supabase setup (once per project)

1. Create a project. In the create form, leave "Enable Data API" on and turn **off** "Automatically expose new tables" (the migration sets its own grants and row-level security).
On this project's database migrations `0001` to `0027` have all been run; the notes under each step say what a database that has **not** run it would do.

2. SQL editor: run `supabase/migrations/0001_core.sql`. A "destructive operations" warning is expected because the script revokes default grants.
   Then run `supabase/migrations/0002_live.sql` (live battles, coinflip and the realtime tables; see [live-multiplayer.md](live-multiplayer.md)). The site works without it and keeps the simulated lobbies.
   Then run `supabase/migrations/0003_live_erasure.sql` (account deletion also removes the name from live games; the Privacy Policy relies on it).
   Then run `supabase/migrations/0004_claims_bots_caps.sql` (once-per-account free crates enforced by the server, the coinflip house bot, and the unverified bet cap of 1,000). The site keeps working without it: free crates then use the browser-only rule and the server-side Crash demo keeps the old cap of 50.
   Then run `supabase/migrations/0005_rounds.sql` (shared Crash and Double rounds). Without it those two games stay solo with simulated players.
   Then run `supabase/migrations/0006_admin.sql`, and make yourself the Owner with the one statement at the end of that file (see [admin-site.md](admin-site.md)).
   Then run `supabase/migrations/0007_site_controls.sql` (maintenance, notice, game switches, sign-ups and country restrictions that the admin site flips; the game site checks them). Without it nothing breaks: the game site simply finds no controls.
   Then run `0008_wallet.sql`, `0009_catalogue.sql`, `0010_solo_games.sql`, `0011_live_wallet.sql` and `0012_rewards.sql` in that order: the **server wallet** (coins and items in the database, every game on the server). 0011 closes waiting games without refunds. See [server-wallet.md](server-wallet.md). Then run `0013_crash_pace.sql` (a slower Crash; run it together with the matching site deploy, because the page and the database must use the same pace). Then run `0014_real_items_1.sql` to `0014_real_items_5.sql` and `0015_real_cases.sql` in that order (the real CS2 catalogue; deploy the site with them). Then `0017_bet_caps.sql` (verification only above 10,000 coins; deploy the site with it, the page uses the same caps). Then `0018_server_limits.sql` (every responsible-play limit enforced by the database; deploy the site with it) and `0019_admin_wallet.sql` (the admin site's Wallets page). Then `0020_rate_limits.sql` (chat and promo-code rate limits; run it before deploying the site that understands the new promo answer). Then, optionally, `0016_ops_events.sql` (alerts and a daily report for n8n; sends nothing until switched on, see [n8n.md](n8n.md)). To refresh prices: `npm run build:catalogue`, deploy, run those files again.
3. Authentication, URL configuration: Site URL `http://localhost:5173`; Redirect URLs `http://localhost:5173/**` and the production site with `/**`.
4. **Google:** create an OAuth client (Web application) in Google Cloud Console with redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`; paste client ID and secret into Authentication, Providers, Google; turn it on.
5. **Steam (CLI, run in a terminal):**
   ```
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase secrets set SITE_URLS=http://localhost:5173,https://<production-site>
   npx supabase functions deploy steam-login
   npx supabase functions deploy close-login
   ```
   `supabase/config.toml` sets `verify_jwt = false` for `steam-login` (Steam calls it) and `true` for `close-login`. Docker warnings during deploy are harmless.
6. Set the three environment variables above.

Redeploy a function after changing its code. The linked-project files the CLI writes (`supabase/.temp/`) are gitignored; never commit them.

## Deploying the site to Vercel

The Vercel project is linked through `.vercel/` (gitignored). Production deploys have been made with the CLI from a clean export of the branch:

1. `git archive <branch>` into an empty folder, copy `.vercel/` into it.
2. In that folder: `npx --yes vercel@latest deploy --prod --yes`.

Why the export: deploying straight from the working folder was refused because the commit author is not a member of the Vercel team. The export avoids that.

Check afterwards: the deployment is Ready and aliased to the production domain; the served JavaScript bundle contains the project URL; the Log in popup opens; the Steam button reaches steamcommunity.com; the Google redirect reaches Google.

Vercel environment variables can be listed with `npx vercel env ls production` and added with `vercel env add NAME production`.

## n8n (operator alerts and the daily report)

The database file is `supabase/migrations/0016_ops_events.sql`; the setup, security and what is sent are in [n8n.md](n8n.md). To run n8n on your own PC (Docker Desktop):

| Command (from the `n8n` folder) | Use |
|---|---|
| `docker compose --profile tunnel up -d` | Start n8n, the gate and the ngrok tunnel (needs `n8n/.env`, copied from `n8n/.env.example`) |
| `docker compose --profile tunnel down` | Stop them (workflows and credentials stay in a Docker volume) |
| `docker compose logs n8n --tail 50` | See what n8n is doing |
| `docker compose pull` then `up -d` | Update n8n (after changing the pinned version in `docker-compose.yml` and testing the workflows) |

`n8n/.env` holds the n8n encryption key and the ngrok token: it is gitignored, never commit it, and keep a copy somewhere safe (without the key n8n cannot read its saved credentials). Alerts only arrive while the PC and Docker are running.

## Replacing pictures

Case pictures: `public/assets/cases/<case id>.webp`, 640 x 640, transparent. Home game tiles: `public/assets/home/<name>.webp`, 480 x 340. Replace the file (same name), run the tests, deploy. Details in [architecture.md](architecture.md) (Assets).

## Git and GitHub

- Branch per piece of work, pull request into `main`, CI must pass.
- Commits use the GitHub noreply identity. The repository is public.
- **Before every push**, scan tracked files and the new history for personal data, keys and IDs (names, e-mail addresses, machine paths, `sb_publishable`, `sb_secret`, project references, organisation IDs).
- Do not use `git add -A` blindly: it once picked up the Supabase CLI link folder. Check `git status` first.
- Ask before pushing, opening or merging pull requests, or deploying: these are public actions.

## Review rule for tools

Before installing any skill, plugin, slash command, hook or MCP server, review it with the skill-inspector skill and show the verdict. Installing a package through `npx --yes` on someone's terminal skips the confirmation prompt and was refused by the permission system; let the person approve the install prompt themselves.

## Mistakes already made (so they are not repeated)

- Steam's return address was built from the request URL, which behind Supabase's gateway is http and lacks `/functions/v1`. Build it from `SUPABASE_URL`.
- A mangled regex after a shell `sed`/string replace: prefer small Node patch scripts or the editor tool over shell heredocs with backticks and `$` characters.
- `String.replace` treats `$'`, `$$` and `` $` `` in the replacement text specially; use `split/join` or a function replacement.
- `crypto.getRandomValues` accepts at most 65,536 bytes per call; the RNG helpers chunk.
- Fake toggles are not allowed: every setting in the UI must change real behaviour.
- A signed-out preview tab can show "page navigated" errors if the page reloads inside a script; re-run the check on the new page instead.
- A test that counts real animation frames or waits on the real clock fails on a busy machine: use fake timers (`tests/reel.test.ts` does). Run the suite several times in a row after touching a timing-based test.
- Floating-point sums (`cp + 1`) can be 6.3500000000000005, which the database rightly refuses: round to cents before sending.
- Sorting a JSON field by its text sorts "5" after "100": sort by the number (the daily report once did).
- When n8n imports a workflow it may pick a credential by itself, sometimes the wrong one: open each node and check.
- `pg_net` does not retry: an alert sent while n8n is unreachable is lost.

## Deploying the admin site (its own Vercel project)

The game site's own security headers (a strict Content Security Policy and the usual headers) are in `vercel.json`; `tests/security-headers.test.ts` guards them.

The admin site is a second, separate Vercel project built from the same repository (`npm run build:admin` into `dist-admin/`). Its settings and security headers are in `vercel.admin.json` (no framing, no referrer, no search indexing, scripts only from itself, connections only to itself and the database; `tests/admin-deploy.test.ts` guards the file). The steps, and who does what, are in [admin-site.md](admin-site.md).
