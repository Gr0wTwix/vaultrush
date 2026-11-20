-- Vaultrush backend, part 4: free claims that really are once per player, a house bot for live coinflip, and a higher unverified bet cap.
-- Run once in the SQL editor after 0003_live_erasure.sql.
--
-- 1. The welcome crate (once per account) and the daily crate (once per 24 h) used to be tracked only in each browser's storage, so
--    the same account on two browsers (or on localhost and on the live site) could open them in each place. The server now records
--    the claim and refuses a second one, wherever the player is.
-- 2. The creator of a live coinflip can call a house bot to take the other side when no friend is around. Bots play for the house:
--    if the bot wins, nobody is paid.
-- 3. The unverified single-bet cap (tier 0) goes from 50 to 1000 coins; tier 1 from 250 to 2500; tier 2 stays 5000. place_bet() is
--    replaced with the same logic plus those numbers (the browser rules in src/kyc.ts match).

-- ============================ free claims ===============================================================================
create table public.free_claims (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('welcome', 'daily_case')),
  claimed_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.free_claims enable row level security;
create policy free_claims_own on public.free_claims for select to authenticated using (user_id = auth.uid());
revoke all on public.free_claims from anon, authenticated;
grant select on public.free_claims to authenticated;

-- Take a claim if it is available. Returns {claimed, last, next}: claimed=false means it was already taken (last says when, next says
-- when the daily crate is available again). The advisory lock makes two simultaneous requests from the same player safe.
create function public.claim_free(p_kind text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); prof public.profiles; cur timestamptz; nxt timestamptz;
begin
  prof := public.live_player(uid);
  if p_kind is null or p_kind not in ('welcome', 'daily_case') then raise exception 'invalid_claim'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_kind, 0));
  select claimed_at into cur from public.free_claims where user_id = uid and kind = p_kind;
  if found and (p_kind = 'welcome' or cur > now() - interval '24 hours') then
    return jsonb_build_object('claimed', false, 'last', cur, 'next', case when p_kind = 'welcome' then null else cur + interval '24 hours' end);
  end if;
  insert into public.free_claims (user_id, kind, claimed_at) values (uid, p_kind, now())
    on conflict (user_id, kind) do update set claimed_at = excluded.claimed_at;
  nxt := case when p_kind = 'welcome' then null else now() + interval '24 hours' end;
  return jsonb_build_object('claimed', true, 'last', now(), 'next', nxt);
end $$;

-- When each claim was last taken (null = never), so a browser can show the right button state straight after sign-in.
create function public.claim_status() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  perform public.live_player(uid);
  return jsonb_build_object(
    'welcome',    (select claimed_at from public.free_claims where user_id = uid and kind = 'welcome'),
    'daily_case', (select claimed_at from public.free_claims where user_id = uid and kind = 'daily_case'));
end $$;

-- ============================ coinflip bot ==============================================================================
alter table public.live_coinflips add column joiner_bot boolean not null default false;

-- The creator fills the other seat with a house bot. Same maths as a real join: float = first 32 bits of HMAC-SHA256(seed, "<id>:0:0") / 2^32,
-- bolt below 0.5, star otherwise. If the bot's side wins, winner stays null (the house keeps the pot).
create function public.call_live_coinflip_bot(p_id bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); r public.live_coinflips; seed text; h text; f double precision; res text;
begin
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
  return (select to_jsonb(x) from public.live_coinflips x where x.id = p_id);
end $$;

-- ============================ privileges for the new functions ==============================================================
revoke execute on function public.claim_free(text), public.claim_status(), public.call_live_coinflip_bot(bigint, text) from public, anon, authenticated;
grant execute on function public.claim_free(text), public.claim_status(), public.call_live_coinflip_bot(bigint, text) to authenticated;

