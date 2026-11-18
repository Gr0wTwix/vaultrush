-- Vaultrush backend, part 1: accounts, wallet, server-held provably fair seeds, a server-side bet, limits, chat and leaderboard.
--
-- The browser never writes money. Every balance change happens inside a SECURITY DEFINER function that:
--   1. checks the responsible-gambling gate (age, self-exclusion, cool-off, limits, verification tier),
--   2. locks the wallet row, 3. draws the roll from a seed the client cannot read, 4. writes bet + ledger + wallet atomically.
-- Row-level security and revoked table privileges make direct writes impossible for the anon and authenticated roles.
-- Only `crash` is implemented server-side so far; add other games as further branches of place_bet().

create extension if not exists pgcrypto with schema extensions;

-- ============================ tables =====================================================================================
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  display_name     text not null check (char_length(display_name) between 2 and 20),
  age_confirmed_at timestamptz,
  created_at       timestamptz not null default now()
);
create unique index profiles_display_name_key on public.profiles (lower(display_name));

create table public.wallets (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    numeric(14, 2) not null default 0 check (balance >= 0),   -- the database itself refuses an overdraft
  wagered    numeric(16, 2) not null default 0,
  won        numeric(16, 2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Limits and verification. `kyc_tier` can only be changed by a trusted service (service_role), never by the player.
create table public.account_controls (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  excluded_until timestamptz,
  cool_off_until timestamptz,
  max_bet        numeric(12, 2) check (max_bet is null or max_bet >= 0),
  loss_daily     numeric(12, 2) check (loss_daily is null or loss_daily >= 0),
  kyc_tier       smallint not null default 0 check (kyc_tier between 0 and 2)
);
create table public.limit_changes (          -- a loosened limit waits 24 hours before it applies
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  key          text not null check (key in ('max_bet', 'loss_daily')),
  value        numeric(12, 2),
  effective_at timestamptz not null
);

-- Seeds. server_seed is secret until the pair is revealed, so clients get no table access: they read the `my_seeds` view.
create table public.seed_pairs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  server_seed text not null,
  server_hash text not null,
  client_seed text not null,
  nonce       integer not null default 0,
  status      text not null check (status in ('active', 'next', 'revealed')),
  created_at  timestamptz not null default now(),
  revealed_at timestamptz
);
create unique index seed_one_active on public.seed_pairs (user_id) where status = 'active';
create unique index seed_one_next   on public.seed_pairs (user_id) where status = 'next';

create table public.bets (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id),
  game        text not null,
  amount      numeric(12, 2) not null check (amount > 0),
  payout      numeric(14, 2) not null default 0 check (payout >= 0),
  multiplier  numeric(12, 2) not null default 0,
  seed_id     bigint not null references public.seed_pairs (id),
  nonce       integer not null,
  client_seed text not null,
  server_hash text not null,
  params      jsonb not null default '{}',
  result      jsonb not null default '{}',
  idem_key    text,
  created_at  timestamptz not null default now(),
  unique (seed_id, nonce),                  -- a nonce can never be used twice for one seed
  unique (user_id, idem_key)                -- a retried request cannot place the same bet twice
);
create index bets_user_time on public.bets (user_id, created_at desc);
create index bets_day on public.bets (created_at);

create table public.ledger (                 -- append-only money trail; balance_after lets an auditor replay the wallet
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id),
  kind          text not null check (kind in ('bonus', 'bet', 'win', 'adjustment')),
  amount        numeric(14, 2) not null,
  balance_after numeric(14, 2) not null,
  bet_id        bigint references public.bets (id),
  created_at    timestamptz not null default now()
);
create index ledger_user_time on public.ledger (user_id, created_at desc);

create table public.chat_messages (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  display_name text not null default '',
  body         text not null check (char_length(body) between 1 and 140),
  created_at   timestamptz not null default now()
);
create index chat_recent on public.chat_messages (created_at desc);
create function public.chat_fill_name() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.user_id := auth.uid();
  select display_name into new.display_name from public.profiles where id = new.user_id;
  if new.display_name is null then raise exception 'no_account'; end if;
  return new;
