-- Vaultrush 0010: Cases, Upgrade, Plinko and Mines on the server. Run after 0009_catalogue.sql.
--
-- Every game here works the same way, inside ONE database transaction: check the site switch and the responsible-gambling gate, draw the result from the
-- player's secret seed (the seed never leaves the database), record the bet, move the coins and items, return the result. If anything fails the whole
-- thing is undone, so a stake is never taken without a result and a result is never given without a stake.
-- The math is the same as src/fair.ts and src/data.ts (the tests compare them): case tickets out of 100,000, upgrade chance 95% x stake / target
-- (max 80%), plinko tables with a 97% return, mines with a 97% return.

-- ============================ Cases ======================================================================================
-- Open 1 to 10 cases. One nonce per case (consecutive, like the reference sites). Items go straight into the inventory.
create function public.open_cases(p_case text, p_count integer, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); c public.catalog_cases; total numeric; fair public.fair_t; i integer; ticket integer; item_id text; val numeric;
  opened jsonb := '[]'::jsonb; first_bet bigint; bet_id bigint; inv uuid; bal numeric;
begin
  perform public.site_guard('cases');
  perform public.live_player(uid);
  select * into c from public.catalog_cases where id = p_case and active and not reward;
  if not found then raise exception 'case_not_found'; end if;
  if p_count is null or p_count not between 1 and 10 then raise exception 'invalid_count'; end if;
  if p_idem is not null and exists (select 1 from public.bets where user_id = uid and idem_key = p_idem || ':1') then raise exception 'duplicate_request'; end if;
  total := round(c.price * p_count, 2);
  perform public.wallet_gate(uid, total);
  for i in 1..p_count loop
    fair := public.fair_draw(uid, 1);
    ticket := floor(fair.floats[1] * 100000)::integer;
    select e.item_id, it.value into item_id, val from public.catalog_case_entries e join public.catalog_items it on it.id = e.item_id
     where e.case_id = c.id and ticket between e.ticket_from and e.ticket_to;
    if item_id is null then raise exception 'catalogue_gap'; end if;
    bet_id := public.bet_record(uid, 'cases', c.price, val, fair, jsonb_build_object('case', c.id), jsonb_build_object('ticket', ticket, 'item', item_id, 'value', val),
                                case when p_idem is not null then p_idem || ':' || i end);
    first_bet := coalesce(first_bet, bet_id);
    inv := public.inventory_add(uid, item_id, c.name);
    opened := opened || jsonb_build_object('uid', inv, 'item', item_id, 'ticket', ticket, 'value', val, 'nonce', fair.nonce, 'bet_id', bet_id);
  end loop;
  bal := public.wallet_debit(uid, total, 'bet', first_bet, true);
  return jsonb_build_object('balance', bal, 'cost', total, 'opened', opened);
end $$;

-- ============================ Upgrade ====================================================================================
-- Stake up to 4 of your items and/or coins for a chance at a more valuable item. Chance = 95% x stake / target, at most 80%.
-- "under" wins when the roll is below the chance, "over" when it is above 1 - chance (same odds).
create function public.upgrade_item(p_uids uuid[], p_coins numeric, p_target text, p_over boolean default false, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); coins numeric := coalesce(p_coins, 0); n_items integer := 0; items_value numeric := 0; want integer := 0; stake numeric;
  t public.catalog_items; chance double precision; fair public.fair_t; f double precision; won boolean; payout numeric; bet_id bigint; bal numeric; got uuid;
  from_item text;
