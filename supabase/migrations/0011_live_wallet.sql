-- Vaultrush 0011: Battles, Coinflip, Crash and Double use the SERVER wallet. Run after 0010_solo_games.sql.
--
-- Before this, the live games recorded who played and who won but each browser held its own coins. Now the database takes every stake when a player
-- sits down, draws the result itself, pays the winners and writes the bets, all inside one transaction:
--   Coinflip : stake at create / join, winner paid 1.94x (the pot minus 3%) the moment the second player joins or a bot is called.
--   Battles  : cost of all the cases at create / join; when the last seat fills the database draws every pull from the secret seed, decides the
--              winners (all seven modes, like src/views/battles.ts) and pays the pot (the total value pulled by everyone) to them. Bots play for the
--              house: if a bot wins, the pot is gone.
--   Crash    : stake at bet, cash-outs paid at once (server clock), auto cash-outs paid when the round ends.
--   Double   : stake at bet, winners paid when the round ends.
-- Leaving never traps coins: cancelling a coinflip, leaving a battle that has not started (the creator cancels it for everyone) and cancelling a crash bet
-- before the round starts all refund the stake. A lobby left waiting for 30 minutes is cancelled and refunded by live_reap().
-- Games that were waiting or running before this migration (their stakes were in browsers, not here) are closed WITHOUT refunds from the server wallet.

alter table public.live_battles add column if not exists outcome jsonb;      -- {winners:[seat...], totals:[...], pot} once the battle has run

update public.live_battles set status = 'cancelled' where status = 'waiting';
update public.live_coinflips set status = 'cancelled', finished_at = now() where status = 'waiting';
delete from public.round_bets where round_id in (select id from public.game_rounds where status <> 'finished');

-- ============================ the maths of a battle (a port of decide() in src/views/battles.ts) ============================
create function public.battle_cost(p_cases text[]) returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select case when count(c.id) = cardinality(p_cases) then round(sum(c.price), 2) end
  from unnest(p_cases) as x(id) left join public.catalog_cases c on c.id = x.id and c.active and not c.reward
$$;

-- 0-based indices of the best (or lowest) values.
create function public.battle_best(p_vals numeric[], p_low boolean) returns integer[] language plpgsql immutable as $$
declare t numeric; i integer; out integer[] := '{}';
begin
  select case when p_low then min(v) else max(v) end into t from unnest(p_vals) v;
  for i in 1..cardinality(p_vals) loop if p_vals[i] = t then out := out || (i - 1); end if; end loop;
  return out;
end $$;
-- Break a tie with the extra float: idx[min(len - 1, floor(f * len))], 0-based like the browser.
create function public.battle_tie(p_idx integer[], p_f double precision) returns integer language sql immutable as $$
  select case when cardinality(p_idx) = 1 then p_idx[1] else p_idx[least(cardinality(p_idx), floor(p_f * cardinality(p_idx))::integer + 1)] end
$$;

-- p_vals is a P x R matrix: the value of the item each player pulled in each round.
create function public.battle_outcome(p_mode text, p_format text, p_vals numeric[], p_extra double precision) returns jsonb language plpgsql immutable as $$
declare
  n_p integer := array_length(p_vals, 1); n_r integer := array_length(p_vals, 2); totals numeric[] := '{}'; last numeric[] := '{}'; s numeric; p integer; r integer;
  winners integer[]; team_a integer[]; team_b integer[]; scores numeric[]; vals numeric[]; w double precision[] := '{}'; sum_w double precision := 0; x double precision; pts integer[]; col numeric[]; pot numeric;
  extra jsonb := '{}'::jsonb; b integer;
