-- Vaultrush 0012: rewards on the SERVER wallet, and the switch that turns the server wallet on. Run after 0011_live_wallet.sql.
--
-- Where free coins and free items come from now (nothing is minted by the browser any more):
--   * the faucet     : 25 coins every 10 minutes,
--   * rakeback       : a share of every stake, claimed from the Rewards page (instant, daily, weekly),
--   * login calendar : 1, 2, 3, 5, 8, 12, 25 coins on seven consecutive days (UTC days; a missed day starts over),
--   * promo codes    : a table you can edit (step E of the admin plan puts an editor on it); each code works once per player,
--   * free crates    : the welcome crate (once per account), the daily crate (once per 24 hours) and the level crates (level 10, 20 ... 60),
--                      each drawn from the player's secret seed and put into the inventory,
--   * the daily race : yesterday's top 10 by wagered coins share 400 / 200 / 120 / 80 / 60 / 50 / 35 / 25 / 20 / 10.
-- wallet_ready() is created last: the page uses the server wallet only once it answers true, so running 0008 to 0012 in order never breaks the site.

-- ============================ promo codes ====================================================================================
create table public.promo_codes (
  code       text primary key check (code = upper(code) and char_length(code) between 3 and 20),
  amount     numeric(12, 2) not null check (amount > 0),
  max_uses   integer check (max_uses is null or max_uses > 0),        -- null = unlimited
  uses       integer not null default 0,
  active     boolean not null default true,
  expires_at timestamptz
);
alter table public.promo_codes enable row level security;               -- no policy: only the functions below read it
revoke all on public.promo_codes from anon, authenticated;
insert into public.promo_codes (code, amount) values ('VAULT10', 10), ('RUSH5', 5), ('WELCOME3', 3), ('LUCKY7', 7);

-- ============================ the faucet ======================================================================================
create function public.claim_faucet() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); pr public.player_rewards; bal numeric;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if pr.faucet_at is not null and pr.faucet_at > now() - interval '10 minutes' then
    return jsonb_build_object('claimed', false, 'next_at', (extract(epoch from pr.faucet_at + interval '10 minutes') * 1000)::bigint, 'balance', (select balance from public.wallets where user_id = uid));
  end if;
  update public.player_rewards set faucet_at = now() where user_id = uid;
  bal := public.wallet_credit(uid, 25, 'faucet');
  return jsonb_build_object('claimed', true, 'amount', 25, 'balance', bal, 'next_at', (extract(epoch from now() + interval '10 minutes') * 1000)::bigint);
end $$;

-- ============================ rakeback ========================================================================================
create function public.claim_rakeback(p_kind text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); pr public.player_rewards; amt numeric; bal numeric;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  if p_kind is null or p_kind not in ('instant', 'daily', 'weekly') then raise exception 'invalid_claim'; end if;
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if p_kind = 'daily' and pr.last_daily is not null and pr.last_daily > now() - interval '1 day' then raise exception 'not_ready'; end if;
  if p_kind = 'weekly' and pr.last_weekly is not null and pr.last_weekly > now() - interval '7 days' then raise exception 'not_ready'; end if;
  amt := round(case p_kind when 'instant' then pr.rb_instant when 'daily' then pr.rb_daily else pr.rb_weekly end, 2);
  if amt < 0.01 then raise exception 'nothing_to_claim'; end if;
  update public.player_rewards set
    rb_instant = case when p_kind = 'instant' then 0 else rb_instant end,
    rb_daily   = case when p_kind = 'daily' then 0 else rb_daily end,
    rb_weekly  = case when p_kind = 'weekly' then 0 else rb_weekly end,
    last_daily  = case when p_kind = 'daily' then now() else last_daily end,
    last_weekly = case when p_kind = 'weekly' then now() else last_weekly end
   where user_id = uid;
  bal := public.wallet_credit(uid, amt, 'rakeback');
  return jsonb_build_object('amount', amt, 'balance', bal);
end $$;

