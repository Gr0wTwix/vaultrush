-- Vaultrush 0025: admin step E, part 3: game settings and house bots. Run after 0024. Running it again changes nothing.
--
--   * Per game: the smallest and the largest stake one action may have (a bet, an upgrade, a case opening, joining a battle), checked by the
--     database on every stake, on top of the player's own limits and the verification caps. The defaults change nothing (0.01 to 50,000).
--   * Crash and Double: how long each round takes bets (7 and 12 seconds at the start). The game page reads the same setting.
--   * Lobbies: how long a waiting battle or coinflip stays open before it is cancelled and refunded (30 minutes), and how many each player may
--     have open at once (3 battles, 5 coinflips).
--   * House bots: on or off for battles and for coinflip, and their names (the database accepts only these names).
--   * Simulated activity: the made-up "live drops" and bet feed shown to make the site feel busy; can be switched off for everyone.
-- Not a setting on purpose: the house edge and the payout tables. They are part of what the fairness pages prove; changing them is a code change.

-- ============================ settings ===========================================================================================
create table if not exists public.game_limits (
  game    text primary key,
  min_bet numeric(12, 2) not null default 0.01 check (min_bet >= 0.01),
  max_bet numeric(12, 2) not null default 50000 check (max_bet <= 50000),
  check (max_bet >= min_bet)
);
insert into public.game_limits (game) select g from unnest(public.site_games()) g on conflict (game) do nothing;

