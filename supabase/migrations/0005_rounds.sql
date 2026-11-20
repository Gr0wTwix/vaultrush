-- Vaultrush backend, part 5: shared Crash and Double rounds, so every signed-in player sees the same round and everyone's bets.
-- Run once in the SQL editor after 0004_claims_bots_caps.sql.
--
-- How it works. The database keeps ONE current round per game and moves it along by the clock, never by a background job: any client
-- may call advance_round(game) at any time and the function does whatever is due (open the next round, start it, finish and settle it).
-- It is idempotent, serialised per game, and decides only from time, so it does not matter who calls it or how often.
--   Crash : bets for 7 s, then the multiplier climbs as e^(0.00012 * ms) until the crash point, then a 3.5 s pause. The crash point is
--           drawn from a secret seed and stays hidden until the crash instant, so nobody can peek and cash out safely. A cash-out is
--           timed by the SERVER clock. An auto cash-out below the crash point is applied by the server when the round ends.
--   Double: bets for 12 s, then the result tile is drawn (and revealed, since betting has closed), the reel rolls for 5.2 s, payouts
--           are settled, 2.6 s pause.
-- Fairness: the seed hash is public from the start; the seed is revealed when the round is finished; float = first 32 bits of
-- HMAC-SHA256(seed, "<round id>:0:0") / 2^32, crash point = min(10000, max(1, floor(97 / (1 - f)) / 100)), double tile = floor(f * 15).
-- Money: like the other live games, stakes and payouts stay in each browser (play money). The server records bets and computes payouts.

-- ============================ tables ====================================================================================
create table public.game_rounds (
  id               bigint generated always as identity primary key,
  game             text not null check (game in ('crash', 'double')),
  status           text not null default 'betting' check (status in ('betting', 'running', 'finished')),
  created_at       timestamptz not null default now(),
  betting_ends_at  timestamptz not null,           -- betting closes and the round starts at this instant
  finished_at      timestamptz,                    -- crash: the crash instant; double: the end of the roll
  server_hash      text not null,                  -- SHA-256 of the secret seed, public from the start
  result           jsonb                           -- crash: {"point": 2.31} once finished; double: {"n": 7} once running
);
create index game_rounds_game_id on public.game_rounds (game, id desc);

create table public.game_round_secrets (
  round_id    bigint primary key references public.game_rounds (id) on delete cascade,
  server_seed text not null
);