-- ============================ login calendar ==================================================================================
create function public.claim_calendar() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); pr public.player_rewards; today date := (now() at time zone 'utc')::date; cur integer; i integer; amt numeric; bal numeric;
  pay numeric[] := array[1, 2, 3, 5, 8, 12, 25];
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if pr.calendar_last = today then raise exception 'already_claimed'; end if;
  cur := case when pr.calendar_last = today - 1 then pr.calendar_streak else 0 end;
  i := cur % 7;                                                   -- a finished 7-day cycle starts over
  amt := pay[i + 1];
  update public.player_rewards set calendar_streak = i + 1, calendar_last = today where user_id = uid;
  bal := public.wallet_credit(uid, amt, 'calendar');
  return jsonb_build_object('day', i + 1, 'amount', amt, 'balance', bal);
end $$;

-- ============================ promo codes =====================================================================================
create function public.redeem_promo(p_code text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); c_code text := upper(trim(coalesce(p_code, ''))); pc public.promo_codes; pr public.player_rewards; bal numeric;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  select * into pc from public.promo_codes where promo_codes.code = c_code for update;
  if not found or not pc.active or (pc.expires_at is not null and pc.expires_at < now()) then raise exception 'invalid_code'; end if;
  if c_code = any (pr.promos) then raise exception 'code_used'; end if;
  if pc.max_uses is not null and pc.uses >= pc.max_uses then raise exception 'code_used_up'; end if;
  update public.promo_codes set uses = uses + 1 where promo_codes.code = c_code;
  update public.player_rewards set promos = promos || c_code where user_id = uid;
  bal := public.wallet_credit(uid, pc.amount, 'promo');
  return jsonb_build_object('code', c_code, 'amount', pc.amount, 'balance', bal);
end $$;

-- ============================ free crates =====================================================================================
-- kind: 'welcome' (once per account), 'daily_case' (once per 24 hours) or 'level_10' ... 'level_60' (once each, from that level on).
-- Returns {claimed:false,...} when it was already taken, otherwise the item drawn (it is already in the inventory).
create function public.open_free_case(p_kind text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); cid text; src text; req integer; lvl integer; cur timestamptz; nxt timestamptz; pr public.player_rewards; fair public.fair_t; ticket integer; item text; val numeric; inv uuid;
  levels integer[] := array[10, 20, 30, 40, 50, 60]; level_cases text[] := array['starter', 'neon', 'charmed', 'sniper', 'blade', 'high'];
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  if p_kind in ('welcome', 'daily_case') then
    perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_kind, 0));
    select claimed_at into cur from public.free_claims where user_id = uid and kind = p_kind;
    if found and (p_kind = 'welcome' or cur > now() - interval '24 hours') then
      return jsonb_build_object('claimed', false, 'last', cur, 'next', case when p_kind = 'welcome' then null else cur + interval '24 hours' end);
    end if;
    insert into public.free_claims (user_id, kind, claimed_at) values (uid, p_kind, now()) on conflict (user_id, kind) do update set claimed_at = excluded.claimed_at;
    nxt := case when p_kind = 'welcome' then null else now() + interval '24 hours' end;
    cid := case p_kind when 'welcome' then 'welcome' else 'daily' end;
    src := case p_kind when 'welcome' then 'Welcome gift' else 'Daily case' end;
  elsif p_kind ~ '^level_[0-9]+$' then
    req := substring(p_kind from 7)::integer;
    if not (req = any (levels)) then raise exception 'invalid_claim'; end if;
    select floor(sqrt(round(w.wagered * 10) / 10))::integer into lvl from public.wallets w where w.user_id = uid;
    if lvl < req then raise exception 'level_too_low'; end if;
    select * into pr from public.player_rewards where user_id = uid for update;
    if req = any (pr.keys_used) then return jsonb_build_object('claimed', false); end if;
    update public.player_rewards set keys_used = keys_used || req where user_id = uid;
    cid := level_cases[array_position(levels, req)];
    src := 'Level ' || req || ' key';
  else
    raise exception 'invalid_claim';
  end if;
  fair := public.fair_draw(uid, 1);
  ticket := floor(fair.floats[1] * 100000)::integer;
  select e.item_id, it.value into item, val from public.catalog_case_entries e join public.catalog_items it on it.id = e.item_id
   where e.case_id = cid and ticket between e.ticket_from and e.ticket_to;
  if item is null then raise exception 'catalogue_gap'; end if;
  inv := public.inventory_add(uid, item, src);
  perform public.bet_record(uid, 'cases', 0, val, fair, jsonb_build_object('case', cid, 'free', p_kind), jsonb_build_object('ticket', ticket, 'item', item, 'value', val));
  return jsonb_build_object('claimed', true, 'item', item, 'uid', inv, 'ticket', ticket, 'value', val, 'case', cid, 'label', src, 'next', nxt, 'nonce', fair.nonce);