begin
  perform public.site_guard('upgrade');
  perform public.live_player(uid);
  if coins < 0 or coins <> round(coins, 2) then raise exception 'invalid_amount'; end if;
  if p_uids is not null then select count(distinct x) into want from unnest(p_uids) x; end if;
  if want > 4 then raise exception 'too_many_items'; end if;
  if want > 0 then
    select count(*), coalesce(sum(it.value), 0) into n_items, items_value
      from (select i.item_id from public.inventory i where i.user_id = uid and i.id = any (p_uids) for update) s join public.catalog_items it on it.id = s.item_id;
    if n_items <> want then raise exception 'item_not_found'; end if;
    select i.item_id into from_item from public.inventory i join public.catalog_items it on it.id = i.item_id where i.user_id = uid and i.id = any (p_uids) order by it.value desc limit 1;
  end if;
  stake := items_value + coins;
  if stake <= 0 then raise exception 'invalid_amount'; end if;
  select * into t from public.catalog_items where id = p_target and active;
  if not found then raise exception 'unknown_item'; end if;
  if t.value <= stake * 1.05 then raise exception 'target_too_low'; end if;
  if p_idem is not null and exists (select 1 from public.bets where user_id = uid and idem_key = p_idem) then raise exception 'duplicate_request'; end if;
  if coins > 0 then perform public.wallet_gate(uid, coins); end if;

  chance := least(0.8::double precision, (stake / t.value)::double precision * 0.95);
  fair := public.fair_draw(uid, 1);
  f := fair.floats[1];
  won := case when coalesce(p_over, false) then f > 1 - chance else f < chance end;
  payout := case when won then t.value else 0 end;
  if want > 0 then delete from public.inventory where user_id = uid and id = any (p_uids); end if;
  bet_id := public.bet_record(uid, 'upgrade', stake, payout, fair,
    jsonb_build_object('target', t.id, 'over', coalesce(p_over, false), 'items', want, 'coins', coins),
    jsonb_build_object('roll', f, 'chance', chance, 'win', won), p_idem);
  if coins > 0 then bal := public.wallet_debit(uid, coins, 'bet', bet_id, true); else bal := (select balance from public.wallets where user_id = uid); end if;
  if won then got := public.inventory_add(uid, t.id, 'Upgrade'); end if;
  return jsonb_build_object('balance', bal, 'win', won, 'roll', f, 'chance', chance, 'stake', stake, 'item', t.id, 'uid', got, 'from_item', from_item, 'nonce', fair.nonce, 'bet_id', bet_id);
end $$;

-- ============================ Plinko =====================================================================================
-- Multiplier table: bucket k of `rows` rows pays raw_k / ev * 0.97, where raw_k = base ^ (|k - rows/2| * (12/rows) * 1.1) and ev is the average of raw_k.
-- Same operations in the same order as plinkoTable() in src/fair.ts, so the numbers match to the last digit.
create function public.plinko_table(p_rows integer, p_risk text) returns numeric[] language plpgsql immutable as $$
declare base double precision; n integer := p_rows; k integer; i integer; c double precision; p double precision[] := '{}'; raw double precision[] := '{}'; ev double precision := 0; m double precision; out numeric[] := '{}';
begin
  base := case p_risk when 'low' then 1.18 when 'normal' then 1.42 when 'high' then 1.85 else null end;
  if base is null or p_rows not in (8, 10, 12, 14, 16) then raise exception 'invalid_game'; end if;
  for k in 0..n loop
    c := 1; for i in 1..k loop c := (c * (n - k + i)) / i; end loop;
    p := p || (c / power(2::double precision, n));
    raw := raw || power(base, abs(k - n / 2.0) * (12.0 / n) * 1.1);
  end loop;
  for k in 0..n loop ev := ev + raw[k + 1] * p[k + 1]; end loop;
  for k in 0..n loop
    m := (raw[k + 1] / ev) * 0.97;
    out := out || (case when m >= 10 then floor(m + 0.5) else floor(m * 100 + 0.5) / 100 end)::numeric;
  end loop;
  return out;
end $$;

