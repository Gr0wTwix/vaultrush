-- Vaultrush 0020: rate limits for chat and promo codes. Run after 0019 (it needs 0001 and 0012). Running it again changes nothing.
--
-- Chat: a player may send at most one message every 2 seconds and 10 a minute ('chat_too_fast'). Before this only the 140-character limit applied,
--   so one account could flood the room.
-- Promo codes: a wrong code is now counted; after 10 wrong codes in 10 minutes the player must wait ('too_many_attempts'), so codes cannot be guessed
--   by trying thousands. A wrong code is answered with {"error": "invalid_code"} instead of an error, because an error would undo the count.
--   The page turns that answer into the same message as before. Right codes are not counted.

-- ============================ chat =================================================================================================
create index if not exists chat_user_time on public.chat_messages (user_id, created_at desc);
create or replace function public.chat_rate_limit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.chat_messages where user_id = new.user_id and created_at > now() - interval '2 seconds') then raise exception 'chat_too_fast'; end if;
  if (select count(*) from public.chat_messages where user_id = new.user_id and created_at > now() - interval '1 minute') >= 10 then raise exception 'chat_too_fast'; end if;
  return new;
end $$;
revoke execute on function public.chat_rate_limit() from public, anon, authenticated;
drop trigger if exists chat_rate_limit on public.chat_messages;
create trigger chat_rate_limit before insert on public.chat_messages for each row execute function public.chat_rate_limit();

-- ============================ promo codes ==========================================================================================
create table if not exists public.promo_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists promo_attempts_user on public.promo_attempts (user_id, at desc);
alter table public.promo_attempts enable row level security;               -- no policy: only the function below touches it
revoke all on public.promo_attempts from anon, authenticated;

create or replace function public.redeem_promo(p_code text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); c_code text := upper(trim(coalesce(p_code, ''))); pc public.promo_codes; pr public.player_rewards; bal numeric;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  if (select count(*) from public.promo_attempts where user_id = uid and at > now() - interval '10 minutes') >= 10 then raise exception 'too_many_attempts'; end if;
  insert into public.player_rewards (user_id) values (uid) on conflict (user_id) do nothing;
  select * into pr from public.player_rewards where user_id = uid for update;
  select * into pc from public.promo_codes where promo_codes.code = c_code for update;
  if not found or not pc.active or (pc.expires_at is not null and pc.expires_at < now()) then
    insert into public.promo_attempts (user_id) values (uid);                -- kept: this is an answer, not an error
    delete from public.promo_attempts where at < now() - interval '1 day';  -- old attempts are not needed
    return jsonb_build_object('error', 'invalid_code');
  end if;
  if c_code = any (pr.promos) then raise exception 'code_used'; end if;
  if pc.max_uses is not null and pc.uses >= pc.max_uses then raise exception 'code_used_up'; end if;
  update public.promo_codes set uses = uses + 1 where promo_codes.code = c_code;
  update public.player_rewards set promos = promos || c_code where user_id = uid;
  bal := public.wallet_credit(uid, pc.amount, 'promo');
  return jsonb_build_object('code', c_code, 'amount', pc.amount, 'balance', bal);
end $$;