end $$;

-- ============================ the daily race ==================================================================================
create function public.claim_race_prize() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); y date := (now() at time zone 'utc')::date - 1; pr public.player_rewards; rnk integer; prize numeric; bal numeric; wag numeric;
  prizes numeric[] := array[400, 200, 120, 80, 60, 50, 35, 25, 20, 10];
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if pr.race_paid = y then return jsonb_build_object('paid', false); end if;
  update public.player_rewards set race_paid = y where user_id = uid;
  select r.rank, r.wagered into rnk, wag from (
    select b.user_id, sum(b.amount) as wagered, row_number() over (order by sum(b.amount) desc, b.user_id) as rank
      from public.bets b where b.amount > 0 and b.created_at >= (y::timestamp at time zone 'utc') and b.created_at < ((y + 1)::timestamp at time zone 'utc') group by b.user_id) r
   where r.user_id = uid;
  if rnk is null or rnk > 10 then return jsonb_build_object('paid', false, 'rank', rnk); end if;
  prize := prizes[rnk];
  bal := public.wallet_credit(uid, prize, 'race');
  return jsonb_build_object('paid', true, 'rank', rnk, 'prize', prize, 'balance', bal, 'wagered', wag);
end $$;

-- ============================ the snapshot grows: claims, and old lobbies are reaped ============================================
create or replace function public.wallet_me() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); w public.wallets; pr public.player_rewards;
begin
  perform public.live_player(uid);
  perform public.live_reap();
  select * into w from public.wallets where user_id = uid;
  select * into pr from public.player_rewards where user_id = uid;
  return jsonb_build_object(
    'balance', w.balance, 'wagered', w.wagered, 'won', w.won, 'xp', round(w.wagered * 10),
    'rewards', jsonb_build_object(
      'rb_instant', round(coalesce(pr.rb_instant, 0), 2), 'rb_daily', round(coalesce(pr.rb_daily, 0), 2), 'rb_weekly', round(coalesce(pr.rb_weekly, 0), 2),
      'last_daily', (extract(epoch from pr.last_daily) * 1000)::bigint, 'last_weekly', (extract(epoch from pr.last_weekly) * 1000)::bigint,
      'calendar_streak', coalesce(pr.calendar_streak, 0), 'calendar_last', pr.calendar_last, 'promos', to_jsonb(coalesce(pr.promos, '{}')),
      'keys_used', to_jsonb(coalesce(pr.keys_used, '{}')), 'faucet_at', (extract(epoch from pr.faucet_at) * 1000)::bigint,
      'welcome_at', (select (extract(epoch from claimed_at) * 1000)::bigint from public.free_claims where user_id = uid and kind = 'welcome'),
      'daily_case_at', (select (extract(epoch from claimed_at) * 1000)::bigint from public.free_claims where user_id = uid and kind = 'daily_case')),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('uid', i.id, 'id', i.item_id, 'at', (extract(epoch from i.created_at) * 1000)::bigint) order by i.created_at desc, i.id)
                             from public.inventory i where i.user_id = uid), '[]'::jsonb),
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

-- Realtime: the page hears about changes to its own wallet and inventory (row-level security limits each row to its owner).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wallets;
    alter publication supabase_realtime add table public.inventory;
  end if;
end $$;

-- ============================ the switch ======================================================================================
create function public.wallet_ready() returns boolean language sql stable as $$ select true $$;

revoke execute on function public.claim_faucet(), public.claim_rakeback(text), public.claim_calendar(), public.redeem_promo(text), public.open_free_case(text),
  public.claim_race_prize(), public.wallet_ready() from public, anon, authenticated;
grant execute on function public.claim_faucet(), public.claim_rakeback(text), public.claim_calendar(), public.redeem_promo(text), public.open_free_case(text),
  public.claim_race_prize(), public.wallet_ready() to authenticated;
