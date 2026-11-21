-- Vaultrush 0018: every responsible-play limit is enforced by the database, not only by the page. Run after 0017.
--
-- Before this, only the maximum bet and the daily loss limit could exist on the server (nothing in the page ever sent them), and the weekly and monthly loss limits,
-- the daily wager limit, the daily play-time limit, cool-offs and self-exclusion lived only in the browser, so a changed or reloaded page could bypass them.
-- Now:
--   * account_controls holds all six limits; the same rules as the page: a tighter limit applies at once, a looser or removed one waits 24 hours (request_limit_change).
--   * wallet_gate (the one gate every stake passes through: bets, case openings, upgrades, coinflips, battles, Crash, Double) refuses a stake that would pass a limit,
--     with its own error: wager_daily_limit, daily_loss_limit, weekly_loss_limit, monthly_loss_limit, time_limit.
--   * Counting windows are UTC calendar days, like the page: "daily" is today, "weekly" the last 7 days including today, "monthly" the last 30.
--       - loss limits: settled bets, winnings offset losses, never below zero (stake + net loss so far must stay within the limit);
--       - daily wager: coins staked today, from the ledger (a refunded stake does not count);
--       - daily play time: ESTIMATED from stakes, because the server cannot see an open page: the time between two stakes counts when it is 5 minutes or less,
--         plus 20 seconds for each stake. It blocks a stake once the estimate has reached the limit. (The page's own timer of how long the page was open is
--         only shown to the player; with the server wallet on, the database's estimate is the one that decides.)
--       - known limit: a live game's stake (coinflip, Crash, Double, battle) counts as a loss only when the round settles, like the daily loss limit always did;
--         stakes of rounds that are still open are counted by the wager limit (it reads the ledger) but not by the loss limits.
--   * Cool-off (start_cool_off) and self-exclusion (self_exclude, from 0001) are stored on the server too and can only be extended, never shortened.
--   * my_limits() returns the player's limits, pending changes, what has been used and the break dates, for the page to show.
-- Running this file again changes nothing.

alter table public.account_controls
  add column if not exists loss_weekly   numeric(12, 2) check (loss_weekly is null or loss_weekly >= 0),
  add column if not exists loss_monthly  numeric(12, 2) check (loss_monthly is null or loss_monthly >= 0),
  add column if not exists wager_daily   numeric(12, 2) check (wager_daily is null or wager_daily >= 0),
  add column if not exists time_daily_min integer check (time_daily_min is null or time_daily_min >= 0);

alter table public.limit_changes drop constraint if exists limit_changes_key_check;
alter table public.limit_changes add constraint limit_changes_key_check
  check (key in ('max_bet', 'loss_daily', 'loss_weekly', 'loss_monthly', 'wager_daily', 'time_daily_min'));

-- ============================ counting helpers (internal: clients cannot call them) =========================================================
-- the start of a UTC day, `d` days back (0 = today)
create or replace function public.rg_day_start(d integer) returns timestamptz language sql stable as $$
  select (date_trunc('day', now() at time zone 'utc') - make_interval(days => d)) at time zone 'utc'
$$;
-- coins staked today, minus stakes that were refunded
create or replace function public.rg_staked(p_uid uuid) returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(-sum(amount), 0) from public.ledger where user_id = p_uid and kind in ('bet', 'refund') and created_at >= public.rg_day_start(0)
$$;
-- net loss (stakes minus payouts of settled bets) over the last `p_days` UTC days including today; negative when the player is ahead
create or replace function public.rg_net_loss(p_uid uuid, p_days integer) returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount - payout), 0) from public.bets where user_id = p_uid and created_at >= public.rg_day_start(p_days - 1)
$$;
-- estimated minutes of play today (see the header)
create or replace function public.rg_active_minutes(p_uid uuid) returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(floor((sum(case when gap is not null and gap <= 300 then gap else 0 end) + count(*) * 20) / 60.0), 0)::integer
    from (select extract(epoch from (created_at - lag(created_at) over (order by created_at))) as gap
            from public.ledger where user_id = p_uid and kind = 'bet' and created_at >= public.rg_day_start(0)) x
$$;
revoke execute on function public.rg_day_start(integer), public.rg_staked(uuid), public.rg_net_loss(uuid, integer), public.rg_active_minutes(uuid) from public, anon, authenticated;

