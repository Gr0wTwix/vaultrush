-- Vaultrush 0024: admin step E, part 2: races, coin rain and giveaways. Run after 0023. Running it again changes nothing.
--
--   * Races: besides the daily race, staff can run races of their own: a name, a start and an end, a prize table, and which games count (all by
--     default). The standings come from the bets the database records. When a race has ended, staff pay the prizes with one button; every payout
--     is recorded. A race can be cancelled until it is paid.
--   * Coin rain: staff start a rain (a pot, how long players can join, an optional minimum level). Signed-in players join from the chat; when the
--     time is up the pot is split equally between everyone who joined and paid at once. A rain is announced in the chat by the staff member.
--   * Giveaways: a prize in coins for 1 to 100 winners, with an entry window and an optional minimum level. When a giveaway is created a secret
--     seed is drawn and only its SHA-256 hash is published; after the draw the seed is revealed. Each entry has a number (in order of entry); an
--     entry's score is the SHA-256 of "<seed>:<entry number>", and the lowest scores win. Anyone can check the draw with the seed and the list.
-- Every staff action needs a reason and is written to the audit log. Coins handed out appear in the ledger as 'race', 'rain' or 'giveaway'.

-- ============================ ledger kinds and level ============================================================================
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check check (kind in
  ('bonus', 'bet', 'win', 'adjustment', 'sell', 'refund', 'faucet', 'rakeback', 'calendar', 'promo', 'race', 'crate', 'rain', 'giveaway'));

-- The level the page shows: floor(sqrt(xp / 10)) with xp = 10 per coin wagered.
create or replace function public.player_level(p_uid uuid) returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(floor(sqrt(round(w.wagered * 10) / 10))::integer, 0) from public.wallets w where w.user_id = p_uid
$$;

-- ============================ races ============================================================================================
create table if not exists public.races (
  id            bigint generated always as identity primary key,
  name          text not null check (char_length(name) between 2 and 40),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  prizes        numeric[] not null check (cardinality(prizes) between 1 and 50),
  games         text[] not null default '{}',               -- empty: every game counts
  created_by    uuid,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  paid_by       uuid,
  cancelled_at  timestamptz,
  check (ends_at > starts_at and ends_at <= starts_at + interval '31 days')
);
create table if not exists public.race_payouts (
  race_id  bigint not null references public.races (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  rank     integer not null,
  wagered  numeric(16, 2) not null,
  prize    numeric(12, 2) not null,
  primary key (race_id, user_id)
);
alter table public.races enable row level security;
alter table public.race_payouts enable row level security;
revoke all on public.races, public.race_payouts from anon, authenticated;

-- The standings of a race: wagered coins per player in its window, for its games, the biggest first (ties by player id, so the order never changes).
create or replace function public.race_board(p_race bigint, p_limit integer default 50) returns table (user_id uuid, wagered numeric, rank integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.user_id, sum(b.amount), (row_number() over (order by sum(b.amount) desc, b.user_id))::integer
    from public.bets b join public.races r on r.id = p_race
   where b.amount > 0 and b.created_at >= r.starts_at and b.created_at < r.ends_at and (cardinality(r.games) = 0 or b.game = any (r.games))
   group by b.user_id order by sum(b.amount) desc, b.user_id limit greatest(coalesce(p_limit, 50), 1)
$$;
create or replace function public.race_state(r public.races) returns text language sql stable as $$
  select case when r.cancelled_at is not null then 'cancelled' when r.paid_at is not null then 'paid' when now() < r.starts_at then 'upcoming' when now() < r.ends_at then 'running' else 'ended' end
$$;
create or replace function public.race_json(r public.races, p_me uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'starts_at', r.starts_at, 'ends_at', r.ends_at, 'prizes', to_jsonb(r.prizes), 'games', to_jsonb(r.games), 'state', public.race_state(r),
    'pool', (select coalesce(sum(x), 0) from unnest(r.prizes) x),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', b.rank, 'name', p.display_name, 'wagered', b.wagered, 'prize', coalesce(r.prizes[b.rank], 0)) order by b.rank)
                     from public.race_board(r.id, greatest(cardinality(r.prizes), 10)) b join public.profiles p on p.id = b.user_id), '[]'::jsonb),
    'me', case when p_me is null then null else (select jsonb_build_object('rank', b.rank, 'wagered', b.wagered) from public.race_board(r.id, 100000) b where b.user_id = p_me) end)
