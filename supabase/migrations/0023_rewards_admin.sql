-- Vaultrush 0023: admin step E, part 1: promo codes, reward settings and announcements. Run after 0022. Running it again changes nothing.
--
--   * Reward settings: the faucet (25 coins every 10 minutes), the rakeback shares (0.4% / 0.3% / 0.3% of every stake), the 7-day login calendar
--     (1, 2, 3, 5, 8, 12, 25) and the daily race prizes (400 ... 10) move from the function code into one settings row. The functions read it;
--     the game site reads it too (reward_settings_public), so what the page promises is what the database pays.
--   * Promo codes: create, change and switch off codes; see uses and who used them.
--   * Announcements: banners and one-time pop-up messages for everyone on the game site, with a start and an end. They travel with the site
--     status the page already asks for every 30 seconds.
-- Every change needs a reason and is written to the audit log.

-- ============================ reward settings ===================================================================================
create table if not exists public.reward_settings (
  id             integer primary key default 1 check (id = 1),
  faucet_amount  numeric(10, 2) not null default 25 check (faucet_amount between 0.01 and 10000),
  faucet_minutes integer not null default 10 check (faucet_minutes between 1 and 1440),
  rb_instant     numeric(6, 5) not null default 0.004 check (rb_instant between 0 and 0.05),
  rb_daily       numeric(6, 5) not null default 0.003 check (rb_daily between 0 and 0.05),
  rb_weekly      numeric(6, 5) not null default 0.003 check (rb_weekly between 0 and 0.05),
  calendar       numeric[] not null default '{1,2,3,5,8,12,25}' check (cardinality(calendar) = 7),
  race_prizes    numeric[] not null default '{400,200,120,80,60,50,35,25,20,10}' check (cardinality(race_prizes) between 1 and 50),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
insert into public.reward_settings (id) values (1) on conflict (id) do nothing;
alter table public.reward_settings enable row level security;               -- no policy: read through the functions below
revoke all on public.reward_settings from anon, authenticated;

create or replace function public.rs() returns public.reward_settings language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.reward_settings where id = 1
$$;

-- What the page shows (the faucet button, the Rewards page, the race board). Anyone may read it.
create or replace function public.reward_settings_public() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('faucet_amount', faucet_amount, 'faucet_minutes', faucet_minutes, 'rakeback', jsonb_build_object('instant', rb_instant, 'daily', rb_daily, 'weekly', rb_weekly),
                            'calendar', to_jsonb(calendar), 'race_prizes', to_jsonb(race_prizes)) from public.reward_settings where id = 1
$$;

-- The reward functions of 0008 and 0012, reading the settings instead of fixed numbers (otherwise unchanged).
create or replace function public.rewards_accrue(p_uid uuid, p_amount numeric) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.reward_settings := public.rs();
begin
  insert into public.player_rewards (user_id, rb_instant, rb_daily, rb_weekly) values (p_uid, p_amount * s.rb_instant, p_amount * s.rb_daily, p_amount * s.rb_weekly)
  on conflict (user_id) do update set rb_instant = public.player_rewards.rb_instant + excluded.rb_instant, rb_daily = public.player_rewards.rb_daily + excluded.rb_daily,
                                      rb_weekly = public.player_rewards.rb_weekly + excluded.rb_weekly;
end $$;

create or replace function public.claim_faucet() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); pr public.player_rewards; bal numeric; s public.reward_settings := public.rs(); gap interval := make_interval(mins => s.faucet_minutes);
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if pr.faucet_at is not null and pr.faucet_at > now() - gap then
    return jsonb_build_object('claimed', false, 'next_at', (extract(epoch from pr.faucet_at + gap) * 1000)::bigint, 'balance', (select balance from public.wallets where user_id = uid));
  end if;
  update public.player_rewards set faucet_at = now() where user_id = uid;
  bal := public.wallet_credit(uid, s.faucet_amount, 'faucet');
  return jsonb_build_object('claimed', true, 'amount', s.faucet_amount, 'balance', bal, 'next_at', (extract(epoch from now() + gap) * 1000)::bigint);
end $$;

