-- Vaultrush 0016: alerts and a daily report for the owner's automation tool (n8n). Run after 0015. See docs/n8n.md.
--
--   * Alerts: when something worth knowing happens (a new player, a big win, coins given by hand, an admin action, maintenance switched) the database sends a small
--     JSON message to a web address you choose (an n8n webhook). Nothing is sent until you fill in `ops_settings` and switch it on, and an alert can NEVER break a bet,
--     a sign-up or an admin action: sending is asynchronous (pg_net) and every error is swallowed.
--   * A daily report: `ops_daily_report()` returns the numbers for the last 24 hours (players, bets, coins wagered and paid, biggest win, coins in circulation, free coins
--     issued, hand adjustments). It is guarded by the same secret, sent in the `x-ops-secret` header, so the automation tool only needs the site's public (publishable) key
--     plus that secret, never the database's service key.
--   * Messages carry only what is already public on the site (a player's name, a game, amounts). No e-mail addresses, no IP addresses, no seeds.
--
-- The settings table has no policy and no grant: only you, in the SQL editor, can read or change it (it holds the secret).

-- sends the web requests; if it cannot be created here, switch it on under Database > Extensions and run this file again
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net could not be created: enable it under Database > Extensions, then run this file again (%)', sqlerrm;
end $$;

create table if not exists public.ops_settings (
  id            integer primary key default 1 check (id = 1),
  enabled       boolean not null default false,
  webhook_url   text not null default '',
  webhook_secret text not null default '',
  big_win_min   numeric(14, 2) not null default 1000 check (big_win_min >= 0),                  -- a win is "big" from this payout (in coins) up
  events        text[] not null default array['signup', 'big_win', 'adjustment', 'admin', 'maintenance'],
  updated_at    timestamptz not null default now()
);
insert into public.ops_settings (id) values (1) on conflict (id) do nothing;
alter table public.ops_settings enable row level security;          -- no policy: no browser can read the secret
revoke all on public.ops_settings from anon, authenticated;

create index if not exists bets_created_at on public.bets (created_at desc);
create index if not exists ledger_created_at on public.ledger (created_at desc);

-- the one place that sends: checks the switch, the address and the event list, and never raises
create or replace function public.ops_notify(p_event text, p_data jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.ops_settings;
begin
  select * into s from public.ops_settings where id = 1;
  if not found or not s.enabled or s.webhook_url !~ '^https://' then return; end if;
  if p_event <> 'test' and not (p_event = any (s.events)) then return; end if;
  perform net.http_post(
    url := s.webhook_url,
    body := jsonb_build_object('event', p_event, 'at', now(), 'data', coalesce(p_data, '{}'::jsonb)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Vaultrush-Secret', s.webhook_secret));
exception when others then
  null;                                                              -- an alert must never break a game, a sign-up or an admin action
end $$;
revoke execute on function public.ops_notify(text, jsonb) from public, anon, authenticated;

-- ============================ the events ====================================================================================================
create or replace function public.ops_on_signup() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ops_notify('signup', jsonb_build_object('name', new.display_name));
  return new;
end $$;
drop trigger if exists ops_signup on public.profiles;
create trigger ops_signup after insert on public.profiles for each row execute function public.ops_on_signup();

create or replace function public.ops_on_bet() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare min_win numeric; who text;
begin
  select big_win_min into min_win from public.ops_settings where id = 1;
  if min_win is null or new.payout < min_win or new.payout <= new.amount then return new; end if;
  select display_name into who from public.profiles where id = new.user_id;
  perform public.ops_notify('big_win', jsonb_build_object('name', who, 'game', new.game, 'amount', new.amount, 'payout', new.payout, 'multiplier', new.multiplier));
  return new;
end $$;
drop trigger if exists ops_big_win on public.bets;
create trigger ops_big_win after insert on public.bets for each row when (new.payout > new.amount) execute function public.ops_on_bet();

-- coins added by hand (the "give coins" SQL, or an admin tool later); closing an account also writes an adjustment, but a negative one, so it is not reported
create or replace function public.ops_on_ledger() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare who text;
begin
  select display_name into who from public.profiles where id = new.user_id;
  perform public.ops_notify('adjustment', jsonb_build_object('name', who, 'amount', new.amount, 'balance_after', new.balance_after));
  return new;
end $$;
drop trigger if exists ops_adjustment on public.ledger;
create trigger ops_adjustment after insert on public.ledger for each row when (new.kind = 'adjustment' and new.amount > 0) execute function public.ops_on_ledger();

create or replace function public.ops_on_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ops_notify('admin', jsonb_build_object('action', new.action, 'actor', new.actor_name, 'role', new.actor_role, 'target_type', new.target_type, 'target_id', new.target_id, 'reason', left(coalesce(new.reason, ''), 200)));
  return new;
end $$;
drop trigger if exists ops_admin_action on public.admin_audit_log;
create trigger ops_admin_action after insert on public.admin_audit_log for each row execute function public.ops_on_audit();

create or replace function public.ops_on_site() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ops_notify('maintenance', jsonb_build_object('on', new.maintenance_on, 'message', left(coalesce(new.maintenance_message, ''), 200)));
  return new;
end $$;
drop trigger if exists ops_maintenance on public.site_controls;
create trigger ops_maintenance after update on public.site_controls for each row when (old.maintenance_on is distinct from new.maintenance_on) execute function public.ops_on_site();

-- ============================ the daily report ==============================================================================================
-- Called through the REST API by the automation tool: POST /rest/v1/rpc/ops_daily_report with the publishable key in `apikey` and the secret in `x-ops-secret`.
create or replace function public.ops_daily_report(p_hours integer default 24) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s public.ops_settings; hdr text; given text; since timestamptz; hrs integer := least(greatest(coalesce(p_hours, 24), 1), 168);
  b record; w record; m record;
begin
  select * into s from public.ops_settings where id = 1;
  begin hdr := current_setting('request.headers', true); given := (hdr::json) ->> 'x-ops-secret'; exception when others then given := null; end;
  if not found or s.webhook_secret = '' or given is distinct from s.webhook_secret then raise exception 'forbidden'; end if;
  since := now() - make_interval(hours => hrs);

  select count(*) as n, coalesce(sum(amount), 0) as wagered, coalesce(sum(payout), 0) as paid, count(distinct user_id) as players into b from public.bets where created_at >= since;
  select p.display_name as name, x.game, x.amount, x.payout into w from public.bets x join public.profiles p on p.id = x.user_id where x.created_at >= since order by x.payout desc, x.id limit 1;
  select coalesce(sum(amount) filter (where kind in ('bonus', 'faucet', 'rakeback', 'calendar', 'promo', 'race', 'crate')), 0) as free_coins,
         coalesce(sum(amount) filter (where kind = 'adjustment' and amount > 0), 0) as adjusted, count(*) filter (where kind = 'adjustment' and amount > 0) as adjustments into m
    from public.ledger where created_at >= since;

  return jsonb_build_object(
    'hours', hrs, 'generated_at', now(),
    'players_total', (select count(*) from public.profiles where deleted_at is null),
    'new_players', (select count(*) from public.profiles where created_at >= since and deleted_at is null),
    'active_players', b.players,
    'bets', b.n, 'wagered', b.wagered, 'paid_out', b.paid, 'house_result', round(b.wagered - b.paid, 2),
    'by_game', coalesce((select jsonb_agg(jsonb_build_object('game', q.game, 'bets', q.n, 'wagered', q.wagered, 'paid_out', q.paid) order by q.wagered desc, q.game) from (
        select game, count(*) as n, sum(amount) as wagered, sum(payout) as paid
          from public.bets where created_at >= since group by game order by sum(amount) desc, game limit 10) q), '[]'::jsonb),
    'biggest_win', case when w.name is null then null else jsonb_build_object('name', w.name, 'game', w.game, 'amount', w.amount, 'payout', w.payout) end,
    'coins_in_wallets', (select coalesce(sum(balance), 0) from public.wallets),
    'items_held', (select count(*) from public.inventory),
    'items_value', (select coalesce(sum(c.value), 0) from public.inventory i join public.catalog_items c on c.id = i.item_id),
    'free_coins_issued', m.free_coins, 'coins_adjusted', m.adjusted, 'adjustments', m.adjustments,
    'maintenance_on', (select maintenance_on from public.site_controls where id = 1));
end $$;
revoke execute on function public.ops_daily_report(integer) from public;
grant execute on function public.ops_daily_report(integer) to anon, authenticated, service_role;