$$;

-- Races the game site shows: running and upcoming ones, and those that ended in the last 7 days.
create or replace function public.races_public() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.race_json(r, auth.uid()) order by r.ends_at), '[]'::jsonb)
    from public.races r where r.cancelled_at is null and r.ends_at > now() - interval '7 days' and r.starts_at < now() + interval '7 days'
$$;

create or replace function public.admin_races() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  return coalesce((select jsonb_agg(public.race_json(r, null) || jsonb_build_object('paid_at', r.paid_at, 'by', (select display_name from public.profiles x where x.id = r.created_by),
            'payouts', (select coalesce(jsonb_agg(jsonb_build_object('rank', o.rank, 'name', p.display_name, 'prize', o.prize) order by o.rank), '[]'::jsonb) from public.race_payouts o join public.profiles p on p.id = o.user_id where o.race_id = r.id))
            order by r.starts_at desc) from (select * from public.races order by starts_at desc limit 100) r), '[]'::jsonb);
end $$;

-- Create (p_id null) or change a race that has not ended yet.
create or replace function public.admin_race_save(p_id bigint, p_name text, p_starts timestamptz, p_ends timestamptz, p_prizes numeric[], p_games text[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('races.manage'); why text := public.admin_need_reason(p_reason); r public.races; nm text := trim(coalesce(p_name, '')); g text[] := coalesce(p_games, '{}');
begin
  if char_length(nm) < 2 or char_length(nm) > 40 then raise exception 'invalid_value'; end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts or p_ends > p_starts + interval '31 days' or p_ends <= now() then raise exception 'invalid_dates'; end if;
  if p_prizes is null or cardinality(p_prizes) < 1 or cardinality(p_prizes) > 50 or exists (select 1 from unnest(p_prizes) v where v is null or v < 0 or v > 1000000 or v <> round(v, 2)) then raise exception 'invalid_value'; end if;
  if exists (select 1 from unnest(g) x where not (x = any (public.site_games()))) then raise exception 'unknown_game'; end if;
  if p_id is null then
    insert into public.races (name, starts_at, ends_at, prizes, games, created_by) values (nm, p_starts, p_ends, p_prizes, g, uid) returning * into r;
    perform public.admin_log('race.create', 'race', r.id::text, null, jsonb_build_object('name', nm, 'starts_at', p_starts, 'ends_at', p_ends, 'prizes', p_prizes, 'games', g), why);
  else
    select * into r from public.races where id = p_id for update;
    if r.id is null then raise exception 'race_not_found'; end if;
    if public.race_state(r) not in ('upcoming', 'running') then raise exception 'race_closed'; end if;
    update public.races set name = nm, starts_at = p_starts, ends_at = p_ends, prizes = p_prizes, games = g where id = p_id;
    perform public.admin_log('race.edit', 'race', p_id::text, jsonb_build_object('name', r.name, 'starts_at', r.starts_at, 'ends_at', r.ends_at, 'prizes', r.prizes, 'games', r.games),
                             jsonb_build_object('name', nm, 'starts_at', p_starts, 'ends_at', p_ends, 'prizes', p_prizes, 'games', g), why);
  end if;
  return public.race_json(r, null);
end $$;

-- Pay an ended race: each ranked player with a prize gets it once.
create or replace function public.admin_race_pay(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('races.manage'); why text := public.admin_need_reason(p_reason); r public.races; b record; n integer := 0; total numeric := 0;
begin
  select * into r from public.races where id = p_id for update;
  if r.id is null then raise exception 'race_not_found'; end if;
  if public.race_state(r) <> 'ended' then raise exception 'race_not_ended'; end if;
  for b in select * from public.race_board(p_id, cardinality(r.prizes)) loop
    if coalesce(r.prizes[b.rank], 0) > 0 then
      insert into public.race_payouts (race_id, user_id, rank, wagered, prize) values (p_id, b.user_id, b.rank, b.wagered, r.prizes[b.rank]);
      perform public.wallet_credit(b.user_id, r.prizes[b.rank], 'race');
      n := n + 1; total := total + r.prizes[b.rank];
    end if;
  end loop;
  update public.races set paid_at = now(), paid_by = uid where id = p_id;
  perform public.admin_log('race.pay', 'race', p_id::text, null, jsonb_build_object('winners', n, 'paid', total), why);
  return jsonb_build_object('winners', n, 'paid', total);
end $$;

create or replace function public.admin_race_cancel(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('races.manage'); why text := public.admin_need_reason(p_reason); r public.races;
begin
  select * into r from public.races where id = p_id for update;
  if r.id is null then raise exception 'race_not_found'; end if;
  if r.paid_at is not null then raise exception 'race_closed'; end if;
  if r.cancelled_at is null then
    update public.races set cancelled_at = now() where id = p_id;
    perform public.admin_log('race.cancel', 'race', p_id::text, null, null, why);
  end if;
  return jsonb_build_object('id', p_id, 'cancelled', true);
end $$;

-- ============================ coin rain ========================================================================================
create table if not exists public.rains (
  id           bigint generated always as identity primary key,
  pot          numeric(12, 2) not null check (pot between 1 and 100000),
  min_level    integer not null default 0 check (min_level between 0 and 100),
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  created_by   uuid,
  settled_at   timestamptz,
  joiners      integer not null default 0,
  share        numeric(12, 2),
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);
create table if not exists public.rain_joins (
  rain_id   bigint not null references public.rains (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (rain_id, user_id)
);
alter table public.rains enable row level security;
alter table public.rain_joins enable row level security;
revoke all on public.rains, public.rain_joins from anon, authenticated;
-- The page listens for new and finished rains (no amounts per player are in this table).
drop policy if exists rains_read on public.rains;
create policy rains_read on public.rains for select to authenticated using (true);
grant select on public.rains to authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rains') then
    alter publication supabase_realtime add table public.rains;
  end if;
end $$;

-- Pay every rain whose time is up: the pot split equally (rounded down to the cent) between everyone who joined.
create or replace function public.rain_settle() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rains; n integer; s numeric; u uuid;
begin
  for r in select * from public.rains where settled_at is null and cancelled_at is null and ends_at <= now() for update skip locked loop
    select count(*) into n from public.rain_joins where rain_id = r.id;
    s := case when n > 0 then floor(r.pot * 100 / n) / 100 else 0 end;
    if s > 0 then
      for u in select user_id from public.rain_joins where rain_id = r.id loop perform public.wallet_credit(u, s, 'rain'); end loop;
    end if;
    update public.rains set settled_at = now(), joiners = n, share = s where id = r.id;
  end loop;
end $$;

-- What the chat shows: the rain that is open now (if any) and the last one that paid out in the last 5 minutes, with this player's part.
create or replace function public.rain_now() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur public.rains; last public.rains;
begin
  perform public.rain_settle();
  select * into cur from public.rains where cancelled_at is null and settled_at is null and starts_at <= now() and ends_at > now() order by id desc limit 1;
  select * into last from public.rains where settled_at is not null and settled_at > now() - interval '5 minutes' order by id desc limit 1;
  return jsonb_build_object(
    'open', case when cur.id is null then null else jsonb_build_object('id', cur.id, 'pot', cur.pot, 'ends_at', cur.ends_at, 'min_level', cur.min_level,
      'joiners', (select count(*) from public.rain_joins where rain_id = cur.id), 'joined', exists (select 1 from public.rain_joins where rain_id = cur.id and user_id = uid)) end,
    'last', case when last.id is null then null else jsonb_build_object('id', last.id, 'pot', last.pot, 'joiners', last.joiners, 'share', last.share,
      'mine', exists (select 1 from public.rain_joins where rain_id = last.id and user_id = uid)) end,
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

create or replace function public.join_rain(p_id bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.rains;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  select * into r from public.rains where id = p_id;
  if r.id is null or r.cancelled_at is not null or r.settled_at is not null or now() < r.starts_at or now() >= r.ends_at then raise exception 'rain_closed'; end if;
  if public.player_level(uid) < r.min_level then raise exception 'level_too_low'; end if;
  insert into public.rain_joins (rain_id, user_id) values (p_id, uid) on conflict do nothing;
  return jsonb_build_object('joined', true, 'joiners', (select count(*) from public.rain_joins where rain_id = p_id));
end $$;

create or replace function public.admin_rains() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  perform public.rain_settle();
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'pot', r.pot, 'min_level', r.min_level, 'starts_at', r.starts_at, 'ends_at', r.ends_at, 'settled_at', r.settled_at,
            'cancelled_at', r.cancelled_at, 'share', r.share, 'joiners', case when r.settled_at is null then (select count(*) from public.rain_joins j where j.rain_id = r.id) else r.joiners end,
            'by', (select display_name from public.profiles x where x.id = r.created_by)) order by r.id desc) from (select * from public.rains order by id desc limit 50) r), '[]'::jsonb);
end $$;

-- Start a rain now: players can join for p_seconds (30 to 600). Only one rain at a time. It is announced in the chat by the staff member.
create or replace function public.admin_rain_start(p_pot numeric, p_seconds integer, p_min_level integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rain.manage'); why text := public.admin_need_reason(p_reason); rid bigint; secs integer := coalesce(p_seconds, 60);
begin
  if p_pot is null or p_pot < 1 or p_pot > 100000 or p_pot <> round(p_pot, 2) then raise exception 'invalid_value'; end if;
  if secs < 30 or secs > 600 or coalesce(p_min_level, 0) < 0 or coalesce(p_min_level, 0) > 100 then raise exception 'invalid_value'; end if;
  perform public.rain_settle();
  if exists (select 1 from public.rains where cancelled_at is null and settled_at is null and ends_at > now()) then raise exception 'rain_active'; end if;
  insert into public.rains (pot, min_level, ends_at, created_by) values (p_pot, coalesce(p_min_level, 0), now() + make_interval(secs => secs), uid) returning id into rid;
  begin
    insert into public.chat_messages (user_id, body, is_staff) values (uid, left(format('Coin rain: %s coins! Join from the chat in the next %s seconds%s.', p_pot, secs,
      case when coalesce(p_min_level, 0) > 0 then format(' (level %s and up)', p_min_level) else '' end), 140), true);
  exception when others then null;                                                  -- the chat line is a courtesy; the rain runs anyway
  end;
  perform public.admin_log('rain.start', 'rain', rid::text, null, jsonb_build_object('pot', p_pot, 'seconds', secs, 'min_level', coalesce(p_min_level, 0)), why);
  return jsonb_build_object('id', rid);
end $$;

create or replace function public.admin_rain_cancel(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rain.manage'); why text := public.admin_need_reason(p_reason); r public.rains;
begin
  select * into r from public.rains where id = p_id for update;
  if r.id is null then raise exception 'invalid_value'; end if;
  if r.settled_at is not null or r.ends_at <= now() then raise exception 'rain_closed'; end if;
  if r.cancelled_at is null then
    update public.rains set cancelled_at = now() where id = p_id;
    perform public.admin_log('rain.cancel', 'rain', p_id::text, null, null, why);
  end if;
  return jsonb_build_object('id', p_id, 'cancelled', true);
end $$;

-- ============================ giveaways ========================================================================================
create table if not exists public.giveaways (
  id           bigint generated always as identity primary key,
  title        text not null check (char_length(title) between 2 and 60),
  prize        numeric(12, 2) not null check (prize > 0 and prize <= 1000000),
  winners      integer not null check (winners between 1 and 100),
  min_level    integer not null default 0 check (min_level between 0 and 100),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  server_hash  text not null,                                   -- SHA-256 of the secret seed, public from the start
  created_by   uuid,
  created_at   timestamptz not null default now(),
  drawn_at     timestamptz,
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);
create table if not exists public.giveaway_secrets (giveaway_id bigint primary key references public.giveaways (id) on delete cascade, seed text not null);
create table if not exists public.giveaway_entries (
  giveaway_id bigint not null references public.giveaways (id) on delete cascade,
  entry_no    integer not null,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  entered_at  timestamptz not null default now(),
  primary key (giveaway_id, user_id),
  unique (giveaway_id, entry_no)
);
create table if not exists public.giveaway_winners (
  giveaway_id bigint not null references public.giveaways (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  entry_no    integer not null,
  place       integer not null,
  prize       numeric(12, 2) not null,
  primary key (giveaway_id, user_id)
);
alter table public.giveaways enable row level security;
alter table public.giveaway_secrets enable row level security;
alter table public.giveaway_entries enable row level security;
alter table public.giveaway_winners enable row level security;
revoke all on public.giveaways, public.giveaway_secrets, public.giveaway_entries, public.giveaway_winners from anon, authenticated;

create or replace function public.giveaway_state(g public.giveaways) returns text language sql stable as $$
  select case when g.cancelled_at is not null then 'cancelled' when g.drawn_at is not null then 'drawn' when now() < g.starts_at then 'upcoming' when now() < g.ends_at then 'open' else 'ended' end
$$;
create or replace function public.giveaway_json(g public.giveaways, p_me uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', g.id, 'title', g.title, 'prize', g.prize, 'winners', g.winners, 'min_level', g.min_level, 'starts_at', g.starts_at, 'ends_at', g.ends_at,
    'server_hash', g.server_hash, 'state', public.giveaway_state(g), 'entries', (select count(*) from public.giveaway_entries e where e.giveaway_id = g.id),
    'entered', p_me is not null and exists (select 1 from public.giveaway_entries e where e.giveaway_id = g.id and e.user_id = p_me),
    'seed', case when g.drawn_at is not null then (select seed from public.giveaway_secrets s where s.giveaway_id = g.id) end,
    'drawn', case when g.drawn_at is not null then coalesce((select jsonb_agg(jsonb_build_object('place', w.place, 'entry_no', w.entry_no, 'name', p.display_name) order by w.place)
               from public.giveaway_winners w join public.profiles p on p.id = w.user_id where w.giveaway_id = g.id), '[]'::jsonb) end)
$$;

create or replace function public.giveaways_public() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.giveaway_json(g, auth.uid()) order by g.ends_at), '[]'::jsonb)
    from public.giveaways g where g.cancelled_at is null and g.starts_at < now() + interval '7 days' and coalesce(g.drawn_at, g.ends_at) > now() - interval '14 days'
$$;
-- Everyone who entered, in entry order, for checking a draw (names only).
create or replace function public.giveaway_entries_public(p_id bigint) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('entry_no', e.entry_no, 'name', p.display_name) order by e.entry_no), '[]'::jsonb)
    from public.giveaway_entries e join public.profiles p on p.id = e.user_id join public.giveaways g on g.id = e.giveaway_id where e.giveaway_id = p_id and g.drawn_at is not null
$$;

create or replace function public.enter_giveaway(p_id bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.giveaways; n integer;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  select * into g from public.giveaways where id = p_id for update;
  if g.id is null or public.giveaway_state(g) <> 'open' then raise exception 'giveaway_closed'; end if;
  if public.player_level(uid) < g.min_level then raise exception 'level_too_low'; end if;
  if not exists (select 1 from public.giveaway_entries where giveaway_id = p_id and user_id = uid) then
    select coalesce(max(entry_no), 0) + 1 into n from public.giveaway_entries where giveaway_id = p_id;
    insert into public.giveaway_entries (giveaway_id, entry_no, user_id) values (p_id, n, uid);
  end if;
  return jsonb_build_object('entered', true, 'entries', (select count(*) from public.giveaway_entries where giveaway_id = p_id));
end $$;

create or replace function public.admin_giveaways() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view');
begin
  return coalesce((select jsonb_agg(public.giveaway_json(g, null) || jsonb_build_object('by', (select display_name from public.profiles x where x.id = g.created_by)) order by g.id desc)
          from (select * from public.giveaways order by id desc limit 100) g), '[]'::jsonb);
end $$;

create or replace function public.admin_giveaway_create(p_title text, p_prize numeric, p_winners integer, p_min_level integer, p_starts timestamptz, p_ends timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := public.admin_guard('giveaways.manage'); why text := public.admin_need_reason(p_reason); t text := trim(coalesce(p_title, '')); st timestamptz := coalesce(p_starts, now()); seed text; gid bigint;
begin
  if char_length(t) < 2 or char_length(t) > 60 then raise exception 'invalid_value'; end if;
  if p_prize is null or p_prize <= 0 or p_prize > 1000000 or p_prize <> round(p_prize, 2) then raise exception 'invalid_value'; end if;
  if p_winners is null or p_winners < 1 or p_winners > 100 or coalesce(p_min_level, 0) < 0 or coalesce(p_min_level, 0) > 100 then raise exception 'invalid_value'; end if;
  if p_ends is null or p_ends <= st or p_ends <= now() or p_ends > st + interval '31 days' then raise exception 'invalid_dates'; end if;
  seed := encode(gen_random_bytes(32), 'hex');
  insert into public.giveaways (title, prize, winners, min_level, starts_at, ends_at, server_hash, created_by)
  values (t, p_prize, p_winners, coalesce(p_min_level, 0), st, p_ends, encode(digest(seed, 'sha256'), 'hex'), uid) returning id into gid;
  insert into public.giveaway_secrets (giveaway_id, seed) values (gid, seed);
  perform public.admin_log('giveaway.create', 'giveaway', gid::text, null, jsonb_build_object('title', t, 'prize', p_prize, 'winners', p_winners, 'ends_at', p_ends), why);
  return jsonb_build_object('id', gid);
end $$;

-- Draw an ended giveaway: the entries with the lowest SHA-256("<seed>:<entry number>") win; each winner gets the prize; the seed is revealed.
create or replace function public.admin_giveaway_draw(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := public.admin_guard('giveaways.manage'); why text := public.admin_need_reason(p_reason); g public.giveaways; seed text; e record; place integer := 0;
begin
  select * into g from public.giveaways where id = p_id for update;
  if g.id is null then raise exception 'giveaway_not_found'; end if;
  if public.giveaway_state(g) <> 'ended' then raise exception 'giveaway_not_ended'; end if;
  select s.seed into seed from public.giveaway_secrets s where s.giveaway_id = p_id;
  for e in select en.user_id, en.entry_no from public.giveaway_entries en where en.giveaway_id = p_id
           order by encode(digest(seed || ':' || en.entry_no, 'sha256'), 'hex'), en.entry_no limit g.winners loop
    place := place + 1;
    insert into public.giveaway_winners (giveaway_id, user_id, entry_no, place, prize) values (p_id, e.user_id, e.entry_no, place, g.prize);
    perform public.wallet_credit(e.user_id, g.prize, 'giveaway');
  end loop;
  update public.giveaways set drawn_at = now() where id = p_id;
  perform public.admin_log('giveaway.draw', 'giveaway', p_id::text, null, jsonb_build_object('winners', place, 'paid', place * g.prize), why);
  return jsonb_build_object('winners', place, 'paid', place * g.prize, 'seed', seed);
end $$;

create or replace function public.admin_giveaway_cancel(p_id bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('giveaways.manage'); why text := public.admin_need_reason(p_reason); g public.giveaways;
begin
  select * into g from public.giveaways where id = p_id for update;
  if g.id is null then raise exception 'giveaway_not_found'; end if;
  if g.drawn_at is not null then raise exception 'giveaway_closed'; end if;
  if g.cancelled_at is null then
    update public.giveaways set cancelled_at = now() where id = p_id;
    perform public.admin_log('giveaway.cancel', 'giveaway', p_id::text, null, null, why);
  end if;
  return jsonb_build_object('id', p_id, 'cancelled', true);
end $$;

-- ============================ the stats of 0023 count the new kinds too ========================================================
create or replace function public.admin_reward_stats() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.view'); t0 timestamptz := public.rg_day_start(0); t7 timestamptz := public.rg_day_start(6);
begin
  return jsonb_build_object(
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', k, 'today_count', tc, 'today_sum', ts, 'week_count', wc, 'week_sum', ws) order by k)
                       from (select kind as k, count(*) filter (where created_at >= t0) as tc, coalesce(sum(amount) filter (where created_at >= t0), 0) as ts,
                                    count(*) as wc, coalesce(sum(amount), 0) as ws
                               from public.ledger where created_at >= t7 and kind in ('faucet', 'rakeback', 'calendar', 'promo', 'race', 'rain', 'giveaway') group by kind) g), '[]'::jsonb),
    'crates', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'week', n) order by kind) from (select kind, count(*) as n from public.free_claims where claimed_at >= t7 group by kind) c), '[]'::jsonb));
