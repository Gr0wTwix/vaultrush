# Compliance tooling

Everything here is a **demonstration** for a play-money site. No gambling licence is held, no real documents are collected, and the screening data is mock. The aim is to show how each control behaves, using the structure real operators use.

## Responsible gambling (`rg.ts`, `rgui.ts`, Account, Responsible Play)

- **One bet gate.** `betBlockReason(state, amount)` is the only place that decides whether a wager may be placed: age confirmed, not self-excluded, no cool-off, within the maximum bet, within daily, weekly and monthly loss limits, within the daily wager and daily play-time limits, and within the verification tier's bet cap. `debit()` calls it for every game.
- **Limits.** Loss (daily, weekly, monthly), daily wager, maximum bet, daily play time and a reality-check interval. **Tightening applies instantly; loosening waits 24 hours.** A pending change can be cancelled.
- **Cool-off and self-exclusion.** Fixed periods that can only be extended, never shortened.
- **Where the rules run.** With the server wallet on (every cloud account) **the database enforces all of this, not the page**: see "Where the limits are enforced" below. `betBlockReason()` above is the gate of the browser-only fallback.
- **Reality check.** A periodic pop-up with session time and net result, with options to keep playing, review limits, or take a 24-hour break. Play time is tracked in the background; the on-screen session timer was removed from the top bar at the owner's request.
- **18+ confirmation.** A tickbox when registering, and the database function `complete_signup` refuses a profile without it. Signed-in browser accounts also get an age gate if the confirmation is missing.
- **Self-assessment.** A short PGSI-style questionnaire with links to free support organisations (Responsible play page, `#/responsible`).

### Where the limits are enforced (`0018_server_limits.sql`, since 2026-11-21)

Before this migration only the maximum bet and the daily loss limit could exist on the server, and nothing in the page ever sent them; weekly and monthly loss limits, the daily wager limit, the play-time limit, cool-offs and self-exclusion lived only in the browser, so a reload, another browser or an edited page could get around them. Now `wallet_gate()` is the one gate that **every stake passes** (bets, case openings, upgrades, coinflips, battles, Crash, Double), and it refuses with its own message:

| Rule | Database error | How it is counted |
|---|---|---|
| Age confirmed | `age_not_confirmed` | the profile's confirmation |
| Self-exclusion | `self_excluded` | until the date; can only be extended (1 hour to 365 days) |
| Cool-off | `cool_off` | until the date; can only be extended (1 hour to 30 days) |
| Maximum single bet | `max_bet_exceeded` | the stake itself |
| Verification cap | `tier_cap_exceeded` | 10,000 / 25,000 / 50,000 by level |
| Daily wager limit | `wager_daily_limit` | coins staked today (UTC day), from the ledger; a refunded stake does not count |
| Daily, weekly, monthly loss limit | `daily_loss_limit`, `weekly_loss_limit`, `monthly_loss_limit` | settled bets over today, the last 7 and the last 30 UTC days: stakes minus payouts, winnings offset losses but never below zero; the new stake plus that loss must stay within the limit |
| Daily play time | `time_limit` | **estimated** from the stakes, because the server cannot see an open page: the time between two stakes counts when it is 5 minutes or less, plus 20 seconds for each stake; a stake is refused once the estimate has reached the limit |

