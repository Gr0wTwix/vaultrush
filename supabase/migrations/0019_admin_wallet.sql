-- Vaultrush 0019: admin wallet tools. Run after 0018 (it needs the server wallet of 0008 and the admin foundation of 0006).
--
-- For the admin site's "Wallets" page:
--   * Looking (permission ledger.view): the totals of the whole economy, a player search with balances, one player's wallet (balance, wagered, won, what the
--     ledger adds up to, the coins by kind, the bets summary, the inventory, and - with rg.view - the limits and breaks), and the player's ledger and bets,
--     newest first, in pages. Looking is not written to the audit log (it would only be noise, and every audit row alerts the owner); the data explorer, which
--     can read anything, is logged.
--   * Changing (permission wallet.adjust, which only the Owner holds unless the Owner switches it on for another role): credit or debit a player's coins.
--       - the amount is in coins with at most 2 decimals, not zero, at most 10,000,000 either way; a debit can never take the balance below zero (debit_exceeds_balance);
--       - a reason of at least 3 characters is required and goes in the audit log with the balance before and after;
--       - the ledger gets a row of kind 'adjustment' (so the player sees it in their transactions); an adjustment is not a wager and not a win (it earns no XP,
--         no rakeback and does not count in "won");
--       - the caller passes a unique key; the same key again changes nothing and returns the first result, so a double click or a retry cannot pay twice.
-- Nothing here can touch items, only coins. Running this file again changes nothing.

-- the totals of the whole economy
create or replace function public.admin_wallet_totals() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('ledger.view');
begin
  return jsonb_build_object(
    'coins_in_wallets', (select coalesce(sum(w.balance), 0) from public.wallets w),
    'wallets', (select count(*) from public.wallets),
    'wallets_with_coins', (select count(*) from public.wallets where balance > 0),
    'top_balance', (select coalesce(max(balance), 0) from public.wallets),
    'bets_today', (select jsonb_build_object('count', count(*), 'staked', coalesce(sum(amount), 0), 'paid', coalesce(sum(payout), 0)) from public.bets where created_at >= public.rg_day_start(0)),
    'bets_7d', (select jsonb_build_object('count', count(*), 'staked', coalesce(sum(amount), 0), 'paid', coalesce(sum(payout), 0)) from public.bets where created_at >= public.rg_day_start(6)),
    'adjustments_30d', (select jsonb_build_object('count', count(*), 'credited', coalesce(sum(amount) filter (where amount > 0), 0), 'debited', coalesce(-sum(amount) filter (where amount < 0), 0))
                          from public.ledger where kind = 'adjustment' and created_at >= now() - interval '30 days'),
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

-- find players by name, with their balances (the richest first)
create or replace function public.admin_wallet_search(p_query text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('ledger.view'); q text := replace(replace(trim(coalesce(p_query, '')), '%', ''), '_', '');
begin
  if char_length(q) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(x order by (x ->> 'balance')::numeric desc, x ->> 'name')
                     from (select jsonb_build_object('id', p.id, 'name', p.display_name, 'balance', w.balance, 'wagered', w.wagered, 'created_at', p.created_at) as x
                             from public.profiles p join public.wallets w on w.user_id = p.id
                            where p.display_name ilike '%' || q || '%' and p.deleted_at is null order by w.balance desc, p.display_name limit 20) t), '[]'::jsonb);
end $$;

-- one player's wallet at a glance
create or replace function public.admin_wallet_overview(p_user uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('ledger.view'); me text := public.admin_role_of(auth.uid()); pr public.profiles; w public.wallets; ctl public.account_controls; sum_led numeric; rows_led bigint; limits jsonb;
begin
  select * into pr from public.profiles where id = p_user;
  select * into w from public.wallets where user_id = p_user;
  if pr.id is null or w.user_id is null then raise exception 'player_not_found'; end if;
  select coalesce(sum(amount), 0), count(*) into sum_led, rows_led from public.ledger where user_id = p_user;
  if public.admin_has_perm(me, 'rg.view') then
    select * into ctl from public.account_controls where user_id = p_user;
    limits := jsonb_build_object(
      'limits', jsonb_build_object('max_bet', ctl.max_bet, 'loss_daily', ctl.loss_daily, 'loss_weekly', ctl.loss_weekly, 'loss_monthly', ctl.loss_monthly, 'wager_daily', ctl.wager_daily, 'time_daily_min', ctl.time_daily_min),
      'usage', jsonb_build_object('staked_today', public.rg_staked(p_user), 'loss_1', greatest(public.rg_net_loss(p_user, 1), 0), 'loss_7', greatest(public.rg_net_loss(p_user, 7), 0),
                                  'loss_30', greatest(public.rg_net_loss(p_user, 30), 0), 'active_minutes', public.rg_active_minutes(p_user)),
      'excluded_until', ctl.excluded_until, 'cool_off_until', ctl.cool_off_until, 'kyc_tier', ctl.kyc_tier);
  end if;
  return jsonb_build_object(
    'player', jsonb_build_object('id', pr.id, 'name', pr.display_name, 'created_at', pr.created_at, 'closed', pr.deleted_at is not null, 'staff_role', public.admin_role_of(pr.id)),
    'wallet', jsonb_build_object('balance', w.balance, 'wagered', w.wagered, 'won', w.won, 'updated_at', w.updated_at),
    -- what the ledger adds up to; the balance minus this is 0 for an account whose every coin went through the ledger (older balances may differ)
    'ledger', jsonb_build_object('rows', rows_led, 'sum', sum_led, 'difference', w.balance - sum_led,
      'by_kind', coalesce((select jsonb_agg(jsonb_build_object('kind', k, 'count', n, 'sum', s) order by k) from (select kind as k, count(*) as n, sum(amount) as s from public.ledger where user_id = p_user group by kind) g), '[]'::jsonb)),
    'bets', (select jsonb_build_object('count', count(*), 'staked', coalesce(sum(amount), 0), 'paid', coalesce(sum(payout), 0), 'last_at', max(created_at)) from public.bets where user_id = p_user),
    'inventory', (select jsonb_build_object('items', count(*), 'value', coalesce(sum(i.value), 0)) from public.inventory v join public.catalog_items i on i.id = v.item_id where v.user_id = p_user),
    'responsible', limits);
end $$;

-- the ledger, newest first, `p_limit` rows (at most 200) older than the row id `p_before`
create or replace function public.admin_wallet_ledger(p_user uuid, p_before bigint default null, p_limit integer default 50) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('ledger.view'); lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'amount', amount, 'balance_after', balance_after, 'bet_id', bet_id, 'at', created_at) order by id desc)
                     from (select * from public.ledger where user_id = p_user and (p_before is null or id < p_before) order by id desc limit lim) l), '[]'::jsonb);
