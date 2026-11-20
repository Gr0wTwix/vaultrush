# Live features and volume analysis of three reference sites

Written 2026-11-21 from passive observation made on 2026-11-20 between about 21:45 and 22:00 UTC. Sites: **Cobalt Lab** (cobaltlab.tech), **Bandit.camp** (bandit.camp) and **Clash.gg** (clash.gg). Purpose: find out which features of such sites are truly live, which need real data in real time, and how large the traffic and data volumes are, so Vaultrush can be sized and planned honestly.

## 1. Summary

- **All three run one WebSocket per visitor** and push everything live through it: chat, online counter, bet/win feed, battle lobbies and rounds, crash/wheel/roulette rounds, rain. Nothing on the live parts is polled.
- **Observed concurrency was small:** about 91 online on Cobalt Lab, about 750 on Clash.gg, about 870 on Bandit.camp (the sites' own online counters, one evening sample).
- **Steady live traffic per visitor is modest** (0.1 to 3.4 KB/s, about 0.5 to 7 messages/s depending on the page). The heavy parts are **first-load page weight** (5.4 to 16.3 MB) and **start-up snapshots** (up to 419 KB for the list of active battles on Bandit.camp).
- **What genuinely needs server-authoritative real time:** bets, round outcomes, the crash clock, battle rolls, wallet changes, deposits and withdrawals. **What only needs shared real time:** chat, feed, online counter, rain pot, lobby lists. **What can be slow or cached:** races, leaderboards, item catalogue, legal pages.
- **Each site designs the heavy parts differently:** Cobalt Lab appears to send a crash round as a start time plus a public blockchain block hash and let the browser draw the curve (few messages; my inference from the messages seen); Clash.gg streams crash ticks about 3 times a second plus a heartbeat about every 0.8 s (many messages); Bandit.camp sends full snapshots on page open.
- **Vaultrush today** is far lighter on first load (0.64 MB, 49 requests) and now has real chat, battles, coinflip and a shared feed, but not yet shared crash/double/wheel rounds, a server wallet, rain, giveaways or real races. See sections 7 and 8.
- **A real scaling risk in Vaultrush as built:** broadcasting every bet to every online player grows with the square of the number of players, and presence updates do the same. On Supabase's Free plan that hits the message caps at roughly **45 betting players (feed)** and **77 players (presence)**. Section 7 has the numbers and the fix.

## 2. Method, scope and limits

**What was done.** A Chromium browser (driven by Playwright) opened each site as an ordinary logged-out visitor and recorded: every request and its size, every WebSocket connection with every frame received and sent (event name, size, count), and the visible page text. Windows were 25 to 90 seconds per page. Cobalt Lab: home, crash, wheel, crate battles. Bandit.camp: home, wheel, crate royale, beancan blast, crate battles. Clash.gg: home, crash, double, case battles, champion. The 11 legal pages given earlier were read in the Browser pane.

**What was deliberately not done.** No load or stress test of any kind: that would be an attack on someone else's servers. No logins, no bets, no deposits, no scraping beyond the pages above, nothing that tries to get around bot checks (none appeared). The report contains no player names or IDs.

**Limits you should keep in mind.**
- One evening sample, a minute or two per page. Real traffic changes by hour and day (often 3x or more). Everything labelled "per day" is an extrapolation of one sample.
- Logged-out view only. Wallet, deposits, withdrawals, KYC and anything behind a login were **not observed**; for those, the sites' own legal pages are the only evidence.
- Online counters are the sites' own numbers and may include bots or inflate. Several signals suggest house bots in battles (see section 4), which also inflates activity.
- Entries from `gc.kis.v2.scr.kaspersky-labs.com` seen in the request logs come from the antivirus on this PC, not from the sites, and are excluded everywhere.
- Platform limits for sizing come from Supabase's public documentation (links at the end) and may change.

## 3. Site profiles

### 3.1 Cobalt Lab (cobaltlab.tech)

Rust-skin games and battles. Operated by a Cyprus company (see its legal pages). Online counter during the observation: **88 to 95**.

| Item | Observed |
|---|---|
| Realtime transport | Socket.IO v4 over WebSocket: `wss://ws.cobaltlab.tech/api/ws/`. Heartbeat every 25 s, timeout 20 s, max payload 1 MB. |
| Channels the page subscribes to | `chat_ru` (a language room), `crateBattle`, `crash`, `wheelRoll` (one per page, plus chat) |
| Events seen | `online`, `time`, `newGame`, `join`, `gameLock`, `gameStarted`, `newRound`, `endGame`, `liveWin`, `newBetHistory`, `tts` / `cb_tts` (battle countdown), `crashWaitEOS`, `crashEOS`, `crashStartGame`, `crashTTS`, `wheelRollEOS`, `wheelRollSet`, `emoji` |
| REST (first load) | `/api/betLog/betList`, `/api/chat/get`, `/api/crateBattle/GAME_LIST` and `GET_GAME`, `/api/giveawayV2/getData`, `/api/getCarouselV2`, `/api/translate/` |
| Provably fair | Uses a **public blockchain block (EOS)** as the randomness source: the UI shows "waiting for EOS block", and `gameLock` / `crashEOS` / `wheelRollEOS` carry the block number and hash |
| Third parties | Intercom (support chat), Yandex Metrika, Facebook pixel, VK, a first-party PostHog proxy (`rph.` subdomain: events, flags, surveys), Steam avatars |
| Bot signals | Battle `join` events carry **negative user IDs and own-domain avatars**, which looks like house bots (inference, not proof) |

Measured events on the home page (63 s, 119 frames, 55.5 KB):

| Event | Count | Per minute | Avg size | Meaning |
|---|---|---|---|---|
| newGame | 5 | 4.8 | 5.4 KB (max 9.4 KB) | a new battle lobby, with its full configuration |
| newBetHistory | 18 | 17.1 | 452 B | a bet in the live feed |
| join | 14 | 13.3 | 434 B | a player (or bot) takes a seat |
| newRound | 12 | 11.4 | 588 B | a battle round result |
| tts + cb_tts | 40 | 38.1 | 35 B | one-second countdown ticks |
| endGame | 4 | 3.8 | 1.0 KB | battle finished, with the payout split |
| liveWin | 4 | 3.8 | 440 B | a highlighted win |
| online | 7 | 6.7 | 15 B | the online counter |

Crash on Cobalt Lab sent **a countdown tick about 2.5 times a second, a block wait, then one start message** (`crashStartGame` with a start time) and no per-tick multiplier stream in the 25 s window. That suggests the browser draws the rising curve itself from the start time and the fair hash (an inference: I did not watch a whole round), which keeps the message count small (about 3.4 KB in 25 s).

### 3.2 Bandit.camp (bandit.camp)

Rust-skin games. Operated by a Cyprus company (see its legal pages). Online counter during the observation: **866 to 886**.

| Item | Observed |
|---|---|
| Realtime transport | One WebSocket, custom JSON protocol: `wss://api.bandit.camp/`. Pushes look like `{"a":["event", payload]}`; requests and replies carry an id: `{"a":[...],"i":n}` and `{"i":n,"d":...}`. RPC-style calls ride the same socket (`chat.history`, `game.cases.list`, `game.caseJackpot.get`). |
| Channels | `chat` (rooms by language, e.g. `lang-en`), `caseBattles`, `caseJackpot` (crate royale), `wheel` |
| Events seen | `games.feed`, `games.feed.new`, `chat.message`, `chat.delete` (moderation), `chat.discord.vc` (Discord voice presence), `app.online`, `app.user`, `app.conga` (maintenance flag, global notice, staff-only flag, affiliate settings, 7 KB sent at connect), `game.wheel.newBet`, `game.wheel.round`, `game.wheel.history`, `game.caseBattles.active`, `.new`, `.playerJoined`, `.rollRound`, `game.caseJackpot.active` |
| REST | `api.bandit.camp/items/data` (item catalogue) and static media. Everything dynamic goes over the socket. |
| Third parties | Cloudflare (bot challenge platform and analytics), Klaviyo (email), Google Analytics and Tag Manager, reCAPTCHA, Intercom, gleam.io (giveaways), 7TV (chat emotes), an image host (i.ibb.co, 26 requests), Steam login and avatars, Discord |
| Bot signals | `playerJoined` events with user IDs of the form `banditcamp-N` and farm-style names: house bots (clearly labelled by ID) |

Steady state on the home page (90 s, 104 frames, 44.5 KB):

| Event | Count | Per minute | Avg size | Meaning |
|---|---|---|---|---|
| games.feed.new | 90 | 60 | 461 B | one entry in the all-games live feed |
| chat.message | 9 | 6 | 434 B | a chat message |
| app.online | 3 | 2 | 24 B | online counter, about every 30 s |
| chat.discord.vc | 2 | 1.3 | 48 B | Discord voice presence |

**Start-up snapshots are the heavy part:**

| Page | Snapshot | Size |
|---|---|---|
| Home | chat history + emotes + feed + app config | about 120 KB |
| Wheel | round history | 153 KB (plus about 38 KB of replies) |
| Crate royale | replies incl. case list, active jackpot | about 106 KB |
| Crate battles | **all active battles** | **419 KB** (540 KB in the first 26 s) |

### 3.3 Clash.gg (clash.gg)

Skin-game site built on Next.js; bet events carry a `currency: REAL` tag (I saw the label, not any money move). Operated by a Cyprus company (see its legal pages). Online counter during the observation: **744 to 759**.

| Item | Observed |
|---|---|
| Realtime transport | One WebSocket with JSON arrays: `wss://ws.clash.gg/`; messages look like `["event", payload]`, subscriptions like `["subscribe","battles"]` |
| Channels | `chat`, `rain` (always), plus `roulette` (double), `battles`, `champion-match`; the crash page also sends requests over the same socket (`init`, `status`, `myBets`, `auth`) and runs a heartbeat |
| Events seen | `chat:message`, `online`, `rain` (pot), `rain:joins`, `roulette:round`, `roulette:bet`, `roulette:jackpot`, `battles:new`, `battles:start` (with `startsAt`, `serverTime`, `seed`), `battles:round`, `battles:finished`, `battles:join-bots`, `battles:rain`, `tick` (crash), `status`, `bet`, `ping:serverTime`, `ping:pong` |
| REST (first load) | `/api/auth/access-token`, `/api/rewards/cases`, `/api/races`, `/api/races/my-details`, `/api/cases/official`, `/api/cases/level-cooldown`, `/api/chat/messages`, `/api/rain`, `/api/geo-lock`, `/api/payments/blocks/inactive`, giveaways; plus about 10 prefetched Next.js page-data files |
| Third parties | CookieYes (consent), OneSignal (web push), Sift (fraud), AdRoll and Google ads, Nolt (feedback), several first-party sub-domains that appear to be tracking or telemetry |
| Bot signals | An explicit `battles:join-bots` event: players can call bots into a battle (a documented feature) |

Per page (about 29 s each):

| Page | Frames | KB | Notable |
|---|---|---|---|
| Home | 48 (in 53 s) | 4.2 | chat 8, rain pot 20 updates (about every 2.6 s), online 11, rain joins 9 |
| Crash | 197 | 54.1 | **tick 83 (2.9/s)**, ping:serverTime 36 + pong 35 (a heartbeat about every 0.8 s), `exampleProducts` 2 x 21 KB, `status` with the bet list |
| Double (roulette) | 44 | 5.4 | roulette:bet 13, a round opens for 20 s (`createdAt` to `drawsAt`), jackpot value pushed |
| Case battles | 86 | 100 | **battles:round 41 (88 KB, 2.1 KB each)**, new 3, start 4, finished 5, join-bots 4 |
| Champion | 23 (in 42 s) | 7.6 | a king-of-the-hill battle format, low traffic |

Battle IDs seen were around 47.1 million, which suggests roughly that many battles over the site's life (copyright "2021 to 2026"), about 20,000 a day on average (an estimate from IDs, assuming one ID space).

## 4. Which features are live

"Live" means pushed to the browser over the socket without a refresh. "Observed" means seen in this run; "not observed" means it needs a login or was not on the pages visited.

| Feature | Cobalt Lab | Bandit.camp | Clash.gg | Vaultrush now |
|---|---|---|---|---|
| Online counter | live, about every 9 s | live, about every 30 s | live, about every 5 s | live (presence) when signed in |
| Global chat | live, language rooms | live, rooms, history, emotes (7TV), moderation events, Discord voice | live, rooms, moderation field | live (shared table) when signed in |
| Bet / win feed | live (`newBetHistory`, `liveWin`) | live (`games.feed.new`, about 1/s) | not observed on pages visited | live (broadcast) when signed in |
| Case battles | live lobbies, per-round results, countdown, bots | live lobbies, per-round rolls, bots | live lobbies, per-round results, start time sync, bots | live lobbies, seats, bots, shared seed |
| Crash | live: countdown then a start time (curve appears to be drawn in the browser) | not seen in the menu | live: server ticks about 3/s + heartbeat | **not shared** (solo; server-side bet only) |
| Wheel / roulette / double | live rounds (`wheelRoll`) | live rounds, bets, 153 KB history | live rounds (20 s) and jackpot | **not shared** (solo) |
| Jackpot / royale / king of the hill | not observed | live (`caseJackpot`) | live (`champion-match`) | not built |
| Coinflip (PvP) | not observed | not observed | not observed on pages visited | live lobbies and result |
| Rain | giveaways via REST | rain announced in chat | live pot updates about every 2.6 s, joins counter | **simulated** (hidden when live) |
| Races / leaderboards | REST page | timed race banner ("2h 12m") | REST page (`/api/races`) | local only |
| Giveaways | REST (`giveawayV2`) | third party (gleam.io) | REST (affiliates) | not built |
| Maintenance flag / global notice | not observed | pushed at connect (`app.conga`) | not observed | not built |
| Geo-blocking, payment blocks | not observed | not observed | REST (`geo-lock`, `payments/blocks`) | n/a (no payments) |
| Deposits, withdrawals, KYC | server-side (Steam trade offers, KYC, card/bank/crypto per its terms): **not observed** | server-side (offers, third-party payment services per its terms): **not observed** | server-side (`/kyc`, payments): **not observed** | simulated sandbox only |
| Provably fair randomness | **public EOS block hash** | per-round hash shown in history | seed delivered with `battles:start`, game history in `init` | server seed hash committed, seed revealed at start |
| Push / email / support | Intercom | Klaviyo email, Intercom | OneSignal push | none |
| Analytics / fraud | PostHog, Yandex Metrika, Facebook, VK | Google Analytics, Cloudflare | AdRoll, Google ads, Sift | none |

## 5. What needs real data in real time

Features sorted by how strict the real-time and real-data requirement is. This is the part to use when deciding what Vaultrush must build on the server.

| Tier | Needs | Examples | Latency that is acceptable | Where the truth must live |
|---|---|---|---|---|
| 1. Authoritative real time | real data, exactly once, server decides | placing a bet, round result, crash multiplier and cash-out, battle roll outcomes, wallet balance changes, coinflip result | under 1 s (rounds are 5 to 20 s) | database; the browser must never decide |
| 2. Shared real time | real data, loss or delay is harmless | chat, bet/win feed, online counter, rain pot, lobby lists, battle spectating | 1 to 3 s | server broadcast; can be sampled or batched |
| 3. Near real time | real data, minutes old is fine | race standings, leaderboards, giveaway lists, rewards cooldowns | 10 s to a few minutes | database view or cache |
| 4. Cacheable | does not change per player | item and case catalogue, translations, legal pages, images | hours | CDN |
| 5. External real data | comes from outside the site | a public blockchain block hash for fairness (Cobalt Lab), item prices from marketplaces, Steam inventory and trade state, payment and KYC providers, geo-IP | depends on the source | a trusted integration; needs its own monitoring |

**What the references tell us about each tier:**
- **Tier 1 is always the server.** All three keep the round clock and result on the server. Cobalt Lab makes it cheap by sending a start time and letting browsers draw the crash curve; Clash.gg pays for ticks.
- **Tier 2 is sampled.** None streams every bet to everyone: Bandit.camp's feed was about 1 entry per second with 870 people online (about 4 feed entries per online person per hour); Cobalt Lab's was about 17 per minute with 91 online. The rate is almost flat as the audience grows. That is a design choice that keeps fan-out affordable.
- **Tier 3 and 4 are plain requests** to normal endpoints, never the socket.
- **Tier 5 is where "real data" gets expensive.** Cobalt Lab depends on a public blockchain for its random seeds ("waiting for EOS block" is part of every round). Vaultrush uses a server-held secret seed instead, which needs no external service.

## 6. Volume model

### 6.1 First-load weight (logged-out home page)

| Site | Requests | Transferred | Scripts | Images | API calls | Stylesheets | Vs Vaultrush |
|---|---|---|---|---|---|---|---|
| Cobalt | 409 | 6.23 MB | 245 / 2.62 MB | 57 / 2.47 MB | 34 / 0.89 MB | 61 / 0.2 MB | 9.7x heavier |
| Bandit | 610 | 16.32 MB | 56 / 2.26 MB | 80 / 9.97 MB | 30 / 2.22 MB | 21 / 0.08 MB | 25.5x heavier |
| Clash | 258 | 5.42 MB | 83 / 2.11 MB | 52 / 0.33 MB | 59 / 0.3 MB | 2 / 0 MB | 8.5x heavier |
| Vaultrush | 49 | 0.64 MB | 3 / 0.34 MB | 38 / 0.26 MB | 2 / 0 MB | 2 / 0.03 MB | 1x |

Scripts are the common cost (about 2.1 to 2.6 MB on each competitor); Bandit.camp adds 10 MB of images. Cobalt Lab needs 245 separate script files.

### 6.2 Live traffic per connected visitor

**Cobalt** (online at the time: 91). Steady state per visitor on each page:

| Page | Messages/s | KB/s | MB per hour | Messages per hour |
|---|---|---|---|---|
| Home (battles + chat subscribed) | 1.89 | 0.88 | 3.1 | 6,800 |
| Crash | 2.96 | 0.14 | 0.48 | 10,656 |
| Wheel (roulette) | 0.56 | 0.08 | 0.3 | 2,016 |
| Crate battles | 0.8 | 0.27 | 0.94 | 2,880 |

**Bandit** (online at the time: 870). Steady state per visitor on each page:

| Page | Messages/s | KB/s | MB per hour | Messages per hour |
|---|---|---|---|---|
| Home (steady state) | 1.16 | 0.49 | 1.74 | 4,160 |
| Wheel (steady, snapshot excluded) | 2 | 0.81 | 2.85 | 7,200 |
| Crate royale (steady) | 1.27 | 0.49 | 1.73 | 4,569 |
| Beancan blast (steady) | 1.35 | 0.52 | 1.84 | 4,846 |
| Crate battles (steady) | 3.73 | 2.6 | 9.15 | 13,431 |

**Clash** (online at the time: 750). Steady state per visitor on each page:

| Page | Messages/s | KB/s | MB per hour | Messages per hour |
|---|---|---|---|---|
| Home (chat + rain) | 0.91 | 0.08 | 0.28 | 3,260 |
| Crash | 6.79 | 1.87 | 6.56 | 24,455 |
| Double (roulette) | 1.52 | 0.19 | 0.65 | 5,462 |
| Case battles | 2.97 | 3.45 | 12.12 | 10,676 |
| Champion | 0.55 | 0.18 | 0.64 | 1,971 |

### 6.3 What that means for the servers (fan-out at the observed audience)

Upper bound: **every online visitor sitting on that page**. Messages delivered per second = visitors x messages/s. Bandwidth = visitors x KB/s.

| Site | Page | Visitors | Messages delivered/s | Egress | Egress (bits) |
|---|---|---|---|---|---|
| Cobalt | Home (battles + chat subscribed) | 91 | 172 | 0.08 MB/s | 0.6 Mbit/s |
| Cobalt | Crash | 91 | 269 | 0.01 MB/s | 0.1 Mbit/s |
| Cobalt | Wheel (roulette) | 91 | 51 | 0.01 MB/s | 0.1 Mbit/s |
| Cobalt | Crate battles | 91 | 73 | 0.02 MB/s | 0.2 Mbit/s |
| Bandit | Home (steady state) | 870 | 1,005 | 0.42 MB/s | 3.4 Mbit/s |
| Bandit | Wheel (steady, snapshot excluded) | 870 | 1,740 | 0.69 MB/s | 5.5 Mbit/s |
| Bandit | Crate royale (steady) | 870 | 1,104 | 0.42 MB/s | 3.3 Mbit/s |
| Bandit | Beancan blast (steady) | 870 | 1,171 | 0.44 MB/s | 3.6 Mbit/s |
| Bandit | Crate battles (steady) | 870 | 3,246 | 2.21 MB/s | 17.7 Mbit/s |
| Clash | Home (chat + rain) | 750 | 679 | 0.06 MB/s | 0.5 Mbit/s |
| Clash | Crash | 750 | 5,095 | 1.37 MB/s | 10.9 Mbit/s |
| Clash | Double (roulette) | 750 | 1,138 | 0.14 MB/s | 1.1 Mbit/s |
| Clash | Case battles | 750 | 2,224 | 2.53 MB/s | 20.2 Mbit/s |
| Clash | Champion | 750 | 411 | 0.13 MB/s | 1.1 Mbit/s |

Readings: the busiest realistic case here is Clash.gg crash (about 5,200 messages/s and 11 Mbit/s if all 750 were on it); heartbeats alone are about 1,800 messages/s there (36 + 35 messages per 29 s per client). Cobalt Lab at 91 visitors is under 200 messages/s everywhere.

### 6.4 Event volumes (extrapolated from one sample)

| Site | Event | Per second | Per minute | Per hour | Per day at this rate |
|---|---|---|---|---|---|
| Cobalt Lab | newBetHistory (feed) | 0.29 | 17.1 | 1,029 | 24,686 |
| Cobalt Lab | newGame (new battles) | 0.08 | 4.8 | 286 | 6,857 |
| Cobalt Lab | battle rounds | 0.19 | 11.4 | 686 | 16,457 |
| Bandit.camp | games.feed.new | 1 | 60 | 3,600 | 86,400 |
| Bandit.camp | chat.message | 0.1 | 6 | 360 | 8,640 |
| Bandit.camp | battle roll rounds (crate-battles page) | 1.12 | 66.9 | 4,015 | 96,369 |
| Clash.gg | chat:message (home) | 0.15 | 9.1 | 543 | 13,042 |
| Clash.gg | battles:round | 1.41 | 84.8 | 5,090 | 122,152 |
| Clash.gg | battles:new | 0.1 | 6.2 | 372 | 8,938 |
| Clash.gg | roulette:bet | 0.45 | 26.9 | 1,614 | 38,731 |
| Clash.gg | crash tick (while a round runs) | 2.86 | 171.7 | 10,303 | 247,283 |

Per-day numbers assume the rate holds all day; real days have quiet and busy hours, so treat them as an order of magnitude (a range of 0.3x to 3x is plausible).

### 6.5 Start-up bursts and reconnect storms

A snapshot is sent to **each** client that opens or reopens a page. If a deploy or network blip makes many clients reconnect at once, the whole snapshot goes out to all of them within seconds:

| Snapshot | Size per client | Clients assumed | Burst if all reconnect |
|---|---|---|---|
| Bandit.camp home | 120 KB | 870 | 102 MB |
| Bandit.camp wheel | 191 KB | 261 (30% of online) | 48.7 MB |
| Bandit.camp crate battles | 457 KB | 261 (30% of online) | 116.5 MB |
| Clash.gg crash (exampleProducts x2) | 44 KB | 225 (30% of online) | 9.6 MB |
| Cobalt Lab home | 25 KB | 91 | 2.2 MB |

Rule of thumb from these numbers: keep snapshots under about 50 KB, send lists in pages or by request rather than pushing them, and add random delay when clients reconnect.

### 6.6 Page-load volume at different audience sizes

Upper bound: every session loads the whole page with an empty cache (second visits are much lighter).

| Site | 10,000 sessions/day | 100,000 sessions/day | 1,000,000 sessions/day |
|---|---|---|---|
| Cobalt | 4,090k requests, 60.8 GB | 40,900k requests, 608.3 GB | 409,000k requests, 6,083.5 GB |
| Bandit | 6,100k requests, 159.3 GB | 61,000k requests, 1,593.3 GB | 610,000k requests, 15,933 GB |
| Clash | 2,580k requests, 52.9 GB | 25,800k requests, 529.2 GB | 258,000k requests, 5,291.9 GB |
| Vaultrush | 490k requests, 6.2 GB | 4,900k requests, 62.5 GB | 49,000k requests, 624.7 GB |

Most of that is static and cacheable through a CDN; the cost that does not go away is the live socket work in 6.3.

## 7. Vaultrush: where it stands and where it will break

### 7.1 Today

| Area | Vaultrush | Comment |
|---|---|---|
| First load | 49 requests, 0.64 MB (3 scripts 0.34 MB, 38 images 0.26 MB) | 8 to 25 times lighter than the three references |
| Realtime | one Supabase Realtime socket per signed-in tab; live lobbies by database changes; chat by database changes; feed and online count by broadcast and presence | signed-out visitors open no socket at all |
| Server-authoritative money | only the Crash demo bet (server wallet); every other game keeps coins in the browser | the biggest gap against the references (Tier 1) |
| Shared rounds | none (crash, double, wheel-style games are solo) | Tier 1 not built |
| Small defect found | the page asks for `/favicon.ico` and gets a 404 (one console error) | cosmetic, one-line fix |

### 7.2 Platform limits

From Supabase's Realtime limits page (checked 2026-11-21; plans change, so check again before relying on them):

| Plan | Concurrent connections | Messages per second | Channel joins/s | Presence msgs/s |
|---|---|---|---|---|
| Free | 200 | 100 | 100 | 20 |
| Pro | 500 | 500 | 500 | 50 |
| Pro (no spend cap), Team, Enterprise | 10,000 | 2,500 | see docs | see docs |

Connections map to browser tabs (one socket each). The references' audiences were about 90, 750 and 870: **the Free plan covers a Cobalt-sized audience; a Clash- or Bandit-sized audience needs the 10,000-connection tier** (Pro caps at 500). The docs do not say whether each delivered copy of a broadcast counts toward the message limit; the models below assume it does, which is the cautious reading.

### 7.3 The quadratic problem

Model: N players online, each placing 3 bets a minute, each bet broadcast to everyone; chat 0.3 messages per player per minute; presence changes when a player joins or leaves, with 10-minute sessions.

| Online players (N) | Feed deliveries/s (N x N x bets) | Chat deliveries/s | Presence msgs/s (N x N x 2/600) | Fits Free? | Fits Pro? |
|---|---|---|---|---|---|
| 25 | 31.3 | 3.1 | 2.1 | yes | yes |
| 50 | 125 | 12.5 | 8.3 | no | yes |
| 100 | 500 | 50 | 33.3 | no | no |
| 200 | 2,000 | 200 | 133.3 | no | no |
| 500 | 12,500 | 1,250 | 833.3 | no | no |
| 1,000 | 50,000 | 5,000 | 3,333.3 | no | no |
| 5,000 | 1,250,000 | 125,000 | 83,333.3 | no | no |

Solving the feed model for the cap: Free allows about **45 betting players**, Pro about **100**, the top tier about **224**. Presence alone passes the Free cap (20/s) at about **77 players**.

**Why the references do not have this problem:** they send a small, roughly fixed-rate feed (Bandit.camp about 1 entry/s whatever the audience) so deliveries grow linearly with N, not with N x N.

**Fixes, cheapest first:**
1. Do not broadcast every bet. Send only wins above a threshold, or at most one sampled entry per second. Deliveries become N per second: Free covers about 100 players, Pro about 500.
2. Batch: one message every 2 seconds carrying up to 10 entries. Deliveries become N / 2 per second.
3. Replace presence with a periodic online count (a server counts connections or recent activity and broadcasts one number every 30 s, as Bandit.camp does).
4. For lobbies, use Supabase's "broadcast from database" instead of database-change subscriptions: Supabase itself recommends this for scale because every change is checked against the row-level-security policy of every subscriber.
5. When real concurrency passes roughly 150 tabs, move to the Pro plan with no spend cap, which also lifts the connection and message limits.

### 7.4 Sizing the live games Vaultrush already has

| Item | Per unit | At 100 players | At 1,000 players |
|---|---|---|---|
| Open coinflips (max 5 per player) | 1 row, about 0.4 KB | up to 500 open rows | up to 5,000 open rows |
| Open battles (max 3 per player) | 1 row, about 1 KB | up to 300 open rows | up to 3,000 open rows |
| Database changes per battle | create + one per seat + start | about 3 to 8 per battle | same, times the battle rate |
| Lobby list reload | up to 50 rows of about 1 KB | 50 KB per page open | 50 KB per page open |
| Chat history on open | 30 messages of about 0.2 KB | 6 KB per client | 6 KB per client |

These are small next to the references' snapshots (Bandit.camp 419 KB for active battles). The limit that matters is message fan-out (7.3), not storage.

## 8. Recommendations for Vaultrush, in order

1. **Fix the fan-out before it bites** (section 7.3, fixes 1 to 3). This is a small change in `src/live.ts` and `src/feed.ts` and protects the Free plan.
2. **Decide the wallet question.** The references keep every balance on the server. Vaultrush keeps coins in the browser, which is fine for a play-money demo but means a determined player can edit their own balance. Moving the wallet into the database (stake taken inside the join function, payout in the same transaction) is the single biggest step toward "real data".
3. **Shared rounds for crash and double/wheel** if you want them live: a server clock per round (a start time and a hash, like Cobalt Lab) so every browser draws the same round with very few messages; avoid per-tick streaming unless you need cash-out during the curve.
4. **A real race and leaderboard** from the database (a view over server bets already exists for Crash; it needs the live games feeding it).
5. **Server-side rain and giveaways**, so the "rain" and prize features stop being simulations.
6. **A maintenance flag and global notice pushed at connect**, like Bandit.camp's `app.conga`, so you can announce downtime without a deploy.
7. **Keep snapshots small:** load lobby and chat history by request (50 rows and 30 messages today), and add random delay on reconnect.
8. **Housekeeping:** add a favicon (stops the 404), and keep the first load under 1 MB.
9. **Do not copy the heavy parts of the references:** 245 script files, 10 MB of images, tracking and ad scripts. Vaultrush's 0.64 MB first load is an advantage worth keeping.

## 9. Appendix: raw observations

Cobalt Lab, home, 63 s: 119 frames, 55.5 KB, 1.88 frames/s. Event counts: newBetHistory 18, tts 20, cb_tts 20, join 14, newRound 12, online 7, newGame 5, gameLock 5, endGame 4, liveWin 4, gameStarted 4. Sent by the browser: subscribe `crateBattle`, subscribe `chat_ru` (3 times), two pings.

Cobalt Lab, crash, 25 s: 74 frames, 3.4 KB: crashTTS 63, newBetHistory 1, crashEOS 1, crashStartGame 1, crashWaitEOS 1, online 3. Wheel, 25 s: 14 frames, 2.1 KB: newBetHistory 3, wheelRollEOS 1, wheelRollSet 1. Crate battles, 25 s: 20 frames, 6.7 KB.

Bandit.camp, home, 90 s steady: 104 frames, 44.5 KB: games.feed.new 90, chat.message 9, chat.discord.vc 2, app.online 3. First 8 s: replies 95.7 KB (chat history 57.7 KB), games.feed 8.8 KB, app.conga 6.8 KB.

Bandit.camp, 26 s each: wheel 59 frames / 229 KB (history 153.4 KB, newBet 17, round 2, feed.new 25); crate royale 45 / 137.4 KB; beancan blast 40 / 68 KB; crate battles 106 / 540.3 KB (active 418.8 KB, rollRound 29 / 23.8 KB, new 7 / 22.6 KB, playerJoined 15 / 4 KB, feed.new 25).

Clash.gg, 29 s each: crash 197 frames / 54.1 KB; double 44 / 5.4 KB; case battles 86 / 100 KB; champion 23 / 7.6 KB (42 s). Home 53 s: 48 frames / 4.2 KB.

First-load totals: Cobalt Lab 409 requests / 6,379 KB; Bandit.camp 610 / 16,707 KB; Clash.gg 258 / 5,549 KB; Vaultrush 49 / 655 KB.

**Sources for platform limits:** [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits), [Realtime quotas](https://supabase.com/docs/guides/realtime/quotas), [Subscribing to database changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes), [Realtime benchmarks](https://supabase.com/docs/guides/realtime/benchmarks), [Broadcast from database](https://supabase.com/blog/realtime-broadcast-from-database).

This is observation of publicly served pages by an ordinary browser session, for planning purposes. It is not legal advice, and it makes no claim about how any site runs behind its login.