-- Drop one ball. Each row the ball goes right when its float is at least 0.5; the bucket is the number of rights. The result is final the moment
-- this returns (the page then animates it and shows the payout when the ball lands).
create function public.plinko_drop(p_rows integer, p_risk text, p_amount numeric, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); fair public.fair_t; tbl numeric[]; path integer[] := '{}'; bucket integer := 0; i integer; mult numeric; payout numeric; bet_id bigint; bal numeric;
begin
  perform public.site_guard('plinko');
  perform public.live_player(uid);
  if p_amount is null or p_amount < 0.10 then raise exception 'invalid_amount'; end if;
  tbl := public.plinko_table(p_rows, p_risk);
  if p_idem is not null and exists (select 1 from public.bets where user_id = uid and idem_key = p_idem) then raise exception 'duplicate_request'; end if;
  perform public.wallet_gate(uid, p_amount);
  fair := public.fair_draw(uid, p_rows);
  for i in 1..p_rows loop
    path := path || case when fair.floats[i] >= 0.5 then 1 else 0 end;
    bucket := bucket + path[i];
  end loop;
  mult := tbl[bucket + 1];
  payout := round(p_amount * mult, 2);
  bet_id := public.bet_record(uid, 'plinko', p_amount, payout, fair, jsonb_build_object('rows', p_rows, 'risk', p_risk), jsonb_build_object('bucket', bucket, 'mult', mult, 'path', path), p_idem);
  bal := public.wallet_debit(uid, p_amount, 'bet', bet_id, true);
  if payout > 0 then bal := public.wallet_credit(uid, payout, 'win', bet_id, true); end if;
  return jsonb_build_object('balance', bal, 'payout', payout, 'mult', mult, 'bucket', bucket, 'path', to_jsonb(path), 'nonce', fair.nonce, 'bet_id', bet_id);
end $$;

