-- Vaultrush 0008: the SERVER WALLET (foundation). Run in the Supabase SQL editor after 0007_site_controls.sql.
--
-- From this migration on, coins and items live in the database, not in the browser:
--   * wallets.balance is the only balance; every change goes through wallet_debit() / wallet_credit() and writes a ledger row,
--   * inventory holds the items a player owns (one row per item),
--   * the catalogue (items, cases, drop tickets) is a table the server draws from,
--   * rewards state (rakeback pools, login streak, promo codes used, level keys, faucet timer) is per player in player_rewards.
-- The games themselves are in 0010 (Cases, Upgrade, Plinko, Mines) and 0011 (Battles, Coinflip, Crash, Double); rewards in 0012. The page
-- switches to the server wallet only when 0012 has been run (wallet_ready()), so running these in order never breaks the site.
-- New accounts start with 0 coins (they earn coins from the faucet, free crates, promo codes and rewards). Existing balances are left alone.

-- ============================ the catalogue ==============================================================================
create table public.catalog_items (
  id      text primary key,
  weapon  text not null,
  skin    text not null,
  type    text not null,
  rarity  text not null check (rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic')),
  value   numeric(12, 2) not null check (value >= 0),
  active  boolean not null default true
);
create table public.catalog_cases (
  id      text primary key,
  name    text not null,
  reward  boolean not null default false,          -- reward-only crates (daily, welcome) are never sold
  price   numeric(12, 2) not null check (price >= 0),
  active  boolean not null default true
);
create table public.catalog_case_entries (         -- the drop table: each item owns a range of the 100,000 tickets
  case_id     text not null references public.catalog_cases (id) on delete cascade,
  item_id     text not null references public.catalog_items (id),
  ticket_from integer not null check (ticket_from between 0 and 99999),
  ticket_to   integer not null check (ticket_to between 0 and 99999),
  primary key (case_id, item_id),
  check (ticket_to >= ticket_from)
);
create index catalog_entries_ticket on public.catalog_case_entries (case_id, ticket_from);
alter table public.catalog_items        enable row level security;
alter table public.catalog_cases        enable row level security;
alter table public.catalog_case_entries enable row level security;
create policy catalog_items_read   on public.catalog_items        for select to authenticated using (true);
create policy catalog_cases_read   on public.catalog_cases        for select to authenticated using (true);
create policy catalog_entries_read on public.catalog_case_entries for select to authenticated using (true);
revoke all on public.catalog_items, public.catalog_cases, public.catalog_case_entries from anon, authenticated;
grant select on public.catalog_items, public.catalog_cases, public.catalog_case_entries to authenticated;

-- ============================ inventory and rewards state =================================================================
create table public.inventory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  item_id    text not null references public.catalog_items (id),
  source     text not null default '',
  created_at timestamptz not null default now()
);
create index inventory_user on public.inventory (user_id, created_at desc);
alter table public.inventory enable row level security;
create policy inventory_own on public.inventory for select to authenticated using (user_id = auth.uid());
revoke all on public.inventory from anon, authenticated;
grant select on public.inventory to authenticated;

create table public.player_rewards (
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  rb_instant      numeric(14, 4) not null default 0,       -- rakeback pools: a share of every stake, claimed from the Rewards page
  rb_daily        numeric(14, 4) not null default 0,
  rb_weekly       numeric(14, 4) not null default 0,
  last_daily      timestamptz,
  last_weekly     timestamptz,
  calendar_streak integer not null default 0,
  calendar_last   date,
  promos          text[] not null default '{}',
  keys_used       integer[] not null default '{}',         -- level crates already opened
  faucet_at       timestamptz,
  race_paid       date                                      -- the last race day whose prize was paid
);
alter table public.player_rewards enable row level security;
create policy rewards_own on public.player_rewards for select to authenticated using (user_id = auth.uid());
revoke all on public.player_rewards from anon, authenticated;
grant select on public.player_rewards to authenticated;

-- more kinds of money movement in the ledger; bets of live games have no personal seed
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.ledger'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.ledger drop constraint %I', c);
  end loop;
end $$;
alter table public.ledger add constraint ledger_kind_check check (kind in
  ('bonus', 'bet', 'win', 'adjustment', 'sell', 'refund', 'faucet', 'rakeback', 'calendar', 'promo', 'race', 'crate'));
alter table public.bets alter column seed_id drop not null, alter column nonce drop not null, alter column client_seed drop not null, alter column server_hash drop not null;
alter table public.bets drop constraint if exists bets_amount_check;
alter table public.bets add constraint bets_amount_check check (amount >= 0);