create or replace function public.claim_calendar() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); pr public.player_rewards; today date := (now() at time zone 'utc')::date; cur integer; i integer; amt numeric; bal numeric;
  pay numeric[] := (public.rs()).calendar;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  if pr.calendar_last = today then raise exception 'already_claimed'; end if;
  cur := case when pr.calendar_last = today - 1 then pr.calendar_streak else 0 end;
  i := cur % 7;
  amt := pay[i + 1];
  update public.player_rewards set calendar_streak = i + 1, calendar_last = today where user_id = uid;
  if amt > 0 then bal := public.wallet_credit(uid, amt, 'calendar'); else bal := (select balance from public.wallets where user_id = uid); end if;
  return jsonb_build_object('day', i + 1, 'amount', amt, 'balance', bal);
end $$;

create or replace function public.claim_race_prize() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); y date := (now() at time zone 'utc')::date - 1; pr public.player_rewards; rnk integer; prize numeric; bal numeric; wag numeric;
  prizes numeric[] := (public.rs()).race_prizes;
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
  if rnk is null or rnk > cardinality(prizes) then return jsonb_build_object('paid', false, 'rank', rnk); end if;
  prize := prizes[rnk];
  if prize is null or prize <= 0 then return jsonb_build_object('paid', false, 'rank', rnk); end if;
  bal := public.wallet_credit(uid, prize, 'race');
  return jsonb_build_object('paid', true, 'rank', rnk, 'prize', prize, 'balance', bal, 'wagered', wag);
end $$;

create or replace function public.admin_reward_settings() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  return public.reward_settings_public() || jsonb_build_object('updated_at', (public.rs()).updated_at,
    'updated_by', (select display_name from public.profiles where id = (public.rs()).updated_by));
end $$;

create or replace function public.admin_reward_settings_save(p_faucet_amount numeric, p_faucet_minutes integer, p_rb_instant numeric, p_rb_daily numeric, p_rb_weekly numeric,
                                                             p_calendar numeric[], p_race_prizes numeric[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.edit'); why text := public.admin_need_reason(p_reason); before jsonb := public.reward_settings_public();
begin
  if p_faucet_amount is null or p_faucet_amount < 0.01 or p_faucet_amount > 10000 or p_faucet_amount <> round(p_faucet_amount, 2) then raise exception 'invalid_value'; end if;
  if p_faucet_minutes is null or p_faucet_minutes < 1 or p_faucet_minutes > 1440 then raise exception 'invalid_value'; end if;
  if p_rb_instant is null or p_rb_daily is null or p_rb_weekly is null or least(p_rb_instant, p_rb_daily, p_rb_weekly) < 0 or greatest(p_rb_instant, p_rb_daily, p_rb_weekly) > 0.05 then raise exception 'invalid_value'; end if;
  if p_rb_instant + p_rb_daily + p_rb_weekly > 0.05 then raise exception 'rakeback_too_high'; end if;
  if p_calendar is null or cardinality(p_calendar) <> 7 or exists (select 1 from unnest(p_calendar) v where v is null or v < 0 or v > 100000 or v <> round(v, 2)) then raise exception 'invalid_value'; end if;
  if p_race_prizes is null or cardinality(p_race_prizes) < 1 or cardinality(p_race_prizes) > 50
     or exists (select 1 from unnest(p_race_prizes) v where v is null or v < 0 or v > 1000000 or v <> round(v, 2)) then raise exception 'invalid_value'; end if;
  update public.reward_settings set faucet_amount = p_faucet_amount, faucet_minutes = p_faucet_minutes, rb_instant = p_rb_instant, rb_daily = p_rb_daily, rb_weekly = p_rb_weekly,
         calendar = p_calendar, race_prizes = p_race_prizes, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('rewards.settings', null, null, before, public.reward_settings_public(), why);
  return public.admin_reward_settings();
end $$;

-- What the free rewards cost: coins handed out by kind, today and over 7 days, and the free crates claimed.
create or replace function public.admin_reward_stats() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view'); t0 timestamptz := public.rg_day_start(0); t7 timestamptz := public.rg_day_start(6);
begin
  return jsonb_build_object(
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', k, 'today_count', tc, 'today_sum', ts, 'week_count', wc, 'week_sum', ws) order by k)
                       from (select kind as k, count(*) filter (where created_at >= t0) as tc, coalesce(sum(amount) filter (where created_at >= t0), 0) as ts,
                                    count(*) as wc, coalesce(sum(amount), 0) as ws
                               from public.ledger where created_at >= t7 and kind in ('faucet', 'rakeback', 'calendar', 'promo', 'race') group by kind) g), '[]'::jsonb),
    'crates', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'week', n) order by kind) from (select kind, count(*) as n from public.free_claims where claimed_at >= t7 group by kind) c), '[]'::jsonb));