end $$;
create trigger chat_fill_name before insert on public.chat_messages for each row execute function public.chat_fill_name();

-- ============================ views ======================================================================================
create view public.my_seeds with (security_invoker = false) as
  select id, server_hash, client_seed, nonce, status, created_at, revealed_at,
         case when status = 'revealed' then server_seed end as server_seed
  from public.seed_pairs where user_id = auth.uid();

create view public.daily_race with (security_invoker = false) as
  select p.display_name, sum(b.amount)::numeric(16, 2) as wagered, count(*)::int as bets
  from public.bets b join public.profiles p on p.id = b.user_id
  where b.created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
  group by p.id, p.display_name order by wagered desc limit 50;

-- ============================ row-level security and privileges ==============================================================
alter table public.profiles         enable row level security;
alter table public.wallets          enable row level security;
alter table public.account_controls enable row level security;
alter table public.limit_changes    enable row level security;
alter table public.seed_pairs       enable row level security;
alter table public.bets             enable row level security;
alter table public.ledger           enable row level security;
alter table public.chat_messages    enable row level security;

create policy profiles_own   on public.profiles         for select to authenticated using (id = auth.uid());
create policy wallets_own    on public.wallets          for select to authenticated using (user_id = auth.uid());
create policy controls_own   on public.account_controls for select to authenticated using (user_id = auth.uid());
create policy limits_own     on public.limit_changes    for select to authenticated using (user_id = auth.uid());
create policy bets_own       on public.bets             for select to authenticated using (user_id = auth.uid());
create policy ledger_own     on public.ledger           for select to authenticated using (user_id = auth.uid());
create policy chat_read      on public.chat_messages    for select to authenticated using (true);
create policy chat_write     on public.chat_messages    for insert to authenticated with check (user_id = auth.uid());
-- seed_pairs has RLS on and NO policy: nobody but the table owner and service_role can read it.

-- Supabase grants every privilege on new tables to anon/authenticated by default. Take it all away, then grant the minimum.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.profiles, public.wallets, public.account_controls, public.limit_changes, public.bets, public.ledger, public.chat_messages to authenticated;
grant insert (body) on public.chat_messages to authenticated;
grant select on public.my_seeds, public.daily_race to authenticated;

-- ============================ functions ==================================================================================
create function public.apply_due_limits(p_user uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select * from public.limit_changes where user_id = p_user and effective_at <= now() order by id loop
    if r.key = 'max_bet' then update public.account_controls set max_bet = r.value where user_id = p_user;
    else update public.account_controls set loss_daily = r.value where user_id = p_user; end if;
    delete from public.limit_changes where id = r.id;
  end loop;
end $$;

create function public.new_seed_pair(p_user uuid, p_status text) returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare seed text := encode(gen_random_bytes(32), 'hex');
begin
  insert into public.seed_pairs (user_id, server_seed, server_hash, client_seed, status)
  values (p_user, seed, encode(digest(seed, 'sha256'), 'hex'), encode(gen_random_bytes(8), 'hex'), p_status);
end $$;

create function public.ensure_account(p_name text default null) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); nm text;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  nm := coalesce(nullif(trim(p_name), ''), 'player-' || substr(replace(uid::text, '-', ''), 1, 6));
  insert into public.profiles (id, display_name) values (uid, nm) on conflict (id) do nothing;
  insert into public.wallets (user_id, balance) values (uid, 100) on conflict (user_id) do nothing;
  if found then insert into public.ledger (user_id, kind, amount, balance_after) values (uid, 'bonus', 100, 100); end if;
  insert into public.account_controls (user_id) values (uid) on conflict (user_id) do nothing;
  if not exists (select 1 from public.seed_pairs where user_id = uid and status = 'active') then perform public.new_seed_pair(uid, 'active'); end if;
  if not exists (select 1 from public.seed_pairs where user_id = uid and status = 'next') then perform public.new_seed_pair(uid, 'next'); end if;
  return (select jsonb_build_object('display_name', p.display_name, 'balance', w.balance) from public.profiles p join public.wallets w on w.user_id = p.id where p.id = uid);
end $$;