begin
  for p in 1..n_p loop
    s := 0; for r in 1..n_r loop s := s + p_vals[p][r]; end loop;
    totals := totals || round(s, 2); last := last || p_vals[p][n_r];
  end loop;
  if p_format in ('2v2', '3v3') then
    if p_format = '2v2' then team_a := '{0,1}'; team_b := '{2,3}'; else team_a := '{0,1,2}'; team_b := '{3,4,5}'; end if;
    vals := case when p_mode = 'terminal' then last else totals end;
    scores := array[0, 0];
    foreach b in array team_a loop scores[1] := scores[1] + vals[b + 1]; end loop;
    foreach b in array team_b loop scores[2] := scores[2] + vals[b + 1]; end loop;
    scores := array[round(scores[1], 2), round(scores[2], 2)];
    winners := case when public.battle_tie(public.battle_best(scores, p_mode = 'crazy'), p_extra) = 0 then team_a else team_b end;
  elsif p_mode = 'group' then
    winners := array(select generate_series(0, n_p - 1));
  elsif p_mode = 'terminal' then
    winners := array[public.battle_tie(public.battle_best(last, false), p_extra)];
  elsif p_mode = 'crazy' then
    winners := array[public.battle_tie(public.battle_best(totals, true), p_extra)];
  elsif p_mode in ('jackpot', 'crazyjackpot') then
    for p in 1..n_p loop w := w || case when p_mode = 'jackpot' then greatest(totals[p]::double precision, 0.01::double precision) else 1.0 / (totals[p]::double precision + 0.05) end; end loop;
    for p in 1..n_p loop sum_w := sum_w + w[p]; end loop;
    x := p_extra * sum_w; winners := array[n_p - 1];
    for p in 1..n_p loop x := x - w[p]; if x < 0 then winners := array[p - 1]; exit; end if; end loop;
  elsif p_mode = 'pointrush' then
    pts := array_fill(0, array[n_p]);
    for r in 1..n_r loop
      col := '{}'; for p in 1..n_p loop col := col || p_vals[p][r]; end loop;
      foreach b in array public.battle_best(col, false) loop pts[b + 1] := pts[b + 1] + 1; end loop;
    end loop;
    winners := array[public.battle_tie(public.battle_best(pts::numeric[], false), p_extra)];
    extra := jsonb_build_object('points', to_jsonb(pts));
  else
    winners := array[public.battle_tie(public.battle_best(totals, false), p_extra)];
  end if;
  select round(sum(t), 2) into pot from unnest(totals) t;
  return jsonb_build_object('winners', to_jsonb(winners), 'totals', to_jsonb(totals), 'pot', pot) || extra;
end $$;

-- ============================ reaping lobbies that were left waiting ======================================================
create function public.live_reap() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_battles; f public.live_coinflips; u uuid; cost numeric;
begin
  for r in select * from public.live_battles where status = 'waiting' and created_at < now() - interval '30 minutes' for update skip locked loop
    update public.live_battles set status = 'cancelled' where id = r.id;
    cost := public.battle_cost(r.case_ids);
    foreach u in array r.player_ids loop perform public.wallet_credit(u, cost, 'refund'); end loop;
  end loop;
  for f in select * from public.live_coinflips where status = 'waiting' and created_at < now() - interval '30 minutes' for update skip locked loop
    update public.live_coinflips set status = 'cancelled', finished_at = now() where id = f.id;
    perform public.wallet_credit(f.creator, f.amount, 'refund');
  end loop;
end $$;