end $$;

-- the bets, newest first, in the same way
create or replace function public.admin_wallet_bets(p_user uuid, p_before bigint default null, p_limit integer default 50) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('ledger.view'); lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'game', game, 'amount', amount, 'payout', payout, 'multiplier', multiplier, 'nonce', nonce, 'at', created_at) order by id desc)
                     from (select * from public.bets where user_id = p_user and (p_before is null or id < p_before) order by id desc limit lim) b), '[]'::jsonb);
end $$;

-- credit (positive amount) or debit (negative amount) a player's coins
create or replace function public.admin_wallet_adjust(p_user uuid, p_amount numeric, p_reason text, p_key uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('wallet.adjust'); why text := public.admin_need_reason(p_reason); old_bal numeric; new_bal numeric; led bigint; prev record;
begin
  if p_key is null or p_user is null then raise exception 'invalid_value'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000000 or p_amount <> round(p_amount, 2) then raise exception 'adjust_amount_invalid'; end if;
  -- the same key again: the first result, nothing changed (a different player or amount under the same key is refused).
  -- Two requests with one key at the same moment wait for each other here, so the second one finds the first one's audit row.
  perform pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
  select target_id, meta into prev from public.admin_audit_log where action = 'wallet.adjust' and meta ->> 'key' = p_key::text limit 1;
  if found then
    if prev.target_id <> p_user::text or (prev.meta ->> 'amount')::numeric <> p_amount then raise exception 'key_reused'; end if;
    return jsonb_build_object('user_id', p_user, 'amount', p_amount, 'balance_before', (prev.meta ->> 'balance_before')::numeric, 'balance_after', (prev.meta ->> 'balance_after')::numeric, 'replayed', true);
  end if;
  if not exists (select 1 from public.profiles where id = p_user and deleted_at is null) then raise exception 'player_not_found'; end if;
  select balance into old_bal from public.wallets where user_id = p_user for update;
  if old_bal is null then raise exception 'player_not_found'; end if;
  if p_amount < 0 and old_bal < -p_amount then raise exception 'debit_exceeds_balance'; end if;
  if p_amount > 0 then new_bal := public.wallet_credit(p_user, p_amount, 'adjustment', null, false);
  else new_bal := public.wallet_debit(p_user, -p_amount, 'adjustment', null, false); end if;           -- refuses to go below zero (insufficient_funds)
  select max(id) into led from public.ledger where user_id = p_user and kind = 'adjustment';
  perform public.admin_log('wallet.adjust', 'player', p_user::text, jsonb_build_object('balance', old_bal), jsonb_build_object('balance', new_bal), why,
                           jsonb_build_object('key', p_key, 'amount', p_amount, 'balance_before', old_bal, 'balance_after', new_bal, 'ledger_id', led));
  return jsonb_build_object('user_id', p_user, 'amount', p_amount, 'balance_before', old_bal, 'balance_after', new_bal, 'ledger_id', led, 'replayed', false);
end $$;

revoke execute on function public.admin_wallet_totals(), public.admin_wallet_search(text), public.admin_wallet_overview(uuid), public.admin_wallet_ledger(uuid, bigint, integer),
  public.admin_wallet_bets(uuid, bigint, integer), public.admin_wallet_adjust(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_wallet_totals(), public.admin_wallet_search(text), public.admin_wallet_overview(uuid), public.admin_wallet_ledger(uuid, bigint, integer),
  public.admin_wallet_bets(uuid, bigint, integer), public.admin_wallet_adjust(uuid, numeric, text, uuid) to authenticated;