end $$;

-- ============================ promo codes =======================================================================================
alter table public.promo_codes add column if not exists note text check (note is null or char_length(note) <= 200);
alter table public.promo_codes add column if not exists created_at timestamptz not null default now();
alter table public.promo_codes add column if not exists created_by uuid;

create or replace function public.admin_promos() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('code', p.code, 'amount', p.amount, 'max_uses', p.max_uses, 'uses', p.uses, 'active', p.active, 'expires_at', p.expires_at, 'note', p.note,
            'created_at', p.created_at, 'by', (select display_name from public.profiles x where x.id = p.created_by),
            'live', p.active and (p.expires_at is null or p.expires_at > now()) and (p.max_uses is null or p.uses < p.max_uses)) order by p.created_at desc, p.code)
          from public.promo_codes p), '[]'::jsonb);
end $$;

-- Who used a code (each player can use a code once; the list is kept per player).
create or replace function public.admin_promo_users(p_code text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name)
          from public.player_rewards r join public.profiles p on p.id = r.user_id where upper(p_code) = any (r.promos)), '[]'::jsonb);
end $$;

-- Create a code, or change one (amount, limit, expiry, on/off, note). The code itself never changes once created.
create or replace function public.admin_promo_save(p_code text, p_amount numeric, p_max_uses integer, p_expires_at timestamptz, p_active boolean, p_note text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('promos.manage'); why text := public.admin_need_reason(p_reason); c text := upper(trim(coalesce(p_code, ''))); old public.promo_codes;
begin
  if c !~ '^[A-Z0-9_-]{3,20}$' then raise exception 'invalid_code_format'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_value'; end if;
  if p_max_uses is not null and (p_max_uses < 1 or p_max_uses > 1000000) then raise exception 'invalid_value'; end if;
  if p_note is not null and char_length(p_note) > 200 then raise exception 'text_too_long'; end if;
  select * into old from public.promo_codes where code = c for update;
  if old.code is null then
    insert into public.promo_codes (code, amount, max_uses, active, expires_at, note, created_by) values (c, p_amount, p_max_uses, coalesce(p_active, true), p_expires_at, nullif(trim(p_note), ''), uid);
  else
    update public.promo_codes set amount = p_amount, max_uses = p_max_uses, active = coalesce(p_active, active), expires_at = p_expires_at, note = nullif(trim(p_note), '') where code = c;
  end if;
  perform public.admin_log(case when old.code is null then 'promo.create' else 'promo.edit' end, 'promo', c,
                           case when old.code is null then null else jsonb_build_object('amount', old.amount, 'max_uses', old.max_uses, 'active', old.active, 'expires_at', old.expires_at) end,
                           jsonb_build_object('amount', p_amount, 'max_uses', p_max_uses, 'active', coalesce(p_active, old.active, true), 'expires_at', p_expires_at), why);
  return (select to_jsonb(p) from public.promo_codes p where p.code = c);
end $$;

-- ============================ announcements =====================================================================================
create table if not exists public.announcements (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('banner', 'popup')),
  style      text not null default 'info' check (style in ('info', 'warn', 'win')),
  body       text not null check (char_length(body) between 1 and 300),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  ended_at   timestamptz,
  ended_by   uuid,
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists announcements_live on public.announcements (starts_at) where ended_at is null;
alter table public.announcements enable row level security;                 -- no policy: read through the functions below
revoke all on public.announcements from anon, authenticated;

create or replace function public.announcements_now() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'style', style, 'body', body) order by id), '[]'::jsonb)
  from public.announcements where ended_at is null and starts_at <= now() and (ends_at is null or ends_at > now())
$$;