-- ============================ coinflip =====================================================================================
create or replace function public.create_live_coinflip(p_side text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; seed text; r public.live_coinflips; bal numeric;
begin
  perform public.site_guard('coinflip');
  prof := public.live_player(uid);
  perform public.live_reap();
  if p_side is null or p_side not in ('bolt', 'star') then raise exception 'invalid_side'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if (select count(*) from public.live_coinflips where creator = uid and status = 'waiting') >= 5 then raise exception 'too_many_open'; end if;
  perform public.wallet_gate(uid, p_amount);
  bal := public.wallet_debit(uid, p_amount, 'bet', null, true);
  seed := encode(gen_random_bytes(32), 'hex');
  insert into public.live_coinflips (creator, creator_name, side, amount, server_hash)
  values (uid, prof.display_name, p_side, p_amount, encode(digest(seed, 'sha256'), 'hex')) returning * into r;
  insert into public.live_coinflip_secrets (flip_id, server_seed) values (r.id, seed);
  return to_jsonb(r) || jsonb_build_object('balance', bal);
end $$;

-- Pay a finished coinflip and write both bets. The winner takes 2 x the stake minus 3% (a bot opponent's stake is the house's).
create function public.coinflip_settle(p_id bigint) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.live_coinflips; pay numeric;
begin
  select * into f from public.live_coinflips where id = p_id;
  pay := round(f.amount * 1.94, 2);
  if f.winner is not null then perform public.wallet_credit(f.winner, pay, 'win', null, true); end if;
  perform public.bet_record(f.creator, 'coinflip', f.amount, case when f.winner = f.creator then pay else 0 end, null, jsonb_build_object('flip', f.id, 'side', f.side), jsonb_build_object('result', f.result, 'winner', f.winner));
  if f.joiner is not null then
    perform public.bet_record(f.joiner, 'coinflip', f.amount, case when f.winner = f.joiner then pay else 0 end, null, jsonb_build_object('flip', f.id, 'side', case f.side when 'bolt' then 'star' else 'bolt' end), jsonb_build_object('result', f.result, 'winner', f.winner));
  end if;
end $$;

create or replace function public.join_live_coinflip(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; r public.live_coinflips; seed text; h text; f double precision; res text; bal numeric;
begin
  perform public.site_guard('coinflip');
  prof := public.live_player(uid);
  perform public.live_reap();
  select * into r from public.live_coinflips where id = p_id for update;
  if not found then raise exception 'flip_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'flip_not_open'; end if;
  if r.creator = uid then raise exception 'own_flip'; end if;
  perform public.wallet_gate(uid, r.amount);
  bal := public.wallet_debit(uid, r.amount, 'bet', null, true);
  select server_seed into seed from public.live_coinflip_secrets where flip_id = p_id;
  h := encode(hmac(p_id::text || ':0:0', seed, 'sha256'), 'hex');
  f := (('x' || substr(h, 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
  res := case when f < 0.5 then 'bolt' else 'star' end;
  update public.live_coinflips
     set joiner = uid, joiner_name = prof.display_name, status = 'done', result = res,
         winner = case when side = res then creator else uid end, finished_at = now()
   where id = p_id;
  perform public.coinflip_settle(p_id);
  bal := (select balance from public.wallets where user_id = uid);
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id) || jsonb_build_object('balance', bal);
end $$;

create or replace function public.call_live_coinflip_bot(p_id bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_coinflips; seed text; h text; f double precision; res text;
begin
  perform public.site_guard('coinflip');
  perform public.live_player(uid);
  select * into r from public.live_coinflips where id = p_id for update;
  if not found then raise exception 'flip_not_found'; end if;
  if r.creator <> uid then raise exception 'not_creator'; end if;
  if r.status <> 'waiting' then raise exception 'flip_not_open'; end if;
  if p_name is null or p_name !~ '^[A-Za-z0-9_&-]{2,20}$' then raise exception 'invalid_name'; end if;
  select server_seed into seed from public.live_coinflip_secrets where flip_id = p_id;
  h := encode(hmac(p_id::text || ':0:0', seed, 'sha256'), 'hex');
  f := (('x' || substr(h, 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
  res := case when f < 0.5 then 'bolt' else 'star' end;
  update public.live_coinflips
     set joiner = null, joiner_name = p_name, joiner_bot = true, status = 'done', result = res,
         winner = case when side = res then creator else null end, finished_at = now()
   where id = p_id;
  perform public.coinflip_settle(p_id);
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id) || jsonb_build_object('balance', (select balance from public.wallets where user_id = uid));
end $$;

create or replace function public.cancel_live_coinflip(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_coinflips; bal numeric;
begin
  perform public.live_player(uid);
  select * into r from public.live_coinflips where id = p_id for update;
  if not found then raise exception 'flip_not_found'; end if;
  if r.creator <> uid then raise exception 'not_creator'; end if;
  if r.status <> 'waiting' then raise exception 'flip_not_open'; end if;
  update public.live_coinflips set status = 'cancelled', finished_at = now() where id = p_id;
  bal := public.wallet_credit(uid, r.amount, 'refund');
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id) || jsonb_build_object('balance', bal);
end $$;

-- ============================ battles =======================================================================================
-- Draw every pull from the secret seed, decide the winners, pay them and write the bets. Runs once, when the last seat fills.
create function public.live_battle_settle(p_id uuid) returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  r public.live_battles; seed text; n_p integer; n_r integer; fl double precision[]; vals numeric[]; pp integer; rr integer; tk integer; v numeric; oc jsonb; winners integer[];
  pot numeric; share numeric; cost numeric; seat jsonb; u uuid; pay numeric; i integer;
begin
  select * into r from public.live_battles where id = p_id for update;
  if r.status <> 'running' or r.outcome is not null then return; end if;
  select server_seed into seed from public.live_battle_secrets where battle_id = p_id;
  n_p := jsonb_array_length(r.seats); n_r := cardinality(r.case_ids);
  fl := public.fair_floats(seed, r.client_seed, 0, n_p * n_r + 1);
  vals := array_fill(0::numeric, array[n_p, n_r]);
  for pp in 0..n_p - 1 loop
    for rr in 0..n_r - 1 loop
      tk := floor(fl[rr * n_p + pp + 1] * 100000)::integer;
      select it.value into v from public.catalog_case_entries e join public.catalog_items it on it.id = e.item_id where e.case_id = r.case_ids[rr + 1] and tk between e.ticket_from and e.ticket_to;
      vals[pp + 1][rr + 1] := coalesce(v, 0);
    end loop;
  end loop;
  oc := public.battle_outcome(r.mode, r.format, vals, fl[n_p * n_r + 1]);
  pot := (oc ->> 'pot')::numeric;
  winners := array(select jsonb_array_elements_text(oc -> 'winners')::integer);
  share := round(pot / cardinality(winners), 2);
  cost := public.battle_cost(r.case_ids);
  update public.live_battles set outcome = oc where id = p_id;
  for i in 0..n_p - 1 loop
    seat := r.seats -> i;
    if seat ->> 'uid' is null then continue; end if;                      -- a bot's seat: its stake and its winnings are the house's
    u := (seat ->> 'uid')::uuid;
    pay := case when i = any (winners) then share else 0 end;
    begin
      if pay > 0 then perform public.wallet_credit(u, pay, 'win', null, true); end if;
      perform public.bet_record(u, 'battles', cost, pay, null, jsonb_build_object('battle', p_id, 'format', r.format, 'mode', r.mode, 'cases', to_jsonb(r.case_ids)),
                                jsonb_build_object('seat', i, 'winners', to_jsonb(winners), 'pot', pot));
    exception when others then null;                                         -- one bad account must never block the others' payouts
    end;
  end loop;
end $$;

create or replace function public.live_battle_maybe_start(p_id uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.live_battles set status = 'running', started_at = now()
   where id = p_id and status = 'waiting' and public.live_open_seats(seats) = 0;
  if found then perform public.live_battle_settle(p_id); end if;
end $$;

create or replace function public.create_live_battle(p_cases text[], p_format text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; n integer; seed text; seat_list jsonb; r public.live_battles; cost numeric; bal numeric;
begin
  perform public.site_guard('battles');
  prof := public.live_player(uid);
  perform public.live_reap();
  n := public.live_format_size(p_format);
  if n is null then raise exception 'invalid_format'; end if;
  if p_mode is null or p_mode not in ('normal', 'crazy', 'terminal', 'jackpot', 'crazyjackpot', 'pointrush', 'group') then raise exception 'invalid_mode'; end if;
  if p_format in ('2v2', '3v3') and p_mode not in ('normal', 'crazy', 'terminal') then raise exception 'invalid_mode'; end if;
  if p_cases is null or cardinality(p_cases) not between 1 and 20 then raise exception 'invalid_cases'; end if;
  cost := public.battle_cost(p_cases);
  if cost is null then raise exception 'invalid_cases'; end if;
  if (select count(*) from public.live_battles where creator = uid and status = 'waiting') >= 3 then raise exception 'too_many_open'; end if;
  perform public.wallet_gate(uid, cost);
  bal := public.wallet_debit(uid, cost, 'bet', null, true);

  seed := encode(gen_random_bytes(32), 'hex');
  seat_list := (select jsonb_agg('null'::jsonb) from generate_series(1, n));
  seat_list := jsonb_set(seat_list, '{0}', jsonb_build_object('uid', uid, 'name', prof.display_name, 'bot', false));
  insert into public.live_battles (creator, case_ids, format, mode, seats, player_ids, server_hash, client_seed)
  values (uid, p_cases, p_format, p_mode, seat_list, array[uid], encode(digest(seed, 'sha256'), 'hex'), encode(gen_random_bytes(8), 'hex'))
  returning * into r;
  insert into public.live_battle_secrets (battle_id, server_seed) values (r.id, seed);
  return to_jsonb(r) || jsonb_build_object('balance', bal);
end $$;

create or replace function public.join_live_battle(p_id uuid, p_seat integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; r public.live_battles; n integer; i integer; free integer; cost numeric;
begin
  perform public.site_guard('battles');
  prof := public.live_player(uid);
  perform public.live_reap();
  select * into r from public.live_battles where id = p_id for update;
  if not found then raise exception 'battle_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'battle_not_open'; end if;
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
  cost := public.battle_cost(r.case_ids);
  perform public.wallet_gate(uid, cost);
  perform public.wallet_debit(uid, cost, 'bet', null, true);
  update public.live_battles
     set seats = jsonb_set(seats, array[free::text], jsonb_build_object('uid', uid, 'name', prof.display_name, 'bot', false)),
         player_ids = player_ids || uid
   where id = p_id;
  perform public.live_battle_maybe_start(p_id);
  return (select to_jsonb(b) from public.live_battles b where b.id = p_id) || jsonb_build_object('balance', (select balance from public.wallets where user_id = uid));
end $$;

create or replace function public.call_live_bot(p_id uuid, p_seat integer, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_battles; n integer;
begin
  perform public.site_guard('battles');
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

-- Leave a battle that has not started and get the cost back. The creator leaving cancels it for everyone and refunds every real player.
create or replace function public.leave_live_battle(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_battles; i integer; cost numeric; u uuid;
begin
  perform public.live_player(uid);
  select * into r from public.live_battles where id = p_id for update;
  if not found then raise exception 'battle_not_found'; end if;
  if r.status <> 'waiting' then raise exception 'already_started'; end if;
  cost := public.battle_cost(r.case_ids);
  if uid = r.creator then
    update public.live_battles set status = 'cancelled' where id = p_id;
    foreach u in array r.player_ids loop perform public.wallet_credit(u, cost, 'refund'); end loop;
  elsif uid = any (r.player_ids) then
    for i in 0 .. jsonb_array_length(r.seats) - 1 loop
      if r.seats -> i ->> 'uid' = uid::text then
        update public.live_battles set seats = jsonb_set(seats, array[i::text], 'null'::jsonb), player_ids = array_remove(player_ids, uid) where id = p_id;
        perform public.wallet_credit(uid, cost, 'refund');
        exit;
      end if;
    end loop;
  else
    raise exception 'not_in_battle';
  end if;
  return (select to_jsonb(b) from public.live_battles b where b.id = p_id) || jsonb_build_object('balance', (select balance from public.wallets where user_id = uid));
end $$;

-- ============================ crash and double ==============================================================================
create or replace function public.crash_place_bet(p_round bigint, p_amount numeric, p_auto numeric default null, p_anon boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets; bal numeric;
begin
  perform public.site_guard('crash');
  perform public.live_player(uid);
  r := public.advance_round_internal('crash');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if p_auto is not null and (p_auto < 1.01 or p_auto > 1000 or p_auto <> round(p_auto, 2)) then raise exception 'invalid_target'; end if;
  if exists (select 1 from public.round_bets where round_id = r.id and user_id = uid) then raise exception 'already_bet'; end if;
  perform public.wallet_gate(uid, p_amount);
  bal := public.wallet_debit(uid, p_amount, 'bet', null, true);
  insert into public.round_bets (round_id, user_id, display_name, amount, auto_cashout, riding)
  values (r.id, uid, public.round_name(uid, p_anon), p_amount, p_auto, p_amount) returning * into b;
  return to_jsonb(b) || jsonb_build_object('balance', bal);
end $$;

create or replace function public.crash_cancel_bet(p_round bigint) returns numeric language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; amt numeric;
begin
  perform public.live_player(uid);
  r := public.advance_round_internal('crash');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  delete from public.round_bets where round_id = r.id and user_id = uid returning amount into amt;
  if amt is null then raise exception 'no_bet'; end if;
  perform public.wallet_credit(uid, amt, 'refund');
  return amt;
end $$;

create or replace function public.crash_cashout(p_round bigint, p_frac numeric default 1) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets; ms double precision; mult numeric; take numeric; got numeric; bal numeric; frac numeric := least(1, greatest(0.01, coalesce(p_frac, 1)));
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
  bal := public.wallet_credit(uid, got, 'win', null, true);
  return jsonb_build_object('mult', mult, 'take', take, 'got', got, 'riding', b.riding, 'locked', b.locked, 'done', b.done, 'bet', to_jsonb(b), 'balance', bal);
end $$;

create or replace function public.double_place_bet(p_round bigint, p_lane text, p_amount numeric, p_anon boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.game_rounds; b public.round_bets; bal numeric;
begin
  perform public.site_guard('double');
  perform public.live_player(uid);
  r := public.advance_round_internal('double');
  if r.id <> p_round or r.status <> 'betting' or now() >= r.betting_ends_at then raise exception 'betting_closed'; end if;
  if p_lane is null or p_lane not in ('purple', 'gray', 'green', 'bait') then raise exception 'invalid_lane'; end if;
  if p_amount is null or p_amount < 0.10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if exists (select 1 from public.round_bets where round_id = r.id and user_id = uid and lane = case p_lane when 'purple' then 'gray' when 'gray' then 'purple' else '-' end) then
    raise exception 'both_sides';
  end if;
  perform public.wallet_gate(uid, p_amount);
  bal := public.wallet_debit(uid, p_amount, 'bet', null, true);
  insert into public.round_bets (round_id, user_id, display_name, lane, amount, riding)
  values (r.id, uid, public.round_name(uid, p_anon), p_lane, p_amount, p_amount)
  on conflict (round_id, user_id, lane) do update set amount = public.round_bets.amount + excluded.amount, riding = public.round_bets.riding + excluded.riding
  returning * into b;
  return to_jsonb(b) || jsonb_build_object('balance', bal);
end $$;

-- The clock. Same as 0005 except that finishing a round now PAYS: auto cash-outs (crash) and winning lanes (double) are credited, and every bet of the
-- round is written to the bets table (history, race, loss limits). One bad account cannot block the others.
create or replace function public.advance_round_internal(p_game text) returns public.game_rounds
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare r public.game_rounds; seed text; f double precision; cp numeric; n integer; crash_at timestamptz; roll_end timestamptz; b public.round_bets; got numeric;
begin
  if p_game is null or p_game not in ('crash', 'double') then raise exception 'invalid_game'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rounds:' || p_game, 0));
  select * into r from public.game_rounds where game = p_game order by id desc limit 1;

  if not found or (r.status = 'finished' and now() >= r.finished_at + make_interval(secs => public.round_cooldown_ms(p_game) / 1000.0)) then
    delete from public.game_rounds where game = p_game and created_at < now() - interval '3 days';
    seed := encode(gen_random_bytes(32), 'hex');
    insert into public.game_rounds (game, betting_ends_at, server_hash)
    values (p_game, now() + make_interval(secs => public.round_bet_ms(p_game) / 1000.0), encode(digest(seed, 'sha256'), 'hex')) returning * into r;
    insert into public.game_round_secrets (round_id, server_seed) values (r.id, seed);
    return r;
  end if;

  select server_seed into seed from public.game_round_secrets where round_id = r.id;

  if r.status = 'betting' and now() >= r.betting_ends_at then
    if p_game = 'double' then
      n := floor(public.round_float(seed, r.id) * 15)::integer;
      update public.game_rounds set status = 'running', result = jsonb_build_object('n', n) where id = r.id returning * into r;
    else
      update public.game_rounds set status = 'running' where id = r.id returning * into r;
    end if;
  end if;

  if r.status = 'running' then
    if p_game = 'crash' then
      cp := public.crash_point_of(public.round_float(seed, r.id));
      crash_at := r.betting_ends_at + make_interval(secs => ln(cp::double precision) / 0.00012 / 1000.0);
      if now() >= crash_at then
        for b in select * from public.round_bets where round_id = r.id and not done and auto_cashout is not null and auto_cashout < cp for update loop
          got := round(b.riding * b.auto_cashout, 2);
          update public.round_bets set locked = locked + got, riding = 0, cashouts = cashouts || to_jsonb(auto_cashout), done = true where id = b.id;
          begin perform public.wallet_credit(b.user_id, got, 'win', null, true); exception when others then null; end;
        end loop;
        update public.round_bets set done = true where round_id = r.id and not done;                    -- everyone else is busted
        update public.game_rounds set status = 'finished', finished_at = crash_at, result = jsonb_build_object('point', cp) where id = r.id returning * into r;
        for b in select * from public.round_bets where round_id = r.id loop
          begin perform public.bet_record(b.user_id, 'crash', b.amount, b.locked, null, jsonb_build_object('round', r.id), jsonb_build_object('point', cp, 'cashouts', b.cashouts)); exception when others then null; end;
        end loop;
      end if;
    else
      roll_end := r.betting_ends_at + interval '5200 milliseconds';
      if now() >= roll_end then
        n := (r.result ->> 'n')::integer;
        for b in select * from public.round_bets where round_id = r.id and not done for update loop
          got := case when public.double_lane_wins(b.lane, n) then round(b.amount * public.double_lane_pay(b.lane), 2) else 0 end;
          update public.round_bets set done = true, locked = got where id = b.id;
          begin
            if got > 0 then perform public.wallet_credit(b.user_id, got, 'win', null, true); end if;
            perform public.bet_record(b.user_id, 'double', b.amount, got, null, jsonb_build_object('round', r.id, 'lane', b.lane), jsonb_build_object('n', n));
          exception when others then null; end;
        end loop;
        update public.game_rounds set status = 'finished', finished_at = roll_end where id = r.id returning * into r;
      end if;
    end if;
  end if;

  if r.status = 'finished' and now() >= r.finished_at + make_interval(secs => public.round_cooldown_ms(p_game) / 1000.0) then
    seed := encode(gen_random_bytes(32), 'hex');
    insert into public.game_rounds (game, betting_ends_at, server_hash)
    values (p_game, now() + make_interval(secs => public.round_bet_ms(p_game) / 1000.0), encode(digest(seed, 'sha256'), 'hex')) returning * into r;
    insert into public.game_round_secrets (round_id, server_seed) values (r.id, seed);
  end if;
  return r;
end $$;

-- ============================ privileges ====================================================================================
revoke execute on function public.battle_cost(text[]), public.battle_best(numeric[], boolean), public.battle_tie(integer[], double precision),
  public.battle_outcome(text, text, numeric[], double precision), public.live_reap(), public.coinflip_settle(bigint), public.live_battle_settle(uuid) from public, anon, authenticated;
