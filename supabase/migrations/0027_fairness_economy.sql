-- Vaultrush 0027: admin step F, part 2: the fairness audit and the economy monitor. Run after 0026. Running it again changes nothing.
-- Both are read-only: nothing here changes a balance, a game or a setting.
--
--   * Fairness audit (fairness.view to see, fairness.run to run): every finished Crash and Double round, every finished coinflip, every started
--     battle and every revealed personal seed pair in a window is checked again: does the revealed seed match the hash published before the game,
--     and (rounds and coinflips) does the seed give the result that was recorded? Each run is stored with who ran it and anything that did not
--     match. (Shared rounds are kept for 3 days, so a longer window checks the other kinds further back. A battle's pulls are not recomputed
--     here, only its seed; a player can re-check a battle on the Fairness page.)
--   * Economy monitor (economy.view): coins in wallets and items, where coins came from and where they went (by ledger kind), what each game
--     took against what its maths says it should take, the biggest balances and wins, and a day-by-day picture.

-- ============================ fairness audit =====================================================================================
create table if not exists public.fairness_runs (
  id         bigint generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  ran_by     uuid,
  days       integer not null,
  summary    jsonb not null,
  mismatches jsonb not null default '[]'
);
alter table public.fairness_runs enable row level security;
revoke all on public.fairness_runs from anon, authenticated;

create or replace function public.fairness_check(p_days integer) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare since timestamptz := now() - make_interval(days => p_days); bad jsonb := '[]'; r record; f double precision; res text; n_r integer := 0; n_c integer := 0; n_b integer := 0; n_s integer := 0;
        bad_r integer := 0; bad_c integer := 0; bad_b integer := 0; bad_s integer := 0; seed text; ok_hash boolean; ok_res boolean;
begin
  -- Crash and Double rounds
  for r in select g.*, s.server_seed from public.game_rounds g join public.game_round_secrets s on s.round_id = g.id where g.status = 'finished' and g.finished_at >= since loop
    n_r := n_r + 1;
    ok_hash := encode(digest(r.server_seed, 'sha256'), 'hex') = r.server_hash;
    f := public.round_float(r.server_seed, r.id);
    ok_res := case when r.game = 'crash' then (r.result ->> 'point')::numeric = public.crash_point_of(f) else (r.result ->> 'n')::integer = floor(f * 15)::integer end;
    if not (ok_hash and coalesce(ok_res, false)) then
      bad_r := bad_r + 1;
      if jsonb_array_length(bad) < 100 then bad := bad || jsonb_build_object('kind', r.game, 'id', r.id::text, 'hash_ok', ok_hash, 'result_ok', coalesce(ok_res, false)); end if;
    end if;
  end loop;
  -- coinflips: the side is the first 32 bits of HMAC-SHA256(seed, "<id>:0:0") / 2^32, bolt below 0.5
  for r in select c.*, s.server_seed from public.live_coinflips c join public.live_coinflip_secrets s on s.flip_id = c.id where c.status = 'done' and c.finished_at >= since loop
    n_c := n_c + 1;
    ok_hash := encode(digest(r.server_seed, 'sha256'), 'hex') = r.server_hash;
    f := (('x' || substr(encode(hmac(r.id::text || ':0:0', r.server_seed, 'sha256'), 'hex'), 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
    res := case when f < 0.5 then 'bolt' else 'star' end;
    ok_res := res = r.result;
    if not (ok_hash and ok_res) then
      bad_c := bad_c + 1;
      if jsonb_array_length(bad) < 100 then bad := bad || jsonb_build_object('kind', 'coinflip', 'id', r.id::text, 'hash_ok', ok_hash, 'result_ok', ok_res); end if;
    end if;
  end loop;
  -- battles: the seed matches its published hash
  for r in select b.id, b.server_hash, s.server_seed from public.live_battles b join public.live_battle_secrets s on s.battle_id = b.id where b.status = 'running' and b.started_at >= since loop
    n_b := n_b + 1;
    if encode(digest(r.server_seed, 'sha256'), 'hex') <> r.server_hash then
      bad_b := bad_b + 1;
      if jsonb_array_length(bad) < 100 then bad := bad || jsonb_build_object('kind', 'battle', 'id', r.id::text, 'hash_ok', false, 'result_ok', null); end if;
    end if;
  end loop;
  -- personal seed pairs revealed in the window
  for r in select id, server_seed, server_hash from public.seed_pairs where status = 'revealed' and revealed_at >= since loop
    n_s := n_s + 1;
    if encode(digest(r.server_seed, 'sha256'), 'hex') <> r.server_hash then
      bad_s := bad_s + 1;
      if jsonb_array_length(bad) < 100 then bad := bad || jsonb_build_object('kind', 'seed', 'id', r.id::text, 'hash_ok', false, 'result_ok', null); end if;
    end if;
  end loop;
  return jsonb_build_object('summary', jsonb_build_object('rounds', jsonb_build_object('checked', n_r, 'bad', bad_r), 'coinflips', jsonb_build_object('checked', n_c, 'bad', bad_c),
                                                          'battles', jsonb_build_object('checked', n_b, 'bad', bad_b), 'seeds', jsonb_build_object('checked', n_s, 'bad', bad_s),
                                                          'all_ok', bad_r + bad_c + bad_b + bad_s = 0),
                            'mismatches', bad);
end $$;

create or replace function public.admin_fairness_run(p_days integer default 3) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('fairness.run'); d integer := least(greatest(coalesce(p_days, 3), 1), 90); res jsonb; rid bigint;
begin
  res := public.fairness_check(d);
  insert into public.fairness_runs (ran_by, days, summary, mismatches) values (uid, d, res -> 'summary', res -> 'mismatches') returning id into rid;
  return res || jsonb_build_object('id', rid, 'days', d);
end $$;

create or replace function public.admin_fairness_runs() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('fairness.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'at', f.ran_at, 'by', (select display_name from public.profiles p where p.id = f.ran_by), 'days', f.days,
            'summary', f.summary, 'mismatches', f.mismatches) order by f.id desc) from (select * from public.fairness_runs order by id desc limit 50) f), '[]'::jsonb);