- **Changing a limit** is `request_limit_change()`: tighter (or the first limit) applies at once, looser or removed waits 24 hours, asking for the current value cancels a waiting change. The page's Responsible Play window talks to it through `src/rg-server.ts`; `my_limits()` returns the limits, waiting changes, what has been used and the break dates, and the page shows the database's own usage numbers. A cool-off is `start_cool_off()`, self-exclusion `self_exclude()`; the reality-check pop-up's 24-hour break uses the same call.
- **Nothing is loosened by switching over.** The first time a cloud account is loaded after `0018`, limits and breaks the browser kept that are **stricter** than the database's are copied up once; looser ones are ignored.
- **Honest limits.** A live game's stake (coinflip, Crash, Double, battle) counts toward the *loss* limits only when the round settles (like the daily loss limit always did); it counts at once toward the wager limit. The play-time limit is an estimate. The reality check and the page's own play timer stay in the browser. KYC and AML are still sandbox demonstrations.
- Tested by `tests/server-limits-db.test.ts` (every rule above, the day, week and month edges, refunds, wins offsetting losses, a due change being applied, breaks that cannot be shortened, all kinds of stake) and `tests/rg-server.test.ts` (the page's side).

## Sandbox identity checks (`kyc.ts`, Account, Verification)

| Tier | How to reach it | Bet cap |
|---|---|---|
| 0 | New account | 10,000 |
| 1 | Verify email and date of birth | 25,000 |
| 2 | Full identity check (simulated document step plus mock sanctions and PEP screening) | 50,000 |

The cap applies to one stake: a bet, a case opening, an upgrade stake, a coinflip, a Crash or Double bet, or the whole cost of a case battle. So **verification is only needed above 10,000 coins**. Until 2026-11-21 the caps were 1,000 / 2,500 / 5,000; migration `0017_bet_caps.sql` and `TIER_MAX_BET` in `src/kyc.ts` hold the numbers (a test checks they agree).

**On the server (since `0026`):** the tiers above are reached in the browser demonstration only. The level the database uses for the cap is raised by staff: a player with a cloud account asks for the next level in Account, Verification, and staff approve or decline it on the admin site's Compliance page (a manual decision, no documents). Staff can also start or extend a break or self-exclusion and tighten a limit for a player, never the other way (see admin-site.md).

The date of birth is collected only here, when a player chooses to verify. It is not asked at sign-up. Screening is a local mock list; a match puts the account on a compliance hold.

## AML monitoring (`aml.ts`)

A payout simulator evaluates a request without changing anything and explains each finding.

| Rule | Meaning |
|---|---|
| K01 | Tier 0 cannot request a payout |
| K02 | Payouts of 100 or more need tier 2 |
| K03 | Compliance hold freezes payouts |
| K04 | Identity check awaiting manual review |
| B01 | Bonus coins must be wagered at least once first |
| V01 | Too many payout requests in 24 hours (velocity) |
| S01 | Repeated amounts just under the reporting threshold (structuring) |
| W01 | Winnings are statistically improbable (z-score of 4 or more over at least 30 bets) |
| F01 | Cumulative payouts of 500 or more need a source-of-funds declaration |

Because coins cannot actually be withdrawn, these rules run against a simulated payout request only.

## RNG lab (`rng.ts`, `rnglab.ts`, `#/rng`)

- Statistical tests from NIST SP 800-22 (frequency, block frequency, runs, longest run, and others), checked against the examples published in the standard.
- FIPS 140-2 power-up tests, a Kolmogorov-Smirnov uniformity test, an SP 800-90B-style health monitor that raises an alarm during play, and a nonce audit.
- The page runs the suite on the game's own random source and shows pass/fail per test.
- **Not a certification.** Real certification comes from an accredited test lab (for example GLI or BMM). This is the in-house equivalent for development.

## Provably fair (`fair.ts`, `#/fair`)

- Every roll is `HMAC-SHA256(serverSeed, clientSeed:nonce:round)`, 4 bytes per float.
- The server seed hash is shown before play; rotating reveals the old seed so past bets can be recomputed on the Fairness page.
- With a backend, `place_bet()` repeats the same maths in SQL for Crash, and `tests/db.test.ts` checks it against the TypeScript implementation. Without a backend the seed lives in the browser, so it demonstrates the method but is not a trusted third party.
- The Fairness page also runs a house-edge simulation and a uniformity check against the exact maths.

## Footer and legal pages (`footer.ts`, `views/legal.ts`, `company.ts`)

Added 2026-11-21 after reading the legal pages and footers of three comparable operators (Cobalt Lab, Bandit.camp, Clash.gg). What they have in common, and what Vaultrush now has in its own words:

| Pattern seen on the reference sites | Vaultrush |
|---|---|
| Footer names the operating company, registration number and registered address | Footer and every policy name **Vaultrush Demo Ltd (fictional)**, reg. no. DEMO000000, a made-up address. All in `src/company.ts` |
| "Not affiliated with Valve, Steam, Facepunch, Rust…" notice | Same notice in the footer, Terms and Disclaimer (the item names, pictures and prices are real Counter-Strike 2 data, shown only to describe play-money items; see real-catalogue.md) |
| 18+ strip, "have a gaming problem? reach out", "no purchase necessary" | Footer strip with the 18+ badge, a help link, and "free to play" |
| Footer columns: games, information, legal, responsible | Four columns, every link tested against the real routes |
| Terms, Privacy, Cookie policy | Terms of Service, Privacy Policy, Cookie and Storage Policy |
| Refund / returns policy | Refund Policy (nothing can be bought, so nothing to refund) |
| AML policy | AML and Compliance Policy, written as the sandbox it is |
| Code of ethics | Code of Ethics |
| Rules, disclaimer, about, contact | House Rules, Disclaimer, About, Contact |
| Editorial policy (a blog/news site thing) | Not needed: Vaultrush has no editorial content |

Differences on purpose: the reference sites describe deposits, withdrawals, KYC documents, payment processors and retention periods for real money. Vaultrush has none of that, so each page says what the demo actually does (play money, browser storage, Supabase, Vercel, Google Fonts) and nothing it does not. Wording is original; nothing was copied from the other sites.

Rules for editing these pages:
- Company details live only in `src/company.ts` and are placeholders on the reserved `.example` domain. The repository is public: do not put private personal data there. If this ever becomes a real service, replace them with the real operator and have a lawyer review the text.
- Every sentence must match the app. If a feature changes (what is stored, who can see it, what is deleted), update the page and bump `TERMS_VERSION` in `signup.ts` (now `2026-11-21`).
- `tests/legal.test.ts` checks that each page renders, every footer link has a route, the company stays fictional, and the key honest statements are present.

The Privacy Policy lists the automation service (n8n) among the service providers: when the owner switches the operator alerts on, it receives only a player name, a game and amounts, never e-mail addresses or IP addresses (see [n8n.md](n8n.md)). Keep that sentence true.

Account deletion and live games: `0003_live_erasure.sql` makes `delete_account()` also replace the player's name in live coinflips and battle seats, so the Privacy Policy's claim is true. It must be run once in the Supabase SQL editor after `0002_live.sql`.