-- ============================ bet cap: tier 0 = 1000, tier 1 = 2500, tier 2 = 5000 =============================================
-- Identical to place_bet() in 0001_core.sql except for the tier_cap line. create or replace keeps the existing grants.
create or replace function public.place_bet(p_game text, p_amount numeric, p_params jsonb default '{}', p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  uid uuid := auth.uid();
  prof public.profiles; wal public.wallets; ctl public.account_controls; s public.seed_pairs; dup public.bets;
  loss_today numeric; tier_cap numeric; h text; f double precision; crash double precision; target numeric;
  win boolean; pay numeric; bal numeric; bet_id bigint; res jsonb;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  perform public.apply_due_limits(uid);

  if p_idem is not null then                                   -- a retried request returns the original result
    select * into dup from public.bets where user_id = uid and idem_key = p_idem;
    if found then return dup.result || jsonb_build_object('bet_id', dup.id, 'replayed', true); end if;
  end if;
  if p_game <> 'crash' then raise exception 'unsupported_game'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;

  select * into prof from public.profiles where id = uid;
  if not found or prof.deleted_at is not null then raise exception 'no_account'; end if;
  select * into wal from public.wallets where user_id = uid for update;       -- serialises concurrent bets for this player
  select * into ctl from public.account_controls where user_id = uid;

  -- responsible-gambling gate (mirrors betBlockReason in src/rg.ts)
  if prof.age_confirmed_at is null then raise exception 'age_not_confirmed'; end if;
  if ctl.excluded_until is not null and ctl.excluded_until > now() then raise exception 'self_excluded'; end if;
  if ctl.cool_off_until is not null and ctl.cool_off_until > now() then raise exception 'cool_off'; end if;
  if ctl.max_bet is not null and p_amount > ctl.max_bet then raise exception 'max_bet_exceeded'; end if;
  tier_cap := case ctl.kyc_tier when 0 then 1000 when 1 then 2500 else 5000 end;
  if p_amount > tier_cap then raise exception 'tier_cap_exceeded'; end if;
  if ctl.loss_daily is not null then
    select coalesce(sum(amount - payout), 0) into loss_today from public.bets
     where user_id = uid and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
    if greatest(loss_today, 0) + p_amount > ctl.loss_daily then raise exception 'daily_loss_limit'; end if;
  end if;
  if wal.balance < p_amount then raise exception 'insufficient_funds'; end if;

  target := (p_params ->> 'target')::numeric;
  if target is null or target < 1.01 or target > 1000 then raise exception 'invalid_target'; end if;

  select * into s from public.seed_pairs where user_id = uid and status = 'active' for update;
  h := encode(hmac(s.client_seed || ':' || s.nonce || ':0', s.server_seed, 'sha256'), 'hex');
  f := (('x' || substr(h, 1, 8))::bit(32)::bigint)::double precision / 4294967296.0;
  crash := least(10000::double precision, greatest(1::double precision, floor(97.0::double precision / (1 - f)) / 100));
  win := crash >= target::double precision;
  pay := case when win then round(p_amount * target, 2) else 0 end;

  update public.wallets set balance = balance - p_amount + pay, wagered = wagered + p_amount, won = won + pay, updated_at = now()
   where user_id = uid returning balance into bal;
  update public.seed_pairs set nonce = nonce + 1 where id = s.id;

  res := jsonb_build_object('game', p_game, 'amount', p_amount, 'target', target, 'crash_point', crash, 'win', win, 'payout', pay,
                            'balance', bal, 'nonce', s.nonce, 'client_seed', s.client_seed, 'server_hash', s.server_hash, 'float', f);
  insert into public.bets (user_id, game, amount, payout, multiplier, seed_id, nonce, client_seed, server_hash, params, result, idem_key)
  values (uid, p_game, p_amount, pay, case when win then target else 0 end, s.id, s.nonce, s.client_seed, s.server_hash, p_params, res, p_idem)
  returning id into bet_id;
  insert into public.ledger (user_id, kind, amount, balance_after, bet_id) values (uid, 'bet', -p_amount, wal.balance - p_amount, bet_id);
  if pay > 0 then insert into public.ledger (user_id, kind, amount, balance_after, bet_id) values (uid, 'win', pay, bal, bet_id); end if;
  return res || jsonb_build_object('bet_id', bet_id);
end $$;