create function public.confirm_age() returns void language sql security definer set search_path = public, pg_temp as $$
  update public.profiles set age_confirmed_at = coalesce(age_confirmed_at, now()) where id = auth.uid();
$$;

-- Tightening a limit applies at once; loosening or removing it waits 24 hours (and replaces any earlier pending change).
create function public.request_limit_change(p_key text, p_value numeric) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur numeric;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_key not in ('max_bet', 'loss_daily') then raise exception 'unknown_limit'; end if;
  if p_value is not null and p_value < 0 then raise exception 'invalid_value'; end if;
  perform public.apply_due_limits(uid);
  delete from public.limit_changes where user_id = uid and key = p_key;
  execute format('select %I from public.account_controls where user_id = $1', p_key) into cur using uid;
  if p_value is not distinct from cur then return 'same'; end if;
  if p_value is not null and (cur is null or p_value < cur) then
    execute format('update public.account_controls set %I = $1 where user_id = $2', p_key) using p_value, uid;
    return 'applied';
  end if;
  insert into public.limit_changes (user_id, key, value, effective_at) values (uid, p_key, p_value, now() + interval '24 hours');
  return 'pending';
end $$;

-- Self-exclusion and cool-off can be extended but never shortened.
create function public.self_exclude(p_hours integer) returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); until timestamptz;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 * 365 then raise exception 'invalid_duration'; end if;
  update public.account_controls set excluded_until = greatest(coalesce(excluded_until, now()), now() + make_interval(hours => p_hours))
   where user_id = uid returning excluded_until into until;
  return until;
end $$;

create function public.set_client_seed(p_seed text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_seed is null or char_length(p_seed) not between 1 and 64 then raise exception 'invalid_seed'; end if;
  update public.seed_pairs set client_seed = p_seed where user_id = auth.uid() and status = 'active';
end $$;

-- Reveal the active seed and promote the pre-committed "next" seed. The caller can now recompute every bet made with the old one.
create function public.rotate_seed() returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); s public.seed_pairs;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into s from public.seed_pairs where user_id = uid and status = 'active' for update;
  if not found then raise exception 'no_account'; end if;
  update public.seed_pairs set status = 'revealed', revealed_at = now() where id = s.id;
  update public.seed_pairs set status = 'active' where user_id = uid and status = 'next';
  perform public.new_seed_pair(uid, 'next');
  return jsonb_build_object('server_seed', s.server_seed, 'server_hash', s.server_hash, 'client_seed', s.client_seed, 'nonces', s.nonce);
end $$;

-- The server-side bet. Roll = first 32 bits of HMAC-SHA256(serverSeed, clientSeed:nonce:0) / 2^32, exactly like src/fair.ts.
create function public.place_bet(p_game text, p_amount numeric, p_params jsonb default '{}', p_idem text default null) returns jsonb
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
  if not found then raise exception 'no_account'; end if;
  select * into wal from public.wallets where user_id = uid for update;       -- serialises concurrent bets for this player
  select * into ctl from public.account_controls where user_id = uid;

  -- responsible-gambling gate (mirrors betBlockReason in src/rg.ts)
  if prof.age_confirmed_at is null then raise exception 'age_not_confirmed'; end if;
  if ctl.excluded_until is not null and ctl.excluded_until > now() then raise exception 'self_excluded'; end if;
  if ctl.cool_off_until is not null and ctl.cool_off_until > now() then raise exception 'cool_off'; end if;
  if ctl.max_bet is not null and p_amount > ctl.max_bet then raise exception 'max_bet_exceeded'; end if;
  tier_cap := case ctl.kyc_tier when 0 then 50 when 1 then 250 else 5000 end;
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

-- Only signed-in players may call the public API. Internal helpers are not callable by clients at all.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.ensure_account(text), public.confirm_age(), public.request_limit_change(text, numeric), public.self_exclude(integer),
  public.set_client_seed(text), public.rotate_seed(), public.place_bet(text, numeric, jsonb, text) to authenticated;

-- Realtime chat (a no-op outside Supabase where the publication does not exist).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then alter publication supabase_realtime add table public.chat_messages; end if;
end $$;