-- The site status of 0007, now with the announcements that are showing.
create or replace function public.site_status() returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.site_controls; uid uuid := auth.uid(); ctry text := public.request_country();
begin
  select * into c from public.site_controls where id = 1;
  return jsonb_build_object(
    'maintenance', c.maintenance_on, 'maintenance_message', c.maintenance_message,
    'notice', case when c.notice_on then jsonb_build_object('text', c.notice_text, 'kind', c.notice_kind) end,
    'signups_open', c.signups_open, 'games_off', to_jsonb(c.games_off),
    'country', ctry, 'country_blocked', ctry is not null and ctry = any (c.blocked_countries),
    'staff', uid is not null and public.admin_role_of(uid) is not null,
    'announcements', public.announcements_now());
end $$;

create or replace function public.admin_announcements() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('announcements.manage');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'style', a.style, 'body', a.body, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'ended_at', a.ended_at,
            'by', (select display_name from public.profiles x where x.id = a.created_by),
            'state', case when a.ended_at is not null or (a.ends_at is not null and a.ends_at <= now()) then 'ended' when a.starts_at > now() then 'scheduled' else 'showing' end) order by a.id desc)
          from (select * from public.announcements order by id desc limit 100) a), '[]'::jsonb);
end $$;

create or replace function public.admin_announce(p_kind text, p_style text, p_body text, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('announcements.manage'); why text := public.admin_need_reason(p_reason); b text := trim(coalesce(p_body, '')); st timestamptz := coalesce(p_starts_at, now()); aid bigint;
begin
  if p_kind is null or p_kind not in ('banner', 'popup') or coalesce(p_style, 'info') not in ('info', 'warn', 'win') then raise exception 'invalid_value'; end if;
  if b = '' then raise exception 'text_required'; end if;
  if char_length(b) > 300 then raise exception 'text_too_long'; end if;
  if p_ends_at is not null and (p_ends_at <= st or p_ends_at <= now()) then raise exception 'invalid_dates'; end if;
  if st > now() + interval '90 days' then raise exception 'invalid_dates'; end if;
  insert into public.announcements (kind, style, body, starts_at, ends_at, created_by) values (p_kind, coalesce(p_style, 'info'), b, st, p_ends_at, uid) returning id into aid;
  perform public.admin_log('announcement.create', 'announcement', aid::text, null, jsonb_build_object('kind', p_kind, 'body', b, 'starts_at', st, 'ends_at', p_ends_at), why);
  return jsonb_build_object('id', aid);
end $$;

create or replace function public.admin_announce_end(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('announcements.manage'); why text := public.admin_need_reason(p_reason); a public.announcements;
begin
  select * into a from public.announcements where id = p_id for update;
  if a.id is null then raise exception 'invalid_value'; end if;
  if a.ended_at is null then
    update public.announcements set ended_at = now(), ended_by = uid where id = p_id;
    perform public.admin_log('announcement.end', 'announcement', p_id::text, jsonb_build_object('body', a.body), null, why);
  end if;
  return jsonb_build_object('id', p_id, 'ended', true);
end $$;

-- ============================ privileges ========================================================================================
revoke execute on function public.rs(), public.announcements_now() from public, anon, authenticated;
revoke execute on function public.reward_settings_public(), public.admin_reward_settings(), public.admin_reward_settings_save(numeric, integer, numeric, numeric, numeric, numeric[], numeric[], text),
  public.admin_reward_stats(), public.admin_promos(), public.admin_promo_users(text), public.admin_promo_save(text, numeric, integer, timestamptz, boolean, text, text),
  public.admin_announcements(), public.admin_announce(text, text, text, timestamptz, timestamptz, text), public.admin_announce_end(bigint, text) from public, anon;
grant execute on function public.reward_settings_public() to anon, authenticated;
grant execute on function public.admin_reward_settings(), public.admin_reward_settings_save(numeric, integer, numeric, numeric, numeric, numeric[], numeric[], text),
  public.admin_reward_stats(), public.admin_promos(), public.admin_promo_users(text), public.admin_promo_save(text, numeric, integer, timestamptz, boolean, text, text),
  public.admin_announcements(), public.admin_announce(text, text, text, timestamptz, timestamptz, text), public.admin_announce_end(bigint, text) to authenticated;
