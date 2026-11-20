# History and decisions

A short log of how the project got here, why, and what is still open.

## Timeline

1. **Prototype.** An original play-money skin-game site: cases, case battles, crash, double, plinko, mines, coinflip, upgrade, rewards and levels, daily race, chat, provably fair verifier. Deployed to Vercel.
2. **Vite and TypeScript migration** (PR #1, merged). Tests and CI added. Strict type-checking for the core modules.
3. **Supabase question.** Not needed for the play-money demo; useful for real accounts, server-side fairness, shared leaderboards and chat. Built as an optional backend.
4. **Compliance tooling** (modelled on how skin-gambling operators present these controls): responsible-gambling tools, sandbox KYC and AML, an RNG lab. See [compliance.md](compliance.md). No licence is claimed.
5. **Optional Supabase backend:** schema, row-level security, server-side Crash bets, seed commit and reveal, real daily-race view, chat table, account export and deletion.
6. **Accounts.** First an email/password form, then rebuilt to match the owner's reference screenshots: Log In and Register tabs, Google and Steam, an account overview modelled on a reference profile page.
7. **Login rework (owner feedback):**
   - Top-right **Log in** button, in the site's own style.
   - Google and Steam only: Twitch and Discord removed.
   - No date-of-birth field and no "gambling is allowed where I live" tickbox at sign-up.
   - Signed-out visitors can browse but cannot bet or claim; anything like that opens the popup with a reason. Balance, inventory, seeds and the "You" player disappear while signed out.
   - The Steam profile name is the username, and the Steam or Google picture is the avatar.
8. **Cleanups (owner feedback):** session timer removed from the top bar; the Provably fair banner removed from the home carousel (three slides left); the "Welcome back" bar hidden when signed out.
9. **UX review.** The Vantage reviewer audited the interface from source; every finding was fixed the same day (see [ux-review-2026-11-18.md](ux-review-2026-11-18.md)): opt-in click guard, accessible dialogs and forms, guest cards, phone navigation sheet, carousel pause, motion and contrast fixes, clearer limits and break wording.
10. **Production setup:** Supabase project created, schema applied, Google provider enabled, Steam and account-closing functions deployed, environment variables set on Vercel, site deployed, branch pushed and pull request opened.

11. **Separate cloud accounts (2026-11-20).** The owner noticed three cloud accounts showed one shared balance: cloud mode stored game state under the shared guest key. State and seeds are now keyed per Supabase user. Old shared data is not migrated. Still browser-local: coins, items and seeds do not sync across devices (only Crash settles in the database).
12. **Live multiplayer (2026-11-21).** The owner asked for friends to be able to play battles together. Added `0002_live.sql` (lobbies, seats, secret seeds revealed at the start, realtime), a client data layer, live Coinflip and Battles, real chat and a shared bet/drop feed. The server draws the shared result; stakes stay in each browser (play money). See [live-multiplayer.md](live-multiplayer.md). **Needs the SQL run once in Supabase, and a two-person test on the real project.**
13. **Footer and legal pages (2026-11-21).** The owner asked for the footer and legal pages to follow what three comparable sites publish (Cobalt Lab, Bandit.camp, Clash.gg), with demo information for the firm and the owner. Built a new footer and ten pages in original wording with a fictional operator in `src/company.ts`. While doing it, found that account deletion left names in live games; added `0003_live_erasure.sql`. See [compliance.md](compliance.md). **0003 must be run in Supabase.**

## Decisions worth remembering

- **Play money only, and honest about it.** Simulated parts are labelled as simulated. No real-money paths.
- **The site's own design wins** over copying a reference site. References were used for structure and features.
- **Age is a tickbox at sign-up;** stronger checks are the opt-in sandbox verification. The database still refuses a profile without the adult flag.
- **Two gates, not one:** `debit()`/`grant()` refuse when signed out, and a click guard explains why. Both matter.
- **Signed-out state is blank and never saved,** so nothing personal can leak into a logged-out view and no data is created for visitors.
- **Steam via an Edge Function** because Supabase has no Steam provider; Google via Supabase's own provider.
- **Secrets stay out of the site and the repository.** Only the publishable key is in the browser.

## Status and open items

- Live site and Supabase project are configured. Pull request #2 (compliance, accounts, backend, Google and Steam) is open with passing CI; **it has not been merged into `main`**, so GitHub's default branch still has the older code.
- **Google sign-in:** the redirect to Google's consent page works; a complete round trip has not yet been confirmed by the owner.
- **Steam picture:** the Steam function was updated to also save the picture; it must be redeployed and the player must sign in again once to see it.
- The `supabase/.temp` link folder was removed during a history clean-up; run `supabase link` again before the next function deploy.
- Only Crash runs server-side. Other games, weekly and monthly loss and time limits on the server, server-side KYC/AML, and wiring the chat UI to the realtime table are future work.
- The Edge Functions have been exercised only through their start redirect and a Steam login by the owner; there is no automated test against live Steam or Supabase.