create table public.round_bets (
  id            bigint generated always as identity primary key,
  round_id      bigint not null references public.game_rounds (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  display_name  text not null,
  lane          text not null default '' check (lane in ('', 'purple', 'gray', 'green', 'bait')),   -- double only
  amount        numeric(12, 2) not null check (amount >= 0.10),
  auto_cashout  numeric(8, 2) check (auto_cashout is null or auto_cashout >= 1.01),                 -- crash only
  riding        numeric(12, 2) not null,           -- crash: stake still riding after partial cash-outs
  locked        numeric(14, 2) not null default 0, -- crash: payout locked in by cash-outs; double: payout once settled
  cashouts      jsonb not null default '[]',       -- crash: the multipliers cashed out at
  done          boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (round_id, user_id, lane)
);
create index round_bets_user on public.round_bets (user_id, id desc);

create view public.game_round_seeds with (security_invoker = false) as
  select r.id as round_id, s.server_seed
  from public.game_round_secrets s join public.game_rounds r on r.id = s.round_id where r.status = 'finished';

alter table public.game_rounds        enable row level security;
alter table public.game_round_secrets enable row level security;
alter table public.round_bets         enable row level security;
create policy game_rounds_read on public.game_rounds for select to authenticated using (true);
create policy round_bets_read  on public.round_bets  for select to authenticated using (true);
revoke all on public.game_rounds, public.game_round_secrets, public.round_bets, public.game_round_seeds from anon, authenticated;
grant select on public.game_rounds, public.round_bets, public.game_round_seeds to authenticated;

-- ============================ the clock =================================================================================
create function public.round_bet_ms(p_game text) returns integer language sql immutable as $$ select case p_game when 'crash' then 7000 else 12000 end $$;
create function public.round_cooldown_ms(p_game text) returns integer language sql immutable as $$ select case p_game when 'crash' then 3500 else 2600 end $$;

-- Float for a round, same as the browser's floatsFor(seed, String(id), 0, 1).
create function public.round_float(p_seed text, p_id bigint) returns double precision language plpgsql immutable set search_path = public, extensions, pg_temp as $$
declare h text := encode(hmac(p_id::text || ':0:0', p_seed, 'sha256'), 'hex');
begin return (('x' || substr(h, 1, 8))::bit(32)::bigint)::double precision / 4294967296.0; end $$;

create function public.crash_point_of(p_f double precision) returns numeric language sql immutable as $$
  select least(10000::numeric, greatest(1::numeric, floor(97.0 / (1 - p_f))::numeric / 100))
$$;

-- Does a double bet on this lane win on tile n?  Tile 0 = green, odd = purple, even (not 0) = gray; bait = tiles 1 and 14.
create function public.double_lane_wins(p_lane text, p_n integer) returns boolean language sql immutable as $$
  select case p_lane when 'green' then p_n = 0 when 'purple' then p_n % 2 = 1 when 'gray' then p_n <> 0 and p_n % 2 = 0 when 'bait' then p_n in (1, 14) else false end
$$;
create function public.double_lane_pay(p_lane text) returns numeric language sql immutable as $$ select case p_lane when 'green' then 14 when 'bait' then 7 else 2 end::numeric $$;

-- Do everything that is due, by the clock only. Returns the current round. Callers hold no authority: the result depends only on time.
create function public.advance_round_internal(p_game text) returns public.game_rounds
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare r public.game_rounds; seed text; f double precision; cp numeric; n integer; crash_at timestamptz; roll_end timestamptz;
begin
  if p_game is null or p_game not in ('crash', 'double') then raise exception 'invalid_game'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rounds:' || p_game, 0));
  select * into r from public.game_rounds where game = p_game order by id desc limit 1;

  -- the previous round is over and its pause has passed (or there is none yet): open the next one
  if not found or (r.status = 'finished' and now() >= r.finished_at + make_interval(secs => public.round_cooldown_ms(p_game) / 1000.0)) then
    delete from public.game_rounds where game = p_game and created_at < now() - interval '3 days';
    seed := encode(gen_random_bytes(32), 'hex');
    insert into public.game_rounds (game, betting_ends_at, server_hash)
    values (p_game, now() + make_interval(secs => public.round_bet_ms(p_game) / 1000.0), encode(digest(seed, 'sha256'), 'hex')) returning * into r;
    insert into public.game_round_secrets (round_id, server_seed) values (r.id, seed);
    return r;
  end if;

  select server_seed into seed from public.game_round_secrets where round_id = r.id;

  -- betting is over: the round starts (double reveals its tile now: nobody can bet any more)
  if r.status = 'betting' and now() >= r.betting_ends_at then
    if p_game = 'double' then
      n := floor(public.round_float(seed, r.id) * 15)::integer;
      update public.game_rounds set status = 'running', result = jsonb_build_object('n', n) where id = r.id returning * into r;
    else
      update public.game_rounds set status = 'running' where id = r.id returning * into r;
    end if;
  end if;

  -- a running round whose time is up: finish and settle
  if r.status = 'running' then
    if p_game = 'crash' then
      cp := public.crash_point_of(public.round_float(seed, r.id));
      crash_at := r.betting_ends_at + make_interval(secs => ln(cp::double precision) / 0.00012 / 1000.0);
      if now() >= crash_at then
        update public.round_bets
           set locked = locked + round(riding * auto_cashout, 2), riding = 0, cashouts = cashouts || to_jsonb(auto_cashout), done = true
         where round_id = r.id and not done and auto_cashout is not null and auto_cashout < cp;     -- auto cash-outs below the crash point
        update public.round_bets set done = true where round_id = r.id and not done;                    -- everyone else is busted
        update public.game_rounds set status = 'finished', finished_at = crash_at, result = jsonb_build_object('point', cp) where id = r.id returning * into r;
      end if;
    else
      roll_end := r.betting_ends_at + interval '5200 milliseconds';
      if now() >= roll_end then
        n := (r.result ->> 'n')::integer;
        update public.round_bets
           set done = true, locked = case when public.double_lane_wins(lane, n) then round(amount * public.double_lane_pay(lane), 2) else 0 end
         where round_id = r.id and not done;
        update public.game_rounds set status = 'finished', finished_at = roll_end where id = r.id returning * into r;
      end if;
    end if;
  end if;

  -- finished and the pause is already over (a long gap since the last call): open the next round straight away
  if r.status = 'finished' and now() >= r.finished_at + make_interval(secs => public.round_cooldown_ms(p_game) / 1000.0) then
    seed := encode(gen_random_bytes(32), 'hex');
    insert into public.game_rounds (game, betting_ends_at, server_hash)
    values (p_game, now() + make_interval(secs => public.round_bet_ms(p_game) / 1000.0), encode(digest(seed, 'sha256'), 'hex')) returning * into r;
    insert into public.game_round_secrets (round_id, server_seed) values (r.id, seed);
  end if;
  return r;
end $$;

-- ============================ the public API ==============================================================================
create function public.rounds_ready() returns boolean language sql stable as $$ select true $$;

create function public.advance_round(p_game text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.game_rounds;
begin
  perform public.live_player(auth.uid());
  r := public.advance_round_internal(p_game);
  return jsonb_build_object('round', to_jsonb(r), 'now', now());
end $$;

create function public.round_name(p_uid uuid, p_anon boolean) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when coalesce(p_anon, false) then 'Anonymous' else (select display_name from public.profiles where id = p_uid) end
$$;

-- Crash: place a bet in the current round (during betting only), with an optional automatic cash-out multiplier.
create function public.crash_place_bet(p_round bigint, p_amount numeric, p_auto numeric default null, p_anon boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets;
begin
  perform public.live_player(uid);
  r := public.advance_round_internal('crash');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if p_auto is not null and (p_auto < 1.01 or p_auto > 1000 or p_auto <> round(p_auto, 2)) then raise exception 'invalid_target'; end if;
  begin
    insert into public.round_bets (round_id, user_id, display_name, amount, auto_cashout, riding)
    values (r.id, uid, public.round_name(uid, p_anon), p_amount, p_auto, p_amount) returning * into b;
  exception when unique_violation then raise exception 'already_bet';
  end;
  return to_jsonb(b);
end $$;

-- Crash: take the bet back before the round starts. Returns the amount to give back.
create function public.crash_cancel_bet(p_round bigint) returns numeric language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; amt numeric;
begin
  perform public.live_player(uid);
  r := public.advance_round_internal('crash');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  delete from public.round_bets where round_id = r.id and user_id = uid returning amount into amt;
  if amt is null then raise exception 'no_bet'; end if;
  return amt;
end $$;

-- Crash: cash out a share (0 to 1) of what is still riding, at the multiplier of the SERVER clock. Same rounding rules as the browser used.
create function public.crash_cashout(p_round bigint, p_frac numeric default 1) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets; ms double precision; mult numeric; take numeric; got numeric; frac numeric := least(1, greatest(0.01, coalesce(p_frac, 1)));
begin
  perform public.live_player(uid);
  r := public.advance_round_internal('crash');
  if r.id <> p_round then raise exception 'round_over'; end if;
  if r.status = 'betting' then raise exception 'not_started'; end if;
  if r.status = 'finished' then raise exception 'too_late'; end if;
  select * into b from public.round_bets where round_id = r.id and user_id = uid for update;
  if not found then raise exception 'no_bet'; end if;
  if b.done then raise exception 'too_late'; end if;
  ms := extract(epoch from (now() - r.betting_ends_at)) * 1000;
  mult := floor(exp(0.00012 * ms) * 100) / 100;
  take := round(b.riding * frac, 2);
  if frac >= 1 or b.riding - take < 0.01 or jsonb_array_length(b.cashouts) >= 7 then take := b.riding; end if;
  got := round(take * mult, 2);
  update public.round_bets
     set riding = riding - take, locked = locked + got, cashouts = cashouts || to_jsonb(mult), done = (riding - take) <= 0
   where id = b.id returning * into b;
  return jsonb_build_object('mult', mult, 'take', take, 'got', got, 'riding', b.riding, 'locked', b.locked, 'done', b.done, 'bet', to_jsonb(b));
end $$;

-- Double: bet on a lane (during betting only). Several lanes are allowed, but not both purple and gray. Repeating a lane adds to it.
create function public.double_place_bet(p_round bigint, p_lane text, p_amount numeric, p_anon boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets;
begin
  perform public.live_player(uid);
  r := public.advance_round_internal('double');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  if p_lane is null or p_lane not in ('purple', 'gray', 'green', 'bait') then raise exception 'invalid_lane'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if exists (select 1 from public.round_bets where round_id = r.id and user_id = uid and lane = case p_lane when 'purple' then 'gray' when 'gray' then 'purple' else '-' end) then
    raise exception 'both_sides';
  end if;
  insert into public.round_bets (round_id, user_id, display_name, lane, amount, riding)
  values (r.id, uid, public.round_name(uid, p_anon), p_lane, p_amount, p_amount)
  on conflict (round_id, user_id, lane) do update set amount = public.round_bets.amount + excluded.amount, riding = public.round_bets.riding + excluded.riding
  returning * into b;
  return to_jsonb(b);
end $$;

-- ============================ account deletion also removes the name from round bets =========================================
create or replace function public.delete_account() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); bal numeric; anon text;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'no_account'; end if;
  anon := 'deleted-' || substr(replace(uid::text, '-', ''), 1, 8);
  select balance into bal from public.wallets where user_id = uid for update;
  if bal > 0 then
    update public.wallets set balance = 0, updated_at = now() where user_id = uid;
    insert into public.ledger (user_id, kind, amount, balance_after) values (uid, 'adjustment', -bal, 0);
  end if;
  delete from public.chat_messages where user_id = uid;
  delete from public.limit_changes where user_id = uid;
  update public.live_coinflips set creator_name = anon where creator = uid;
  update public.live_coinflips set joiner_name = anon where joiner = uid;
  update public.live_battles b
     set seats = (select jsonb_agg(case when e <> 'null'::jsonb and e ->> 'uid' = uid::text then jsonb_set(e, '{name}', to_jsonb(anon)) else e end order by ord)
                    from jsonb_array_elements(b.seats) with ordinality as t(e, ord))
   where uid = any (b.player_ids);
  update public.round_bets set display_name = anon where user_id = uid;
  update public.profiles set display_name = anon, deleted_at = now() where id = uid;
end $$;

-- ============================ privileges and realtime ========================================================================
revoke execute on function public.round_bet_ms(text), public.round_cooldown_ms(text), public.round_float(text, bigint), public.crash_point_of(double precision),
  public.double_lane_wins(text, integer), public.double_lane_pay(text), public.advance_round_internal(text), public.round_name(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.rounds_ready(), public.advance_round(text), public.crash_place_bet(bigint, numeric, numeric, boolean), public.crash_cancel_bet(bigint),
  public.crash_cashout(bigint, numeric), public.double_place_bet(bigint, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.rounds_ready(), public.advance_round(text), public.crash_place_bet(bigint, numeric, numeric, boolean), public.crash_cancel_bet(bigint),
  public.crash_cashout(bigint, numeric), public.double_place_bet(bigint, text, numeric, boolean) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.game_rounds;
    alter publication supabase_realtime add table public.round_bets;
  end if;
end $$;