-- ============================ Mines ======================================================================================
create table public.mines_games (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  amount      numeric(12, 2) not null check (amount > 0),
  grid        integer not null check (grid in (16, 25, 36, 49, 64)),
  mines       integer not null,
  picks       integer[] not null default '{}',
  status      text not null default 'active' check (status in ('active', 'won', 'lost', 'cancelled')),
  seed_id     bigint references public.seed_pairs (id),
  nonce       integer,
  client_seed text,
  server_hash text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index mines_one_active on public.mines_games (user_id) where status = 'active';
create table public.mines_secrets (game_id bigint primary key references public.mines_games (id) on delete cascade, bombs integer[] not null);
alter table public.mines_games   enable row level security;
alter table public.mines_secrets enable row level security;
create policy mines_own on public.mines_games for select to authenticated using (user_id = auth.uid());
revoke all on public.mines_games, public.mines_secrets from anon, authenticated;
grant select on public.mines_games to authenticated;

-- Same operations in the same order as minesMultiplier() in src/fair.ts.
create function public.mines_multiplier(p_mines integer, p_picks integer, p_n integer) returns numeric language plpgsql immutable as $$
declare m double precision := 0.97; i integer;
begin
  for i in 0..p_picks - 1 loop m := m * ((p_n - i)::double precision / (p_n - p_mines - i)::double precision); end loop;
  return (floor(m * 100) / 100)::numeric;
end $$;

-- Fisher-Yates over the tiles using (n - 1) floats, like minePositions() in src/fair.ts. Tiles are numbered from 0.
create function public.mine_positions(p_floats double precision[], p_mines integer, p_n integer) returns integer[] language plpgsql immutable as $$
declare tiles integer[] := array(select generate_series(0, p_n - 1)); i integer; j integer; tmp integer;
begin
  for i in reverse p_n - 1..1 loop
    j := floor(p_floats[p_n - i] * (i + 1))::integer;
    tmp := tiles[i + 1]; tiles[i + 1] := tiles[j + 1]; tiles[j + 1] := tmp;
  end loop;
  return tiles[1:p_mines];
end $$;

-- Finish a game: pay (when won), write the bet, reveal the bombs. Internal.
create function public.mines_finish(g public.mines_games, p_status text, p_payout numeric) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare bombs integer[]; bet_id bigint; bal numeric; fair public.fair_t;
begin
  select s.bombs into bombs from public.mines_secrets s where s.game_id = g.id;
  fair := row(g.seed_id, g.nonce, g.client_seed, g.server_hash, null)::public.fair_t;
  bet_id := public.bet_record(g.user_id, 'mines', g.amount, p_payout, fair, jsonb_build_object('grid', g.grid, 'mines', g.mines),
    jsonb_build_object('bombs', (select jsonb_agg(b + 1 order by b) from unnest(bombs) b), 'picks', (select coalesce(jsonb_agg(p + 1), '[]'::jsonb) from unnest(g.picks) p), 'outcome', p_status));
  if p_payout > 0 then bal := public.wallet_credit(g.user_id, p_payout, 'win', bet_id, true); else bal := (select balance from public.wallets where user_id = g.user_id); end if;
  update public.mines_games set status = p_status, finished_at = now() where id = g.id;
  return jsonb_build_object('balance', bal, 'payout', p_payout, 'bombs', (select jsonb_agg(b order by b) from unnest(bombs) b), 'status', p_status, 'bet_id', bet_id, 'picks', to_jsonb(g.picks));
end $$;

-- A game left open for a day is settled for the player: cashed out if a tile was picked, refunded if not.
create function public.mines_settle_stale(p_uid uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.mines_games;
begin
  for g in select * from public.mines_games where user_id = p_uid and status = 'active' and created_at < now() - interval '1 day' for update loop
    if cardinality(g.picks) > 0 then perform public.mines_finish(g, 'won', round(g.amount * public.mines_multiplier(g.mines, cardinality(g.picks), g.grid), 2));
    else perform public.wallet_credit(p_uid, g.amount, 'refund'); update public.mines_games set status = 'cancelled', finished_at = now() where id = g.id; end if;
  end loop;
end $$;

create function public.mines_start(p_amount numeric, p_grid integer, p_mines integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); fair public.fair_t; g public.mines_games; bal numeric;
begin
  perform public.site_guard('mines');
  perform public.live_player(uid);
  perform public.mines_settle_stale(uid);
  if p_amount is null or p_amount < 0.10 then raise exception 'invalid_amount'; end if;
  if p_grid is null or p_grid not in (16, 25, 36, 49, 64) or p_mines is null or p_mines < 1 or p_mines > p_grid - 1 then raise exception 'invalid_game'; end if;
  if exists (select 1 from public.mines_games where user_id = uid and status = 'active') then raise exception 'game_in_progress'; end if;
  perform public.wallet_gate(uid, p_amount);
  fair := public.fair_draw(uid, p_grid - 1);
  insert into public.mines_games (user_id, amount, grid, mines, seed_id, nonce, client_seed, server_hash)
  values (uid, p_amount, p_grid, p_mines, fair.seed_id, fair.nonce, fair.client_seed, fair.server_hash) returning * into g;
  insert into public.mines_secrets (game_id, bombs) values (g.id, public.mine_positions(fair.floats, p_mines, p_grid));
  bal := public.wallet_debit(uid, p_amount, 'bet', null, true);
  return jsonb_build_object('game', g.id, 'balance', bal, 'amount', g.amount, 'grid', g.grid, 'mines', g.mines, 'nonce', fair.nonce, 'server_hash', fair.server_hash);
end $$;

-- Reveal one tile. A bomb ends the game (and reveals every bomb). Revealing every safe tile cashes out automatically.
create function public.mines_pick(p_game bigint, p_tile integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.mines_games; bombs integer[]; n integer; mult numeric; fin jsonb;
begin
  perform public.live_player(uid);
  select * into g from public.mines_games where id = p_game and user_id = uid for update;
  if not found then raise exception 'game_not_found'; end if;
  if g.status <> 'active' then raise exception 'game_over'; end if;
  if p_tile is null or p_tile < 0 or p_tile >= g.grid or p_tile = any (g.picks) then raise exception 'invalid_tile'; end if;
  select s.bombs into bombs from public.mines_secrets s where s.game_id = g.id;
  if p_tile = any (bombs) then
    fin := public.mines_finish(g, 'lost', 0);
    return fin || jsonb_build_object('bomb', true, 'tile', p_tile);
  end if;
  update public.mines_games set picks = picks || p_tile where id = g.id returning * into g;
  n := cardinality(g.picks);
  mult := public.mines_multiplier(g.mines, n, g.grid);
  if n = g.grid - g.mines then
    fin := public.mines_finish(g, 'won', round(g.amount * mult, 2));
    return fin || jsonb_build_object('bomb', false, 'tile', p_tile, 'mult', mult, 'done', true);
  end if;
  return jsonb_build_object('bomb', false, 'tile', p_tile, 'picks', to_jsonb(g.picks), 'mult', mult, 'next', public.mines_multiplier(g.mines, n + 1, g.grid), 'done', false);
end $$;

create function public.mines_cashout(p_game bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.mines_games; mult numeric;
begin
  perform public.live_player(uid);
  select * into g from public.mines_games where id = p_game and user_id = uid for update;
  if not found then raise exception 'game_not_found'; end if;
  if g.status <> 'active' then raise exception 'game_over'; end if;
  if cardinality(g.picks) = 0 then raise exception 'no_picks'; end if;
  mult := public.mines_multiplier(g.mines, cardinality(g.picks), g.grid);
  return public.mines_finish(g, 'won', round(g.amount * mult, 2)) || jsonb_build_object('mult', mult);
end $$;

-- Give the stake back when no tile was picked yet.
create function public.mines_cancel(p_game bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.mines_games; bal numeric;
begin
  perform public.live_player(uid);
  select * into g from public.mines_games where id = p_game and user_id = uid for update;
  if not found then raise exception 'game_not_found'; end if;
  if g.status <> 'active' then raise exception 'game_over'; end if;
  if cardinality(g.picks) > 0 then raise exception 'has_picks'; end if;
  bal := public.wallet_credit(uid, g.amount, 'refund');
  update public.mines_games set status = 'cancelled', finished_at = now() where id = g.id;
  return jsonb_build_object('balance', bal, 'status', 'cancelled');
end $$;

-- The game in progress (if any), so a reload or another device can carry on. Bombs are never included.
create function public.mines_active() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); g public.mines_games;
begin
  perform public.live_player(uid);
  perform public.mines_settle_stale(uid);
  select * into g from public.mines_games where user_id = uid and status = 'active';
  if not found then return null; end if;
  return jsonb_build_object('game', g.id, 'amount', g.amount, 'grid', g.grid, 'mines', g.mines, 'picks', to_jsonb(g.picks),
    'mult', case when cardinality(g.picks) > 0 then public.mines_multiplier(g.mines, cardinality(g.picks), g.grid) end);
end $$;

-- ============================ privileges ==================================================================================
revoke execute on function public.open_cases(text, integer, text), public.upgrade_item(uuid[], numeric, text, boolean, text), public.plinko_table(integer, text),
  public.plinko_drop(integer, text, numeric, text), public.mines_multiplier(integer, integer, integer), public.mine_positions(double precision[], integer, integer),
  public.mines_finish(public.mines_games, text, numeric), public.mines_settle_stale(uuid), public.mines_start(numeric, integer, integer), public.mines_pick(bigint, integer),
  public.mines_cashout(bigint), public.mines_cancel(bigint), public.mines_active() from public, anon, authenticated;
grant execute on function public.open_cases(text, integer, text), public.upgrade_item(uuid[], numeric, text, boolean, text), public.plinko_drop(integer, text, numeric, text),
  public.mines_start(numeric, integer, integer), public.mines_pick(bigint, integer), public.mines_cashout(bigint), public.mines_cancel(bigint), public.mines_active() to authenticated;
-- the multiplier tables are public maths: the page may read them
grant execute on function public.plinko_table(integer, text), public.mines_multiplier(integer, integer, integer) to authenticated;
