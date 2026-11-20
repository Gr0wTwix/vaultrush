# Deploy and workflow

## Everyday commands

| Command | Use |
|---|---|
| `npm run dev` | Dev server at http://localhost:5173 (restart it after changing `.env`) |
| `npm test` | All tests (about 250) |
| `npm run typecheck` | Loose and strict TypeScript |
| `npm run build` | Type-check, then build to `dist/` |

CI (`.github/workflows/ci.yml`) runs the tests, type-checks and build on every push and pull request.

Tests always run **without** a backend, whatever is in `.env`: `vite.config.ts` blanks the three variables for the test run.

## Environment variables

| Variable | Meaning |
|---|---|
| `VITE_SUPABASE_URL` | Project URL, `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | The **publishable** key (`sb_publishable_...`) or the legacy anon key. Both are safe in the browser |
| `VITE_STEAM_LOGIN` | `on` once the `steam-login` function is deployed |

Locally they go in `.env` (gitignored). On Vercel they are project environment variables for Production. Vite reads them at build time, so changing them needs a rebuild or redeploy.

**Never put the `service_role` key or a `sb_secret_...` key in the site, in `.env`, or in the repository.** Only Edge Functions use the service role, and Supabase injects it for them.

## Supabase setup (once per project)

1. Create a project. In the create form, leave "Enable Data API" on and turn **off** "Automatically expose new tables" (the migration sets its own grants and row-level security).
2. SQL editor: run `supabase/migrations/0001_core.sql`. A "destructive operations" warning is expected because the script revokes default grants.
   Then run `supabase/migrations/0002_live.sql` (live battles, coinflip and the realtime tables; see [live-multiplayer.md](live-multiplayer.md)). The site works without it and keeps the simulated lobbies.
   Then run `supabase/migrations/0003_live_erasure.sql` (account deletion also removes the name from live games; the Privacy Policy relies on it).
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