end $$;

-- ============================ economy monitor =====================================================================================
-- The return each game's maths gives, as a share of the stake (cases and battles depend on the cases, computed per bet below).
create or replace function public.game_expected_return(p_game text) returns numeric language sql immutable as $$
  select case p_game when 'crash' then 0.97 when 'double' then round(14.0 / 15, 4) when 'upgrade' then 0.95 when 'plinko' then 0.97 when 'mines' then 0.97 when 'coinflip' then 0.97 end
$$;

create or replace function public.admin_economy(p_days integer default 30) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('economy.view'); d integer := least(greatest(coalesce(p_days, 30), 1), 90); since timestamptz := public.rg_day_start(least(greatest(coalesce(p_days, 30), 1), 90) - 1);
begin
  return jsonb_build_object(
    'days', d,
    'now', jsonb_build_object(
      'coins', (select coalesce(sum(balance), 0) from public.wallets),
      'wallets_with_coins', (select count(*) from public.wallets where balance > 0),
      'median_balance', (select coalesce(percentile_cont(0.5) within group (order by balance), 0) from public.wallets where balance > 0),
      'items', (select count(*) from public.inventory), 'items_value', (select coalesce(sum(i.value), 0) from public.inventory v join public.catalog_items i on i.id = v.item_id),
      'top', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'balance', w.balance) order by w.balance desc)
                       from (select * from public.wallets order by balance desc limit 10) w join public.profiles p on p.id = w.user_id), '[]'::jsonb)),
    -- every coin that moved, by kind: free sources (faucet, rewards, events, adjustments) and the games' side (bets, wins, sales, refunds)
    'flows', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'count', n, 'sum', s) order by kind)
                       from (select kind, count(*) as n, sum(amount) as s from public.ledger where created_at >= since group by kind) k), '[]'::jsonb),
    -- what each game took: staked minus paid back, against the return its maths gives
    'games', coalesce((select jsonb_agg(jsonb_build_object('game', game, 'bets', n, 'staked', staked, 'paid', paid, 'take', staked - paid,
                         'return', case when staked > 0 then round(paid / staked, 4) end, 'expected', case when staked > 0 then round(exp_paid / staked, 4) end) order by staked desc)
                       from (select b.game, count(*) as n, sum(b.amount) as staked, sum(b.payout) as paid,
                                    sum(b.amount * coalesce(public.game_expected_return(b.game),
                                      case when b.game = 'cases' then (select public.catalog_case_ev(c.id) / nullif(c.price, 0) from public.catalog_cases c where c.id = b.params ->> 'case')
                                           when b.game = 'battles' then (select sum(public.catalog_case_ev(x.id)) / nullif(sum(c.price), 0) from jsonb_array_elements_text(b.params -> 'cases') x(id) join public.catalog_cases c on c.id = x.id) end,
                                      1)) as exp_paid
                               from public.bets b where b.amount > 0 and b.created_at >= since group by b.game) g), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', dd::date,
                         'free', (select coalesce(sum(amount), 0) from public.ledger l where l.created_at >= dd and l.created_at < dd + interval '1 day' and l.kind in ('bonus', 'faucet', 'rakeback', 'calendar', 'promo', 'race', 'rain', 'giveaway', 'crate')),
                         'adjust', (select coalesce(sum(amount), 0) from public.ledger l where l.created_at >= dd and l.created_at < dd + interval '1 day' and l.kind = 'adjustment'),
                         'games', (select coalesce(sum(amount), 0) from public.ledger l where l.created_at >= dd and l.created_at < dd + interval '1 day' and l.kind in ('bet', 'win', 'sell', 'refund'))) order by dd)
                       from generate_series(since, public.rg_day_start(0), interval '1 day') dd), '[]'::jsonb),
    'big_wins', coalesce((select jsonb_agg(jsonb_build_object('name', p.display_name, 'game', b.game, 'amount', b.amount, 'payout', b.payout, 'at', b.created_at) order by b.payout - b.amount desc)
                          from (select * from public.bets where created_at >= since and payout > amount order by payout - amount desc limit 10) b join public.profiles p on p.id = b.user_id), '[]'::jsonb));
end $$;

-- ============================ privileges ==========================================================================================
revoke execute on function public.fairness_check(integer), public.game_expected_return(text) from public, anon, authenticated;
revoke execute on function public.admin_fairness_run(integer), public.admin_fairness_runs(), public.admin_economy(integer) from public, anon;
grant execute on function public.admin_fairness_run(integer), public.admin_fairness_runs(), public.admin_economy(integer) to authenticated;