end $$;

-- ============================ privileges =======================================================================================
revoke execute on function public.player_level(uuid), public.race_board(bigint, integer), public.race_json(public.races, uuid), public.rain_settle(),
  public.giveaway_json(public.giveaways, uuid) from public, anon, authenticated;
revoke execute on function public.races_public(), public.admin_races(), public.admin_race_save(bigint, text, timestamptz, timestamptz, numeric[], text[], text),
  public.admin_race_pay(bigint, text), public.admin_race_cancel(bigint, text), public.rain_now(), public.join_rain(bigint), public.admin_rains(),
  public.admin_rain_start(numeric, integer, integer, text), public.admin_rain_cancel(bigint, text), public.giveaways_public(), public.giveaway_entries_public(bigint),
  public.enter_giveaway(bigint), public.admin_giveaways(), public.admin_giveaway_create(text, numeric, integer, integer, timestamptz, timestamptz, text),
  public.admin_giveaway_draw(bigint, text), public.admin_giveaway_cancel(bigint, text) from public, anon;
grant execute on function public.races_public(), public.giveaways_public(), public.giveaway_entries_public(bigint) to anon, authenticated;
grant execute on function public.admin_races(), public.admin_race_save(bigint, text, timestamptz, timestamptz, numeric[], text[], text), public.admin_race_pay(bigint, text),
  public.admin_race_cancel(bigint, text), public.rain_now(), public.join_rain(bigint), public.admin_rains(), public.admin_rain_start(numeric, integer, integer, text),
  public.admin_rain_cancel(bigint, text), public.enter_giveaway(bigint), public.admin_giveaways(), public.admin_giveaway_create(text, numeric, integer, integer, timestamptz, timestamptz, text),
  public.admin_giveaway_draw(bigint, text), public.admin_giveaway_cancel(bigint, text) to authenticated;