create table if not exists public.game_settings (
  id                 integer primary key default 1 check (id = 1),
  crash_bet_seconds  integer not null default 7 check (crash_bet_seconds between 5 and 20),
  double_bet_seconds integer not null default 12 check (double_bet_seconds between 8 and 30),
  lobby_minutes      integer not null default 30 check (lobby_minutes between 5 and 120),
  battle_lobbies_max integer not null default 3 check (battle_lobbies_max between 1 and 10),
  flip_lobbies_max   integer not null default 5 check (flip_lobbies_max between 1 and 20),
  bots_battles       boolean not null default true,
  bots_coinflip      boolean not null default true,
  simulated_activity boolean not null default true,
  bot_names          text[] not null default array['frostbyte', 'kappa_kid', 'm0nkey', 'Zeroday', 'lucky_lou', 'N1ghtowl', 'spray&pray', 'Vexx', 'tilted', 'rngesus',
                                                   'Bricktop', 'ozzy', 'Kaiju', 'pixelpete', 'Sable', 'noScope', 'jynx', 'Halcyon', 'grizz', 'Mirage']
                     check (cardinality(bot_names) between 3 and 100),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
insert into public.game_settings (id) values (1) on conflict (id) do nothing;
alter table public.game_limits enable row level security;
alter table public.game_settings enable row level security;
revoke all on public.game_limits, public.game_settings from anon, authenticated;

create or replace function public.gs() returns public.game_settings language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.game_settings where id = 1
$$;

-- What the game page needs. Anyone may read it.
create or replace function public.game_settings_public() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('crash_bet_seconds', s.crash_bet_seconds, 'double_bet_seconds', s.double_bet_seconds, 'lobby_minutes', s.lobby_minutes,
    'battle_lobbies_max', s.battle_lobbies_max, 'flip_lobbies_max', s.flip_lobbies_max, 'bots_battles', s.bots_battles, 'bots_coinflip', s.bots_coinflip,
    'simulated_activity', s.simulated_activity, 'bot_names', to_jsonb(s.bot_names),
    'limits', (select jsonb_object_agg(game, jsonb_build_object('min', min_bet, 'max', max_bet)) from public.game_limits))
  from public.game_settings s where s.id = 1
$$;

-- ============================ the stake limits per game ============================================================================
-- site_guard (0021) also remembers, for this request only, which game is being played; wallet_gate (0018) then applies that game's limits.
-- site_guard becomes volatile because it now sets that request-local value.
create or replace function public.site_guard(p_game text default null) returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c public.site_controls; uid uuid := auth.uid(); ctry text;
begin
  perform set_config('vaultrush.game', coalesce(p_game, ''), true);
  if uid is not null and public.admin_role_of(uid) is not null then return; end if;           -- staff are never locked out
  if uid is not null then
    if public.flag_active(uid, 'site_ban') then raise exception 'account_banned'; end if;
    if p_game is not null and public.flag_active(uid, 'bet_ban') then raise exception 'betting_banned'; end if;
  end if;
  select * into c from public.site_controls where id = 1;
  if c.maintenance_on then raise exception 'maintenance'; end if;
  ctry := public.request_country();
  if ctry is not null and ctry = any (c.blocked_countries) then raise exception 'country_blocked'; end if;
  if p_game is not null and p_game = any (c.games_off) then raise exception 'game_off'; end if;
end $$;

create or replace function public.wallet_gate(p_uid uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare prof public.profiles; ctl public.account_controls; tier_cap numeric; g text := nullif(current_setting('vaultrush.game', true), ''); lim public.game_limits;
begin
  perform public.apply_due_limits(p_uid);
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if g is not null then
    select * into lim from public.game_limits where game = g;
    if lim.game is not null and p_amount < lim.min_bet then raise exception 'bet_below_min'; end if;
    if lim.game is not null and p_amount > lim.max_bet then raise exception 'bet_above_max'; end if;
  end if;
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

-- ============================ round timings and lobby expiry ======================================================================
create or replace function public.round_bet_ms(p_game text) returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case p_game when 'crash' then s.crash_bet_seconds * 1000 else s.double_bet_seconds * 1000 end from public.game_settings s where s.id = 1
$$;

create or replace function public.live_reap() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_battles; f public.live_coinflips; u uuid; cost numeric; mins interval := make_interval(mins => (public.gs()).lobby_minutes);
begin
  for r in select * from public.live_battles where status = 'waiting' and created_at < now() - mins for update skip locked loop
    update public.live_battles set status = 'cancelled' where id = r.id;
    cost := public.battle_cost(r.case_ids);
    foreach u in array r.player_ids loop perform public.wallet_credit(u, cost, 'refund'); end loop;
  end loop;
  for f in select * from public.live_coinflips where status = 'waiting' and created_at < now() - mins for update skip locked loop
    update public.live_coinflips set status = 'cancelled', finished_at = now() where id = f.id;
    perform public.wallet_credit(f.creator, f.amount, 'refund');
  end loop;
end $$;

-- ============================ lobby caps and bots: small changes to the live-game functions of 0011 ============================
-- Done by editing the stored function text (as 0007 and 0017 do), so the earlier migrations stay as they are. Each change must find its anchor
-- exactly once, and is skipped when it is already there (running this file again).
-- A file pasted from Windows stores its functions with CR LF line breaks, so the stored text is read with the CRs taken out (they mean nothing
-- in SQL) before looking for the anchor. Without this the anchors that span a line break are not found.
create or replace function pg_temp.patch_fn(p_fn text, p_old text, p_new text) returns void language plpgsql as $$
declare fid oid; def text; n integer;
begin
  select p.oid into fid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if fid is null then raise exception 'patch_fn: % not found', p_fn; end if;
  def := replace(pg_get_functiondef(fid), E'\r', '');
  if position(p_new in def) > 0 then return; end if;
  n := (char_length(def) - char_length(replace(def, p_old, ''))) / char_length(p_old);
  if n <> 1 then raise exception 'patch_fn: anchor found % times in %', n, p_fn; end if;
  execute replace(def, p_old, p_new);
end $$;

select pg_temp.patch_fn('create_live_battle', 'and status = ''waiting'') >= 3 then', 'and status = ''waiting'') >= (public.gs()).battle_lobbies_max then');
select pg_temp.patch_fn('create_live_coinflip', 'and status = ''waiting'') >= 5 then', 'and status = ''waiting'') >= (public.gs()).flip_lobbies_max then');
select pg_temp.patch_fn('call_live_bot', E'\nbegin\n', E'\nbegin\n  if not (public.gs()).bots_battles then raise exception ''bots_off''; end if;\n  if not (p_name = any ((public.gs()).bot_names)) then raise exception ''invalid_name''; end if;\n');
select pg_temp.patch_fn('call_live_coinflip_bot', E'\nbegin\n', E'\nbegin\n  if not (public.gs()).bots_coinflip then raise exception ''bots_off''; end if;\n  if not (p_name = any ((public.gs()).bot_names)) then raise exception ''invalid_name''; end if;\n');

-- ============================ the admin side ======================================================================================
create or replace function public.admin_game_settings() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('config.view');
begin
  return public.game_settings_public() || jsonb_build_object('updated_at', (public.gs()).updated_at, 'updated_by', (select display_name from public.profiles where id = (public.gs()).updated_by),
    'games', to_jsonb(public.site_games()));
end $$;

-- p_limits: {"<game>": {"min": n, "max": n}, ...} for any of the games (the others keep theirs).
create or replace function public.admin_game_settings_save(p_crash integer, p_double integer, p_lobby integer, p_battles_max integer, p_flips_max integer, p_bots_battles boolean,
                                                           p_bots_coinflip boolean, p_simulated boolean, p_bot_names text[], p_limits jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('config.edit'); why text := public.admin_need_reason(p_reason); before jsonb := public.game_settings_public(); k text; v jsonb; mn numeric; mx numeric; names text[];
begin
  if p_crash is null or p_crash < 5 or p_crash > 20 or p_double is null or p_double < 8 or p_double > 30 then raise exception 'invalid_value'; end if;
  if p_lobby is null or p_lobby < 5 or p_lobby > 120 or p_battles_max is null or p_battles_max < 1 or p_battles_max > 10 or p_flips_max is null or p_flips_max < 1 or p_flips_max > 20 then raise exception 'invalid_value'; end if;
  if p_bots_battles is null or p_bots_coinflip is null or p_simulated is null then raise exception 'invalid_value'; end if;
  select coalesce(array_agg(distinct n order by n), '{}') into names from (select trim(x) as n from unnest(coalesce(p_bot_names, '{}')) x) t where n <> '';
  if cardinality(names) < 3 or cardinality(names) > 100 or exists (select 1 from unnest(names) n where n !~ '^[A-Za-z0-9_&-]{2,20}$') then raise exception 'invalid_bot_names'; end if;
  -- a NEW bot name may not be a real player's name (a bot must never pass for a player); names already on the list stay allowed
  if exists (select 1 from unnest(names) n join public.profiles p on lower(p.display_name) = lower(n)
              where p.deleted_at is null and not (lower(n) = any (select lower(x) from unnest((public.gs()).bot_names) x))) then raise exception 'bot_name_taken'; end if;
  for k, v in select * from jsonb_each(coalesce(p_limits, '{}'::jsonb)) loop
    if not (k = any (public.site_games())) then raise exception 'unknown_game'; end if;
    mn := (v ->> 'min')::numeric; mx := (v ->> 'max')::numeric;
    if mn is null or mx is null or mn < 0.01 or mx > 50000 or mx < mn or mn <> round(mn, 2) or mx <> round(mx, 2) then raise exception 'invalid_value'; end if;
  end loop;
  update public.game_settings set crash_bet_seconds = p_crash, double_bet_seconds = p_double, lobby_minutes = p_lobby, battle_lobbies_max = p_battles_max, flip_lobbies_max = p_flips_max,
         bots_battles = p_bots_battles, bots_coinflip = p_bots_coinflip, simulated_activity = p_simulated, bot_names = names, updated_at = now(), updated_by = uid where id = 1;
  for k, v in select * from jsonb_each(coalesce(p_limits, '{}'::jsonb)) loop
    update public.game_limits set min_bet = (v ->> 'min')::numeric, max_bet = (v ->> 'max')::numeric where game = k;
  end loop;
  perform public.admin_log('config.games', null, null, before, public.game_settings_public(), why);
  return public.admin_game_settings();
end $$;

-- ============================ privileges ==========================================================================================
revoke execute on function public.gs(), public.round_bet_ms(text) from public, anon, authenticated;
revoke execute on function public.game_settings_public(), public.admin_game_settings(),
  public.admin_game_settings_save(integer, integer, integer, integer, integer, boolean, boolean, boolean, text[], jsonb, text) from public, anon;
grant execute on function public.game_settings_public() to anon, authenticated;
grant execute on function public.admin_game_settings(), public.admin_game_settings_save(integer, integer, integer, integer, integer, boolean, boolean, boolean, text[], jsonb, text) to authenticated;
