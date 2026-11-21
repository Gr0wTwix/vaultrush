# Vaultrush documentation

Vaultrush is an original **play-money** skin-game demo. Coins cannot be bought, sold or withdrawn. These notes explain how it is built, how accounts and sign-in work, what the compliance tooling does, and how to run, test and deploy it.

| Document | Read it for |
|---|---|
| [architecture.md](architecture.md) | Folder layout, how state and views work, the single gates for bets and claims |
| [accounts-and-auth.md](accounts-and-auth.md) | Browser accounts, Supabase cloud accounts, Google and Steam sign-in, the signed-out rules |
| [server-wallet.md](server-wallet.md) | Where coins and items live now (the database): what each game does there, how the page mirrors it, setup steps, what is still simplified |
| [live-multiplayer.md](live-multiplayer.md) | Real battles, coinflip, chat and feed between players: what is live, the trust model, how to turn it on |
| [admin-site.md](admin-site.md) | The separate admin site that exists so far: sign-in chain, roles, permissions, audit log, data explorer, setup and commands |
| [admin-panel-proposal-2026-11-21.md](admin-panel-proposal-2026-11-21.md) | Proposal (not built): everything an admin panel could hold, the wallet constraint, security design, roles, example screens, phases and the decisions to approve |
| [competitor-live-analysis-2026-11-21.md](competitor-live-analysis-2026-11-21.md) | Which features of three comparable sites are live, what needs real data in real time, volume and load model, and what it means for Vaultrush |
| [compliance.md](compliance.md) | Responsible-gambling tools, sandbox KYC and AML, the RNG lab, provably fair maths, and the footer and legal pages (with fictional company details) |
| [deploy-and-workflow.md](deploy-and-workflow.md) | Commands, tests, environment variables, Supabase setup, Vercel and GitHub steps, mistakes to avoid |
| [history.md](history.md) | What was built in which order, why decisions were made, and what is still open |
| [ux-review-2026-11-18.md](ux-review-2026-11-18.md) | The UI/UX and accessibility review backlog, prioritized |

The top-level [README](../README.md) has the feature list and quick start. Backend details are in [../supabase/README.md](../supabase/README.md).

## Ground rules that apply everywhere

- **Play money only.** Nothing here is a real gambling service and no licence is held. Do not add real-money flows.
- **Be honest about what is simulated.** KYC, AML and the in-browser fairness seeds are demonstrations. Say so in the UI and the docs.
- **The repository is public.** No personal data, keys, project IDs or machine paths in files or history. Commits use the GitHub noreply address.