-- ============================ provably fair draws =========================================================================
-- floats[i] = first 32 bits of HMAC-SHA256(serverSeed, "<clientSeed>:<nonce>:<round>") ... 8 floats per round, exactly like floatsFor() in src/fair.ts.
create function public.fair_floats(p_seed text, p_client text, p_nonce integer, p_count integer) returns double precision[]
language plpgsql immutable set search_path = public, extensions, pg_temp as $$
declare out double precision[] := '{}'; r integer := 0; h text; i integer;
begin
  while coalesce(array_length(out, 1), 0) < p_count loop
    h := encode(hmac(p_client || ':' || p_nonce || ':' || r, p_seed, 'sha256'), 'hex');
    i := 1;
    while i + 7 <= 64 and coalesce(array_length(out, 1), 0) < p_count loop
      out := out || (('x' || substr(h, i, 8))::bit(32)::bigint)::double precision / 4294967296.0;
      i := i + 8;
    end loop;
    r := r + 1;
  end loop;
  return out;
end $$;

create type public.fair_t as (seed_id bigint, nonce integer, client_seed text, server_hash text, floats double precision[]);
-- Take the next nonce of the player's active seed pair and return the floats for it (the seed itself never leaves the database).
create function public.fair_draw(p_uid uuid, p_count integer) returns public.fair_t
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare s public.seed_pairs;
begin
  select * into s from public.seed_pairs where user_id = p_uid and status = 'active' for update;
  if not found then raise exception 'no_account'; end if;
  update public.seed_pairs set nonce = nonce + 1 where id = s.id;
  return row(s.id, s.nonce, s.client_seed, s.server_hash, public.fair_floats(s.server_seed, s.client_seed, s.nonce, p_count))::public.fair_t;
end $$;

-- ============================ money movement (internal: only game functions call these) ===================================
-- The responsible-gambling gate: age, self-exclusion, cool-off, maximum bet, verification-tier cap, daily loss limit.
create function public.wallet_gate(p_uid uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare prof public.profiles; ctl public.account_controls; loss_today numeric; tier_cap numeric;
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
  tier_cap := case ctl.kyc_tier when 0 then 1000 when 1 then 2500 else 5000 end;
  if p_amount > tier_cap then raise exception 'tier_cap_exceeded'; end if;
  if ctl.loss_daily is not null then
    select coalesce(sum(amount - payout), 0) into loss_today from public.bets
     where user_id = p_uid and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
    if greatest(loss_today, 0) + p_amount > ctl.loss_daily then raise exception 'daily_loss_limit'; end if;
  end if;
end $$;

-- Every stake feeds rakeback (0.4% instant, 0.3% daily, 0.3% weekly). XP and the race come from wallets.wagered and the bets table.
create function public.rewards_accrue(p_uid uuid, p_amount numeric) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.player_rewards (user_id, rb_instant, rb_daily, rb_weekly) values (p_uid, p_amount * 0.004, p_amount * 0.003, p_amount * 0.003)
  on conflict (user_id) do update set rb_instant = public.player_rewards.rb_instant + excluded.rb_instant, rb_daily = public.player_rewards.rb_daily + excluded.rb_daily,
                                      rb_weekly = public.player_rewards.rb_weekly + excluded.rb_weekly;
end $$;

-- Take coins from the wallet. p_stake = true counts it as a wager (XP, rakeback, race). The database refuses an overdraft.
create function public.wallet_debit(p_uid uuid, p_amount numeric, p_kind text default 'bet', p_bet bigint default null, p_stake boolean default true) returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare bal numeric;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  update public.wallets set balance = balance - p_amount, wagered = wagered + case when p_stake then p_amount else 0 end, updated_at = now()
   where user_id = p_uid and balance >= p_amount returning balance into bal;
  if bal is null then raise exception 'insufficient_funds'; end if;
  insert into public.ledger (user_id, kind, amount, balance_after, bet_id) values (p_uid, p_kind, -p_amount, bal, p_bet);
  if p_stake then perform public.rewards_accrue(p_uid, p_amount); end if;
  return bal;
end $$;

-- Give coins to the wallet. p_won = true counts it as winnings (wallets.won); bonus money, refunds and sales do not.
create function public.wallet_credit(p_uid uuid, p_amount numeric, p_kind text, p_bet bigint default null, p_won boolean default false) returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare bal numeric;
begin
  if p_amount is null or p_amount < 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if p_amount = 0 then return (select balance from public.wallets where user_id = p_uid); end if;
  update public.wallets set balance = balance + p_amount, won = won + case when p_won then p_amount else 0 end, updated_at = now()
   where user_id = p_uid returning balance into bal;
  if bal is null then raise exception 'no_account'; end if;
  insert into public.ledger (user_id, kind, amount, balance_after, bet_id) values (p_uid, p_kind, p_amount, bal, p_bet);
  return bal;
end $$;

-- Put items into a player's inventory.
create function public.inventory_add(p_uid uuid, p_item text, p_source text) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  insert into public.inventory (user_id, item_id, source) values (p_uid, p_item, coalesce(p_source, '')) returning id into u;
  return u;
end $$;

-- Record a finished bet (history, race, loss limits). seed fields are null for games that have no personal seed.
create function public.bet_record(p_uid uuid, p_game text, p_amount numeric, p_payout numeric, p_fair public.fair_t, p_params jsonb, p_result jsonb, p_idem text default null) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id bigint;
begin
  insert into public.bets (user_id, game, amount, payout, multiplier, seed_id, nonce, client_seed, server_hash, params, result, idem_key)
  values (p_uid, p_game, p_amount, p_payout, case when p_amount > 0 then round(p_payout / p_amount, 2) else 0 end,
          (p_fair).seed_id, (p_fair).nonce, (p_fair).client_seed, (p_fair).server_hash, coalesce(p_params, '{}'), coalesce(p_result, '{}'), p_idem) returning bets.id into new_id;
  return new_id;
end $$;

-- ============================ the player's own view of everything =========================================================
create function public.wallet_me(p_inventory boolean default true) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); w public.wallets; pr public.player_rewards;
begin
  perform public.live_player(uid);
  select * into w from public.wallets where user_id = uid;
  select * into pr from public.player_rewards where user_id = uid;
  return jsonb_build_object(
    'balance', w.balance, 'wagered', w.wagered, 'won', w.won, 'xp', round(w.wagered * 10),
    'rewards', jsonb_build_object(
      'rb_instant', round(coalesce(pr.rb_instant, 0), 2), 'rb_daily', round(coalesce(pr.rb_daily, 0), 2), 'rb_weekly', round(coalesce(pr.rb_weekly, 0), 2),
      'last_daily', (extract(epoch from pr.last_daily) * 1000)::bigint, 'last_weekly', (extract(epoch from pr.last_weekly) * 1000)::bigint,
      'calendar_streak', coalesce(pr.calendar_streak, 0), 'calendar_last', pr.calendar_last, 'promos', to_jsonb(coalesce(pr.promos, '{}')),
      'keys_used', to_jsonb(coalesce(pr.keys_used, '{}')), 'faucet_at', (extract(epoch from pr.faucet_at) * 1000)::bigint),
    'inventory', case when p_inventory then coalesce((select jsonb_agg(jsonb_build_object('uid', i.id, 'id', i.item_id, 'at', (extract(epoch from i.created_at) * 1000)::bigint) order by i.created_at desc, i.id)
                             from public.inventory i where i.user_id = uid), '[]'::jsonb) end,
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

-- Sell items for their catalogue value (p_uids = null sells everything). Selling is not a wager and does not count as winnings.
create function public.sell_items(p_uids uuid[] default null) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); want integer; n integer; total numeric; bal numeric;
begin
  perform public.live_player(uid);
  if p_uids is not null then select count(distinct x) into want from unnest(p_uids) x; end if;
  with gone as (
    delete from public.inventory i using public.catalog_items c
     where i.user_id = uid and c.id = i.item_id and (p_uids is null or i.id = any (p_uids)) returning c.value)
  select coalesce(sum(value), 0), count(*) into total, n from gone;
  if n = 0 or (p_uids is not null and n <> want) then raise exception 'item_not_found'; end if;
  bal := public.wallet_credit(uid, total, 'sell');
  return jsonb_build_object('balance', bal, 'sold', n, 'total', total);