-- ============================ changing limits ===============================================================================================
create or replace function public.apply_due_limits(p_user uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select * from public.limit_changes where user_id = p_user and effective_at <= now() order by id loop
    execute format('update public.account_controls set %I = $1 where user_id = $2', r.key) using r.value, p_user;         -- the key is limited to the six names by a check
    delete from public.limit_changes where id = r.id;
  end loop;
end $$;

-- Tightening a limit applies at once; loosening or removing it waits 24 hours (and replaces any earlier pending change). Asking for the current value cancels a pending change.
create or replace function public.request_limit_change(p_key text, p_value numeric) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur numeric;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_key is null or p_key <> all (array['max_bet', 'loss_daily', 'loss_weekly', 'loss_monthly', 'wager_daily', 'time_daily_min']) then raise exception 'unknown_limit'; end if;
  if p_value is not null and (p_value < 0 or p_value <> round(p_value, 2) or p_value > 1000000000) then raise exception 'invalid_limit'; end if;
  if p_key = 'time_daily_min' and p_value is not null and (p_value <> round(p_value) or p_value > 1440) then raise exception 'invalid_limit'; end if;
  perform public.apply_due_limits(uid);
  delete from public.limit_changes where user_id = uid and key = p_key;
  execute format('select %I::numeric from public.account_controls where user_id = $1', p_key) into cur using uid;
  if p_value is not distinct from cur then return 'same'; end if;
  if p_value is not null and (cur is null or p_value < cur) then
    execute format('update public.account_controls set %I = $1 where user_id = $2', p_key) using p_value, uid;
    return 'applied';
  end if;
  insert into public.limit_changes (user_id, key, value, effective_at) values (uid, p_key, p_value, now() + interval '24 hours');
  return 'pending';
end $$;

-- A cool-off: a pause the player chooses, 1 hour to 30 days. It can be extended but never shortened. Returns when it ends.
create or replace function public.start_cool_off(p_hours integer) returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); until timestamptz;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 * 30 then raise exception 'invalid_duration'; end if;
  update public.account_controls set cool_off_until = greatest(coalesce(cool_off_until, now()), now() + make_interval(hours => p_hours))
   where user_id = uid returning cool_off_until into until;
  if until is null then raise exception 'no_account'; end if;
  return until;
end $$;

-- ============================ the gate ======================================================================================================
-- The same checks as before (age, self-exclusion, cool-off, maximum bet, verification cap from 0017, daily loss) plus the new limits.
create or replace function public.wallet_gate(p_uid uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare prof public.profiles; ctl public.account_controls; tier_cap numeric;
begin
  perform public.apply_due_limits(p_uid);
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  select * into prof from public.profiles where id = p_uid;
  if not found or prof.deleted_at is not null then raise exception 'no_account'; end if;
  select * into ctl from public.account_controls where user_id = p_uid;
  if prof.age_confirmed_at is null then raise exception 'age_not_confirmed'; end if;
  if ctl.excluded_until is not null and ctl.excluded_until > now() then raise exception 'self_excluded'; end if;
  if ctl.cool_off_until is not null and ctl.cool_off_until > now() then raise exception 'cool_off'; end if;
  if ctl.max_bet is not null and p_amount > ctl.max_bet then raise exception 'max_bet_exceeded'; end if;
  tier_cap := case ctl.kyc_tier when 0 then 10000 when 1 then 25000 else 50000 end;
  if p_amount > tier_cap then raise exception 'tier_cap_exceeded'; end if;
  if ctl.wager_daily is not null and public.rg_staked(p_uid) + p_amount > ctl.wager_daily then raise exception 'wager_daily_limit'; end if;
  if ctl.loss_daily is not null and greatest(public.rg_net_loss(p_uid, 1), 0) + p_amount > ctl.loss_daily then raise exception 'daily_loss_limit'; end if;
  if ctl.loss_weekly is not null and greatest(public.rg_net_loss(p_uid, 7), 0) + p_amount > ctl.loss_weekly then raise exception 'weekly_loss_limit'; end if;
  if ctl.loss_monthly is not null and greatest(public.rg_net_loss(p_uid, 30), 0) + p_amount > ctl.loss_monthly then raise exception 'monthly_loss_limit'; end if;
  if ctl.time_daily_min is not null and public.rg_active_minutes(p_uid) >= ctl.time_daily_min then raise exception 'time_limit'; end if;
end $$;

-- ============================ what the page shows ===========================================================================================
create or replace function public.my_limits() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); ctl public.account_controls;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  perform public.apply_due_limits(uid);
  select * into ctl from public.account_controls where user_id = uid;
  if not found then raise exception 'no_account'; end if;
  return jsonb_build_object(
    'limits', jsonb_build_object('max_bet', ctl.max_bet, 'loss_daily', ctl.loss_daily, 'loss_weekly', ctl.loss_weekly, 'loss_monthly', ctl.loss_monthly,
                                 'wager_daily', ctl.wager_daily, 'time_daily_min', ctl.time_daily_min),
    'pending', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'value', c.value, 'effective_at', (extract(epoch from c.effective_at) * 1000)::bigint) order by c.id), '[]'::jsonb)
                  from public.limit_changes c where c.user_id = uid),
    'usage', jsonb_build_object('staked_today', public.rg_staked(uid), 'loss_1', greatest(public.rg_net_loss(uid, 1), 0), 'loss_7', greatest(public.rg_net_loss(uid, 7), 0),
                                'loss_30', greatest(public.rg_net_loss(uid, 30), 0), 'active_minutes', public.rg_active_minutes(uid)),
    'excluded_until', (extract(epoch from ctl.excluded_until) * 1000)::bigint,
    'cool_off_until', (extract(epoch from ctl.cool_off_until) * 1000)::bigint,
    'kyc_tier', ctl.kyc_tier,
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

revoke execute on function public.start_cool_off(integer), public.my_limits() from public, anon;
grant execute on function public.start_cool_off(integer), public.my_limits() to authenticated;
