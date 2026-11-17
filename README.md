# Vaultrush (play-money prototype)

An original skin-game site prototype. **Play money only**: coins can't be bought or withdrawn.

- **Games**: case opening (1–6 at once, 3 speeds, ticket ranges), case battles (6 formats incl. 2v2/3v3, 7 modes: Normal, Crazy, Terminal, Jackpot, Crazy Jackpot, Point Rush, Group), crash (partial cash-outs), double (Triple Green pool), plinko, mines (4×4–8×8), multi-coin flip, upgrade (under/over).
- **Rewards**: levels/XP, instant/daily/weekly rakeback, welcome and daily free cases, level cases every 10 levels, promo codes, 7-day login streak, daily race leaderboard.
- **Platform**: live drops and bets, chat with coin rain, profile with bet history, demo self-exclusion, and a provably fair seed system with a verifier for every game.

## Run it

```bash
node server.js
```

Then open http://localhost:5173. It must be served over http(s) (not opened as a file), because it uses ES modules and Web Crypto.

## Structure

```
index.html          app shell
css/app.css         base styling (dark theme, responsive)
css/games.css       styling for the newer games, rewards and race pages
js/app.js           router, sidebar, top bar, live-drop ticker
js/state.js         balance, inventory, XP/levels, rakeback, race wager, bet history (localStorage)
js/fair.js          provably fair (HMAC-SHA256) + all game math and payout tables
js/data.js          item catalog, cases and reward cases (ticket ranges, prices from odds)
js/race.js          daily race standings (simulated rivals) and prize payout
js/fx.js            canvas particle effects (mines explosion, sparkles)
js/feed.js          simulated live drops / live bets (stand-in for a WebSocket feed)
js/chat.js          simulated chat + coin rain
js/ui.js            item/case art, reel spinner, modal, toasts, icons
js/sfx.js           Web Audio sound effects (incl. the generated explosion)
js/views/*.js       one file per page
```

## House edge settings

`HOUSE` in `js/fair.js`: cases 90% RTP, crash/mines/plinko/coinflip 97%, upgrade 95% (max 80% chance), double 93.3%. Demo promo codes are in `js/views/rewards.js`.

## Going to production

Move every outcome and the server seed to a backend (Node + Postgres + Redis + WebSockets), add real auth, and only add deposits or withdrawals with a gambling licence, KYC/AML and responsible-gambling tools.
