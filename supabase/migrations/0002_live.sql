-- Vaultrush backend, part 2: live multiplayer (case battles and coinflip between real players).
--
-- What the server does here: it keeps the shared lobby, seats players, and draws the random result from a secret seed that
-- nobody (not even the creator) can read before the game is full. The seed's SHA-256 hash is public from the start, the seed
-- itself is revealed when the game starts, and anyone can recompute the result from it (same HMAC maths as src/fair.ts).
-- What it does NOT do: hold the stakes. Coins still live in each player's browser (play money), so the server records who
-- played and who won, and each browser pays itself out. That is fine for a play-money demo, but it is not a real-money design.
-- Run this once in the Supabase SQL editor after 0001_core.sql.

-- ============================ case battles ==============================================================================
create table public.live_battles (
  id          uuid primary key default gen_random_uuid(),
  creator     uuid not null references public.profiles (id) on delete cascade,
  case_ids    text[] not null check (cardinality(case_ids) between 1 and 20),
  format      text not null check (format in ('1v1', '1v1v1', '1v1v1v1', '6way', '2v2', '3v3')),
  mode        text not null check (mode in ('normal', 'crazy', 'terminal', 'jackpot', 'crazyjackpot', 'pointrush', 'group')),
  seats       jsonb not null,                        -- one entry per seat: {uid, name, bot} or null while empty
  player_ids  uuid[] not null default '{}',          -- real players only (lets a player find their own battles)
  status      text not null default 'waiting' check (status in ('waiting', 'running', 'cancelled')),
  server_hash text not null,                         -- SHA-256 of the secret seed, public from the start
  client_seed text not null,
  created_at  timestamptz not null default now(),
  started_at  timestamptz
);
create index live_battles_status on public.live_battles (status, created_at desc);
create index live_battles_players on public.live_battles using gin (player_ids);

create table public.live_battle_secrets (            -- the seed itself; readable only through the view below once the battle started
  battle_id   uuid primary key references public.live_battles (id) on delete cascade,
  server_seed text not null
);

create function public.live_format_size(p_format text) returns integer language sql immutable as $$
  select case p_format when '1v1' then 2 when '1v1v1' then 3 when '1v1v1v1' then 4 when '6way' then 6 when '2v2' then 4 when '3v3' then 6 end
$$;
create function public.live_open_seats(p_seats jsonb) returns integer language sql immutable as $$
  select count(*)::int from jsonb_array_elements(p_seats) e where e = 'null'::jsonb
$$;