end $$;

-- ============================ new accounts start with 0 coins =============================================================
create function pg_temp.patch_fn(p_fn text, p_old text, p_new text) returns void language plpgsql as $$
declare fid oid; def text; n integer;
begin
  select p.oid into fid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if fid is null then raise exception 'patch_fn: % not found', p_fn; end if;
  def := pg_get_functiondef(fid);
  n := (length(def) - length(replace(def, p_old, ''))) / length(p_old);
  if n <> 1 then raise exception 'patch_fn: text found % times in %', n, p_fn; end if;
  execute replace(def, p_old, p_new);
end $$;
select pg_temp.patch_fn('complete_signup', 'insert into public.wallets (user_id, balance) values (uid, 100);', 'insert into public.wallets (user_id, balance) values (uid, 0);');
select pg_temp.patch_fn('complete_signup', 'insert into public.ledger (user_id, kind, amount, balance_after) values (uid, ''bonus'', 100, 100);', 'insert into public.player_rewards (user_id) values (uid);');
select pg_temp.patch_fn('complete_signup', 'jsonb_build_object(''display_name'', nm, ''balance'', 100, ''created'', true)', 'jsonb_build_object(''display_name'', nm, ''balance'', 0, ''created'', true)');

-- Closing an account also removes the player's items and rewards state.
select pg_temp.patch_fn('delete_account', 'delete from public.chat_messages where user_id = uid;', 'delete from public.chat_messages where user_id = uid;
  delete from public.inventory where user_id = uid;
  delete from public.player_rewards where user_id = uid;');

-- ============================ privileges ==================================================================================
revoke execute on function public.fair_floats(text, text, integer, integer), public.fair_draw(uuid, integer), public.wallet_gate(uuid, numeric), public.rewards_accrue(uuid, numeric),
  public.wallet_debit(uuid, numeric, text, bigint, boolean), public.wallet_credit(uuid, numeric, text, bigint, boolean), public.inventory_add(uuid, text, text),
  public.bet_record(uuid, text, numeric, numeric, public.fair_t, jsonb, jsonb, text), public.wallet_me(boolean), public.sell_items(uuid[]) from public, anon, authenticated;
grant execute on function public.wallet_me(boolean), public.sell_items(uuid[]) to authenticated;
