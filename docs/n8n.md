# n8n: alerts and a daily report

[n8n](https://n8n.io) is a workflow tool. Vaultrush uses it for two things that are for **you, the operator**, and never for the game itself:

1. **Alerts.** The database sends a short message when something happens that you want to know about, and n8n posts it in a chat channel (Discord by default).
2. **A daily report.** Every morning n8n asks the database for the last 24 hours (players, bets, coins wagered and paid, biggest win, coins in circulation, free coins issued, coins added by hand) and posts a summary.

**Status (2026-11-21):** set up and live. `0016` is run, the alerts are switched on in the live database, n8n runs on the owner's PC (Docker, a gate, an ngrok tunnel) and both workflows were confirmed end to end (a test alert and a real daily report reached Discord). Alerts arrive only while that PC and Docker are running; whether the 09:00 schedule is published is not confirmed (see [setup-status.md](setup-status.md)).

Nothing about coins, items, bets or payouts goes through n8n. Those stay in database functions where every change is one transaction. If n8n is down, the site is unaffected.

```
 Postgres (Supabase) ──pg_net, async──►  n8n webhook  ──►  Discord        (alerts)
 Postgres (Supabase) ◄──REST rpc────────  n8n schedule ──►  Discord        (daily report)
```

## What you get

| Event | When | What the message holds |
|---|---|---|
| `signup` | a new player finishes sign-up | the player's name |
| `big_win` | a bet pays at least `big_win_min` coins (default 1,000) and more than the stake | name, game, stake, payout, multiplier |
| `adjustment` | coins are added by hand (the "give coins" SQL, or the admin site's Wallets page) | name, amount, balance after |
| `admin` | any admin-site action is written to the audit log | the action, who, their role, the target, the reason (never the before/after values) |
| `maintenance` | maintenance mode is switched on or off | on or off, the message |
| `test` | you run `select public.ops_notify('test', '{}')` | nothing |

Messages carry only what is already public on the site (a player's name, a game, amounts). **No e-mail addresses, no IP addresses, no seeds.** Closing an account also writes a (negative) adjustment; those are not reported.

## What is in the repository

| File | Purpose |
|---|---|
| `supabase/migrations/0016_ops_events.sql` | The settings table, the sending function, five triggers and `ops_daily_report()`. Safe to run again. Sends nothing until you switch it on |
| `n8n/vaultrush-alerts.json` | n8n workflow: webhook (secret checked) -> writes the message -> posts to Discord |
| `n8n/vaultrush-daily-report.json` | n8n workflow: every morning (and a "test it now" button) -> asks the database -> writes the message -> posts to Discord |
| `n8n/docker-compose.yml`, `n8n/Caddyfile.gate`, `n8n/.env.example` | Run n8n on your own PC: n8n 2.48.7, a gate that lets only `/webhook/*` through, an optional ngrok tunnel. `n8n/.env` (your secrets) is ignored by git |
| `n8n/docker-compose.server.yml`, `n8n/Caddyfile.server` | The same for an always-on server with automatic https (not tested) |
| `tests/ops-db.test.ts` | 16 database tests for 0016 |

The workflow files contain **placeholders in capitals** (`PASTE-YOUR-DISCORD-WEBHOOK-URL`, `YOUR-PROJECT-REF`, `PASTE-THE-PUBLISHABLE-KEY`) and no secrets. **Never export a workflow with your values filled in and commit it**: this repository is public.

## Setting it up (you do this)

**1. Run `0016_ops_events.sql`** in the Supabase SQL editor (after 0015). If it prints a notice that `pg_net` could not be created, open Dashboard > Database > Extensions, enable **pg_net**, and run the file again. Nothing is sent yet.

**2. Get an n8n that Supabase can reach over https.** The database can only send to a public `https://` address, so n8n must be reachable from the internet (the editor itself should not be). Pick one:

- **A. On your own PC (free; alerts only arrive while the PC and Docker are on).** Uses Docker Desktop, a small gate that lets only webhook calls through, and a free **ngrok** account for a fixed https address. Tested.
  1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
  2. Make a free account at [ngrok.com](https://ngrok.com). In its dashboard copy **Your Authtoken**, and under **Domains** copy your free **dev domain** (something like `name-name.ngrok-free.dev`; every account gets one). You do not need to install ngrok or run `ngrok config add-authtoken` on your PC: Docker runs ngrok and takes the token from `.env`.
  3. In the `n8n` folder of the project, copy `.env.example` to `.env` and fill it in: `N8N_ENCRYPTION_KEY` (a long random string, **keep it**: the file explains how to make one), `GENERIC_TIMEZONE` (your time zone, e.g. `Europe/Sofia`), `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` (without `https://`), and `N8N_WEBHOOK_URL=https://<your domain>/`.
  4. From that folder run `docker compose --profile tunnel up -d`. Open **http://localhost:5678** and create your owner account (this editor is reachable only from this PC).
  5. Check the tunnel: `https://<your domain>/webhook/anything` should answer from n8n, and `https://<your domain>/` should answer `Not found`.
  Stop it with `docker compose --profile tunnel down`; your workflows and credentials stay in a Docker volume. Containers restart by themselves after a reboot once Docker Desktop is running.
  What the gate does: ngrok points at a Caddy gate (`Caddyfile.gate`), which passes only `/webhook/*` to n8n; the editor, its login and its API answer 404 from outside. Tested: the right secret gets through and delivers the message, a wrong secret gets 403, every other path gets 404.
- **B. On a small always-on server (about 4 to 6 euro a month; alerts arrive 24 hours a day).** Needs a domain name pointing at the server. Use `n8n/docker-compose.server.yml` and `Caddyfile.server` (Caddy gets the https certificate by itself); the file's header lists the steps. Create the owner account the moment it is up. **Not tested here** (it needs a real server and domain).
- **C. n8n Cloud** (easiest, paid after a trial): sign up at n8n.io; the webhook addresses are already https and public, and you skip this step's Docker work.

**3. Make a secret.** In the Supabase SQL editor:
```sql
update public.ops_settings set webhook_secret = encode(gen_random_bytes(24), 'hex') where id = 1;
select webhook_secret from public.ops_settings;     -- copy it; you need it twice below
```

**4. Create two credentials in n8n** (Credentials > Create credential > **Header Auth**):
- name `Vaultrush alert secret`: header name `X-Vaultrush-Secret`, value = the secret from step 3
- name `Vaultrush report secret`: header name `x-ops-secret`, value = the same secret

**5. Make a Discord webhook** (Discord: channel settings > Integrations > Webhooks > New webhook > Copy webhook URL). Slack and Mattermost work too: change the body of the last node (Slack wants `{"text": ...}`). For Telegram or e-mail, replace the last node with n8n's Telegram or Send Email node and use `{{ $json.message }}` as the text.

**6. Import the two workflows** (Workflows > the menu > **Import from file**): `n8n/vaultrush-alerts.json` and `n8n/vaultrush-daily-report.json`. Then:
- in both, open **Send to Discord** and paste the Discord webhook URL into *URL*;
- in the alerts workflow, open the first node and choose the credential `Vaultrush alert secret`;
- in the daily report, open **Ask the database for the report**: replace `YOUR-PROJECT-REF` in the URL with your Supabase project reference, paste the **publishable key** (the public `sb_publishable_...` key from Project Settings > API; it is the same key the website uses, not the secret key) as the `apikey` header value, and choose the credential `Vaultrush report secret`;
- click **Execute workflow** on the daily report: a summary should appear in Discord;
- switch both workflows to **Active**.

**7. Switch the alerts on** in the SQL editor, using the **Production URL** shown on the alerts workflow's first node (not the Test URL):
```sql
update public.ops_settings set webhook_url = 'https://<your n8n>/webhook/vaultrush-events', enabled = true where id = 1;
select public.ops_notify('test', '{}');     -- a "Test message" should appear in Discord within a few seconds
```
If nothing arrives, look at what the database sent and what came back: `select id, status_code, content from net._http_response order by id desc limit 5;` (403 means the secret in n8n does not match; 404 means the workflow is not active or you used the Test URL).

## Settings (all in `public.ops_settings`, only you can read or change them)

```sql
update public.ops_settings set big_win_min = 5000 where id = 1;                                 -- what counts as a big win, in coins
update public.ops_settings set events = array['big_win', 'maintenance'] where id = 1;           -- only these events are sent
update public.ops_settings set enabled = false where id = 1;                                    -- stop everything (the report still answers)
update public.ops_settings set webhook_secret = encode(gen_random_bytes(24), 'hex') where id = 1;   -- rotate the secret (then update both n8n credentials)
```

## Security

- The secret lives only in the database (a table with no policy and no grant, so no browser can read it) and in n8n's credential store. The daily report needs that secret in the `x-ops-secret` header; with the public key alone it answers `forbidden`. The Supabase **service key is never given to n8n**.
- Sending is asynchronous (pg_net) and every error is swallowed, so an alert can never slow down or break a bet, a sign-up or an admin action. Tests prove that, including with the network function raising and with pg_net missing.
- A message goes to whatever address is in `webhook_url`: only use your own n8n, and keep the address private.
- The Privacy page lists the automation service among the providers; if you switch alerts on with players' names, keep that sentence true.

## What was tested, and what was not

- `tests/ops-db.test.ts` (16 tests): off by default, each event's message and fields, the threshold and the event list, never breaking anything, browsers cannot read or call, the report's secret check and its numbers.
- Both workflows were imported into a real n8n (2.48.7, in Docker) and run against a stand-in server: missing or wrong secret -> 403; all seven message types formatted; the report call carried the key and the secret; the summary came out as expected.
- **Confirmed live (2026-11-21):** with n8n on the owner's PC behind the gate and an ngrok tunnel, the test alert (`select public.ops_notify('test', '{}')`) and the daily report both reached a real Discord channel, so the real hop from Supabase's pg_net to n8n works. A real report showed live numbers.
- **Not tested:** the always-on server variant (`docker-compose.server.yml`), and n8n Cloud.

## Later ideas

A price-refresh job fits **GitHub Actions** better than n8n (it runs the repository's `npm run build:catalogue`); more alerts (a large coin balance, repeated sign-ups) are one trigger in 0016 plus one branch in the alerts workflow.
