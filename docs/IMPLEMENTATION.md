# Implementation guide

Step by step: how features are built, released and documented in Vaultrush. Last updated 2026-11-25. Read [architecture.md](architecture.md) for where the code lives and [TECHNICAL-REQUIREMENTS.md](TECHNICAL-REQUIREMENTS.md) for the limits every change must respect.

## Adding or changing a feature

1. **Read first.** Find the view in `src/views/`, its rules module (for example `src/rg.ts`, `src/double-history.ts`) and the SQL that backs it. Keep pure rules in their own module so they can be tested without a page.
2. **Database part (cloud mode).** Anything that moves coins or items, decides an outcome or enforces a limit belongs in SQL, never only in the page:
   - add a new numbered file in `supabase/migrations/` (`00NN_short_name.sql`), never edit an old one that has been run;
   - write functions as `security definer` with `set search_path = public, pg_temp`, check `auth.uid()`, and `revoke` / `grant` execute explicitly;
   - values go in as parameters; table or column names only through `format('%I')` from a fixed list;
   - make the file safe to run twice (`create or replace`, `if not exists`, the `patch_fn` pattern in `0017` for small changes to existing functions);
   - give errors short codes (`raise exception 'too_many_attempts'`) and add a readable text for each in `ERROR_TEXT` (`src/backend.ts`) or `ADMIN_ERRORS` (`src/admin/api.ts`). Admin-only functions use their own codes, because the game's texts would be shown otherwise.
3. **Page part.** Call the database through `call()` (`src/backend.ts`) or a wrapper in `src/wallet.ts`; the page shows what the database answers and never changes a balance itself. Escape every player-written text with `esc()`. No inline event handlers (the security policy forbids inline scripts); use listeners.
4. **Browser-only fallback.** If the feature also exists without the backend, keep the same rules there (`src/state.ts`, `src/rg.ts`).
5. **Layout.** Check 375 px and desktop; respect reduced motion.
6. **Tests.** Add tests next to the kind described in [TESTING-GUIDE.md](TESTING-GUIDE.md), then run `npm run typecheck`, `npm test` and `npm run build`.
7. **Docs and memory.** Update every related document in the same piece of work: the feature's own doc, `history.md` (timeline and open items), `setup-status.md`, indexes that list files, and `supabase/README.md` for a new migration.

## Releasing

1. **Commit** only when the owner asks; check `git status` and scan the change for personal data and keys first.
2. **SQL first.** When a release has a new migration, the owner runs it in the Supabase SQL editor (one paste per file, in number order) before the site that depends on it is deployed.
3. **Push and deploy** only with the owner's go-ahead: push the branch, export it with `git archive` into a clean folder, add the Vercel link and run `vercel deploy --prod` there.
4. **Verify live:** the served script file matches the local build, no console errors, the expected feature is in the page, the security headers are present.
5. **Record it** in `setup-status.md` and `history.md`.

## Specific procedures

| Task | How |
|---|---|
| Add or change a case | The admin site's Catalogue page (checks, versions, restore). The game site picks it up on the next visit |
| Refresh item prices | Run `npm run build:catalogue`, deploy, and have the owner run the regenerated `0014_*` files. Running `0015_*` again rebuilds every case and **undoes Catalogue edits**. See [real-catalogue.md](real-catalogue.md) |
| New case picture | Replace `public/assets/cases/<case id>.webp` (640 × 640, transparent) |
| Give a player coins | The admin site's Wallets page, or the SQL in [server-wallet.md](server-wallet.md) |
| Maintenance mode | The admin site's Site controls, or SQL on `site_controls` |
| A new operator alert | One trigger in a new migration plus one branch in the n8n alerts workflow. See [n8n.md](n8n.md) |
| Put the admin site live | The steps and who does each are in [admin-site.md](admin-site.md) |

## Rules that do not change

- Play money only; no deposit, withdrawal or cash-out path.
- No secret, project ID, personal name or e-mail in the repository or in requests to outside services.
- Ask before anything public or outward (push, deploy, creating projects, changing auth settings) unless the owner just asked for it.
- Say plainly what was tested and what was not.