-- ============================ coinflip ==================================================================================
create table public.live_coinflips (
  id           bigint generated always as identity primary key,
  creator      uuid not null references public.profiles (id) on delete cascade,
  creator_name text not null,
  side         text not null check (side in ('bolt', 'star')),
  amount       numeric(12, 2) not null check (amount >= 0.10 and amount <= 5000),
  joiner       uuid references public.profiles (id) on delete cascade,
  joiner_name  text,
  status       text not null default 'waiting' check (status in ('waiting', 'done', 'cancelled')),
  result       text check (result in ('bolt', 'star')),
  winner       uuid,
  server_hash  text not null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index live_coinflips_status on public.live_coinflips (status, created_at desc);
create table public.live_coinflip_secrets (
  flip_id     bigint primary key references public.live_coinflips (id) on delete cascade,
  server_seed text not null
);

-- ============================ views, row-level security and privileges ==================================================
create view public.live_battle_seeds with (security_invoker = false) as
  select b.id as battle_id, s.server_seed
  from public.live_battle_secrets s join public.live_battles b on b.id = s.battle_id where b.status = 'running';
create view public.live_coinflip_seeds with (security_invoker = false) as
  select f.id as flip_id, s.server_seed
  from public.live_coinflip_secrets s join public.live_coinflips f on f.id = s.flip_id where f.status = 'done';

alter table public.live_battles         enable row level security;
alter table public.live_battle_secrets  enable row level security;
alter table public.live_coinflips       enable row level security;
alter table public.live_coinflip_secrets enable row level security;
create policy live_battles_read   on public.live_battles   for select to authenticated using (true);
create policy live_coinflips_read on public.live_coinflips for select to authenticated using (true);
-- the two secrets tables have RLS on and no policy: only the owner role and the views can read them.

revoke all on public.live_battles, public.live_battle_secrets, public.live_coinflips, public.live_coinflip_secrets,
  public.live_battle_seeds, public.live_coinflip_seeds from anon, authenticated;
grant select on public.live_battles, public.live_coinflips, public.live_battle_seeds, public.live_coinflip_seeds to authenticated;

-- ============================ functions =================================================================================
create function public.live_player(p_uid uuid) returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare prof public.profiles;
begin
  if p_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into prof from public.profiles where id = p_uid;
  if not found or prof.deleted_at is not null then raise exception 'no_account'; end if;
  if prof.age_confirmed_at is null then raise exception 'age_not_confirmed'; end if;
  return prof;
end $$;

create function public.live_ready() returns boolean language sql stable as $$ select true $$;

create function public.live_battle_maybe_start(p_id uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.live_battles set status = 'running', started_at = now()
   where id = p_id and status = 'waiting' and public.live_open_seats(seats) = 0;
end $$;

create function public.create_live_battle(p_cases text[], p_format text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; n integer; seed text; seat_list jsonb; r public.live_battles; c text;
begin
  prof := public.live_player(uid);
  n := public.live_format_size(p_format);
  if n is null then raise exception 'invalid_format'; end if;
  if p_mode is null or p_mode not in ('normal', 'crazy', 'terminal', 'jackpot', 'crazyjackpot', 'pointrush', 'group') then raise exception 'invalid_mode'; end if;
  if p_format in ('2v2', '3v3') and p_mode not in ('normal', 'crazy', 'terminal') then raise exception 'invalid_mode'; end if;
  if p_cases is null or cardinality(p_cases) not between 1 and 20 then raise exception 'invalid_cases'; end if;
  foreach c in array p_cases loop
    if c is null or c !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'invalid_cases'; end if;
  end loop;
  if (select count(*) from public.live_battles where creator = uid and status = 'waiting') >= 3 then raise exception 'too_many_open'; end if;

  seed := encode(gen_random_bytes(32), 'hex');
  seat_list := (select jsonb_agg('null'::jsonb) from generate_series(1, n));
  seat_list := jsonb_set(seat_list, '{0}', jsonb_build_object('uid', uid, 'name', prof.display_name, 'bot', false));
  insert into public.live_battles (creator, case_ids, format, mode, seats, player_ids, server_hash, client_seed)
  values (uid, p_cases, p_format, p_mode, seat_list, array[uid], encode(digest(seed, 'sha256'), 'hex'), encode(gen_random_bytes(8), 'hex'))
  returning * into r;
  insert into public.live_battle_secrets (battle_id, server_seed) values (r.id, seed);
  return to_jsonb(r);
end $$;

create function public.join_live_battle(p_id uuid, p_seat integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; r public.live_battles; n integer; i integer; free integer;
begin
  prof := public.live_player(uid);
  select * into r from public.live_battles where id = p_id for update;
  if not found then raise exception 'battle_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'battle_not_open'; end if;
  if r.created_at < now() - interval '30 minutes' then raise exception 'battle_expired'; end if;
  if uid = any (r.player_ids) then raise exception 'already_seated'; end if;
  n := jsonb_array_length(r.seats);
  if p_seat is null then
    for i in 0 .. n - 1 loop
      if r.seats -> i = 'null'::jsonb then free := i; exit; end if;
    end loop;
  else
    if p_seat < 0 or p_seat >= n then raise exception 'invalid_seat'; end if;
    if r.seats -> p_seat <> 'null'::jsonb then raise exception 'seat_taken'; end if;
    free := p_seat;
  end if;
  if free is null then raise exception 'battle_full'; end if;
  update public.live_battles
     set seats = jsonb_set(seats, array[free::text], jsonb_build_object('uid', uid, 'name', prof.display_name, 'bot', false)),
         player_ids = player_ids || uid
   where id = p_id;
  perform public.live_battle_maybe_start(p_id);
  return (select to_jsonb(b) from public.live_battles b where b.id = p_id);
end $$;

-- The creator filling an empty seat with a bot (bots play for the house: if a bot wins, the pot is gone).
create function public.call_live_bot(p_id uuid, p_seat integer, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_battles; n integer;
begin
  perform public.live_player(uid);
  select * into r from public.live_battles where id = p_id for update;
  if not found then raise exception 'battle_not_found'; end if;
  if r.creator <> uid then raise exception 'not_creator'; end if;
  if r.status <> 'waiting' then raise exception 'battle_not_open'; end if;
  n := jsonb_array_length(r.seats);
  if p_seat is null or p_seat < 1 or p_seat >= n then raise exception 'invalid_seat'; end if;
  if r.seats -> p_seat <> 'null'::jsonb then raise exception 'seat_taken'; end if;
  if p_name is null or p_name !~ '^[A-Za-z0-9_&-]{2,20}$' then raise exception 'invalid_name'; end if;
  update public.live_battles set seats = jsonb_set(seats, array[p_seat::text], jsonb_build_object('uid', null, 'name', p_name, 'bot', true)) where id = p_id;
  perform public.live_battle_maybe_start(p_id);
  return (select to_jsonb(b) from public.live_battles b where b.id = p_id);
end $$;

-- Leave a battle that has not started. The creator leaving cancels it for everyone; each browser refunds its own stake.
create function public.leave_live_battle(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_battles; i integer;
begin
  perform public.live_player(uid);
  select * into r from public.live_battles where id = p_id for update;
  if not found then raise exception 'battle_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'already_started'; end if;
  if uid = r.creator then
    update public.live_battles set status = 'cancelled' where id = p_id;
  elsif uid = any (r.player_ids) then
    for i in 0 .. jsonb_array_length(r.seats) - 1 loop
      if r.seats -> i ->> 'uid' = uid::text then
        update public.live_battles set seats = jsonb_set(seats, array[i::text], 'null'::jsonb), player_ids = array_remove(player_ids, uid) where id = p_id;
        exit;
      end if;
    end loop;
  else
    raise exception 'not_in_battle';
  end if;
  return (select to_jsonb(b) from public.live_battles b where b.id = p_id);
end $$;

create function public.create_live_coinflip(p_side text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; seed text; r public.live_coinflips;
begin
  prof := public.live_player(uid);
  if p_side is null or p_side not in ('bolt', 'star') then raise exception 'invalid_side'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if (select count(*) from public.live_coinflips where creator = uid and status = 'waiting') >= 5 then raise exception 'too_many_open'; end if;
  seed := encode(gen_random_bytes(32), 'hex');
  insert into public.live_coinflips (creator, creator_name, side, amount, server_hash)
  values (uid, prof.display_name, p_side, p_amount, encode(digest(seed, 'sha256'), 'hex')) returning * into r;
  insert into public.live_coinflip_secrets (flip_id, server_seed) values (r.id, seed);
  return to_jsonb(r);
end $$;

-- Joining draws the result at once: float = first 32 bits of HMAC-SHA256(seed, "<id>:0:0") / 2^32, bolt below 0.5, star otherwise.
create function public.join_live_coinflip(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; r public.live_coinflips; seed text; h text; f double precision; res text;
begin
  prof := public.live_player(uid);
  select * into r from public.live_coinflips where id = p_id for update;
  if not found then raise exception 'flip_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'flip_not_open'; end if;
  if r.created_at < now() - interval '30 minutes' then raise exception 'flip_expired'; end if;
  if r.creator = uid then raise exception 'own_flip'; end if;
  select server_seed into seed from public.live_coinflip_secrets where flip_id = p_id;
  h := encode(hmac(p_id::text || ':0:0', seed, 'sha256'), 'hex');
  f := (('x' || substr(h, 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
  res := case when f < 0.5 then 'bolt' else 'star' end;
  update public.live_coinflips
     set joiner = uid, joiner_name = prof.display_name, status = 'done', result = res,
         winner = case when side = res then creator else uid end, finished_at = now()
   where id = p_id;
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id);
end $$;

create function public.cancel_live_coinflip(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_coinflips;
begin
  perform public.live_player(uid);
  select * into r from public.live_coinflips where id = p_id for update;
  if not found then raise exception 'flip_not_found'; end if;
  if r.creator <> uid then raise exception 'not_creator'; end if;
  if r.status <> 'waiting' then raise exception 'flip_not_open'; end if;
  update public.live_coinflips set status = 'cancelled', finished_at = now() where id = p_id;
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id);
end $$;

-- Helpers stay private; the public API is callable by signed-in players only.
revoke execute on function public.live_player(uuid), public.live_battle_maybe_start(uuid), public.live_format_size(text), public.live_open_seats(jsonb) from public, anon, authenticated;
revoke execute on function public.live_ready(), public.create_live_battle(text[], text, text), public.join_live_battle(uuid, integer), public.call_live_bot(uuid, integer, text),
  public.leave_live_battle(uuid), public.create_live_coinflip(text, numeric), public.join_live_coinflip(bigint), public.cancel_live_coinflip(bigint) from public, anon, authenticated;
grant execute on function public.live_ready(), public.create_live_battle(text[], text, text), public.join_live_battle(uuid, integer), public.call_live_bot(uuid, integer, text),
  public.leave_live_battle(uuid), public.create_live_coinflip(text, numeric), public.join_live_coinflip(bigint), public.cancel_live_coinflip(bigint) to authenticated;

-- Realtime: players see lobbies and results as they change (a no-op outside Supabase).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.live_battles;
    alter publication supabase_realtime add table public.live_coinflips;
  end if;
end $$;
