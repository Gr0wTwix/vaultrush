# n8n workflows

Two importable workflows for [n8n](https://n8n.io):

- `vaultrush-alerts.json`: receives alerts from the database (new player, big win, coins added by hand, admin action, maintenance) and posts them to a chat channel.
- `vaultrush-daily-report.json`: asks the database for the last 24 hours every morning and posts a summary.

They contain **placeholders in capitals and no secrets**. Setup, the database side (`supabase/migrations/0016_ops_events.sql`), security and testing are in [../docs/n8n.md](../docs/n8n.md).

Also here: `docker-compose.yml`, `Caddyfile.gate` and `.env.example` (run n8n on your own PC behind a gate that lets only webhooks through, with an ngrok tunnel), and `docker-compose.server.yml` with `Caddyfile.server` (an always-on server with automatic https). Copy `.env.example` to `.env` (git ignores it) and fill it in; steps in [../docs/n8n.md](../docs/n8n.md).

Do not export a workflow with your own values filled in and commit it: the repository is public.
