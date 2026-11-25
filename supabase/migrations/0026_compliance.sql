-- Vaultrush 0026: admin step F, part 1: verification requests and the responsible-play console. Run after 0025. Running it again changes nothing.
--
--   * Verification: the database's verification level (account_controls.kyc_tier) sets the most one stake may be (10,000 / 25,000 / 50,000) and
--     until now nobody could raise it. A player can now ask for a higher level; staff with compliance.review approve or decline it, or set a
--     player's level directly. This demo collects no documents: it is a manual staff decision, and the player's page says so.
--   * Responsible play: staff with rg.view see who is self-excluded or on a break, the loosened limits that are waiting their 24 hours, and the
--     players who lost or played the most recently. Staff with rg.apply can only make things SAFER for a player: start or extend a break or a
--     self-exclusion, and tighten a limit (a tightened limit also cancels a loosening that was waiting). Nothing here can shorten or loosen.
-- Every staff action needs a reason and is written to the audit log.

-- ============================ verification requests ==============================================================================
create table if not exists public.kyc_requests (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  tier          smallint not null check (tier between 1 and 2),
  note          text not null default '' check (char_length(note) <= 300),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid,
  decision_note text
);
create unique index if not exists kyc_requests_one_pending on public.kyc_requests (user_id) where status = 'pending';
alter table public.kyc_requests enable row level security;
revoke all on public.kyc_requests from anon, authenticated;

-- The player's own level and latest request.
create or replace function public.my_verification() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.kyc_requests;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into r from public.kyc_requests where user_id = uid order by id desc limit 1;
  return jsonb_build_object('tier', coalesce((select kyc_tier from public.account_controls where user_id = uid), 0),
    'request', case when r.id is null then null else jsonb_build_object('id', r.id, 'tier', r.tier, 'status', r.status, 'at', r.created_at, 'decided_at', r.decided_at, 'note', r.decision_note) end);
end $$;

create or replace function public.request_verification(p_tier integer, p_note text default '') returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur integer;
begin
  perform public.site_guard(null);
  perform public.live_player(uid);
  select coalesce(kyc_tier, 0) into cur from public.account_controls where user_id = uid;
  if p_tier is null or p_tier < 1 or p_tier > 2 or p_tier <= coalesce(cur, 0) then raise exception 'invalid_tier'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'text_too_long'; end if;
  if exists (select 1 from public.kyc_requests where user_id = uid and status = 'pending') then raise exception 'request_pending'; end if;
  insert into public.kyc_requests (user_id, tier, note) values (uid, p_tier, trim(coalesce(p_note, '')));
  return public.my_verification();
end $$;

create or replace function public.withdraw_verification() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.kyc_requests set status = 'withdrawn', decided_at = now() where user_id = uid and status = 'pending';
  return public.my_verification();
end $$;

create or replace function public.admin_kyc_queue(p_status text default 'pending') returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('compliance.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'user_id', r.user_id, 'name', p.display_name, 'tier', r.tier, 'note', r.note, 'status', r.status, 'at', r.created_at,
            'decided_at', r.decided_at, 'decision_note', r.decision_note, 'by', (select display_name from public.profiles x where x.id = r.decided_by),
            'current_tier', coalesce(c.kyc_tier, 0), 'joined', p.created_at, 'wagered', w.wagered,
            'flags', coalesce((select jsonb_agg(distinct a.kind) from public.account_flags a where a.user_id = r.user_id and a.lifted_at is null and (a.until is null or a.until > now())), '[]'::jsonb))
            order by r.id desc)
          from (select * from public.kyc_requests where (p_status is null or status = p_status) order by id desc limit 200) r
          join public.profiles p on p.id = r.user_id left join public.account_controls c on c.user_id = r.user_id left join public.wallets w on w.user_id = r.user_id), '[]'::jsonb);
end $$;

create or replace function public.admin_kyc_decide(p_id bigint, p_approve boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('compliance.review'); why text := public.admin_need_reason(p_reason); r public.kyc_requests; old integer;
begin
  select * into r from public.kyc_requests where id = p_id for update;
  if r.id is null then raise exception 'invalid_value'; end if;
  if r.status <> 'pending' then raise exception 'request_closed'; end if;
  perform public.admin_target(r.user_id);
  update public.kyc_requests set status = case when p_approve then 'approved' else 'declined' end, decided_at = now(), decided_by = uid, decision_note = why where id = p_id;
  if p_approve then
    select coalesce(kyc_tier, 0) into old from public.account_controls where user_id = r.user_id;
    insert into public.account_controls (user_id, kyc_tier) values (r.user_id, r.tier) on conflict (user_id) do update set kyc_tier = greatest(public.account_controls.kyc_tier, excluded.kyc_tier);
  end if;
  perform public.admin_log(case when p_approve then 'kyc.approve' else 'kyc.decline' end, 'player', r.user_id::text, jsonb_build_object('tier', old), jsonb_build_object('tier', case when p_approve then r.tier end), why,
                           jsonb_build_object('request_id', p_id));
  return jsonb_build_object('id', p_id, 'status', case when p_approve then 'approved' else 'declined' end);
end $$;

-- Set a player's level directly (up or down), for example to correct a mistake.
create or replace function public.admin_kyc_set_tier(p_user uuid, p_tier integer, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('compliance.review'); why text := public.admin_need_reason(p_reason); old integer;
begin
  if p_tier is null or p_tier < 0 or p_tier > 2 then raise exception 'invalid_tier'; end if;
  perform public.admin_target(p_user);
  select coalesce(kyc_tier, 0) into old from public.account_controls where user_id = p_user;
  insert into public.account_controls (user_id, kyc_tier) values (p_user, p_tier) on conflict (user_id) do update set kyc_tier = excluded.kyc_tier;
  update public.kyc_requests set status = 'declined', decided_at = now(), decided_by = uid, decision_note = 'level set directly: ' || why where user_id = p_user and status = 'pending';
  perform public.admin_log('kyc.set_tier', 'player', p_user::text, jsonb_build_object('tier', coalesce(old, 0)), jsonb_build_object('tier', p_tier), why);
  return jsonb_build_object('tier', p_tier);
end $$;

-- ============================ responsible-play console ===========================================================================
create or replace function public.admin_rg_overview() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rg.view');
begin
  return jsonb_build_object(
    'excluded', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'until', c.excluded_until) order by c.excluded_until desc)
                          from public.account_controls c join public.profiles p on p.id = c.user_id where c.excluded_until > now() and p.deleted_at is null), '[]'::jsonb),
    'cool_off', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'until', c.cool_off_until) order by c.cool_off_until desc)
                          from public.account_controls c join public.profiles p on p.id = c.user_id where c.cool_off_until > now() and p.deleted_at is null), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'key', l.key, 'value', l.value, 'effective_at', l.effective_at) order by l.effective_at)
                         from public.limit_changes l join public.profiles p on p.id = l.user_id where l.effective_at > now()), '[]'::jsonb),
    'losses_7d', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'staked', x.staked, 'net_loss', x.loss, 'bets', x.n) order by x.loss desc)
                           from (select b.user_id, sum(b.amount) as staked, sum(b.amount - b.payout) as loss, count(*) as n from public.bets b
                                  where b.created_at >= public.rg_day_start(6) group by b.user_id having sum(b.amount - b.payout) > 0 order by sum(b.amount - b.payout) desc limit 20) x
                           join public.profiles p on p.id = x.user_id), '[]'::jsonb),
    'busy_today', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'bets', x.n, 'staked', x.staked, 'minutes', public.rg_active_minutes(x.user_id)) order by x.n desc)
                            from (select b.user_id, count(*) as n, sum(b.amount) as staked from public.bets b where b.created_at >= public.rg_day_start(0)
                                   group by b.user_id order by count(*) desc limit 20) x join public.profiles p on p.id = x.user_id), '[]'::jsonb),
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

-- Make things safer for a player, never the other way.
--   p_kind 'cool_off' (p_value hours, 1 to 720) and 'exclude' (p_value days, 1 to 3650): start, or extend; never shorten.
--   p_kind one of the six limits (p_value the new limit): only if it is tighter than the current one (or there is none); a loosening that was
--   waiting for that limit is cancelled.
create or replace function public.admin_rg_apply(p_user uuid, p_kind text, p_value numeric, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rg.apply'); why text := public.admin_need_reason(p_reason); cur numeric; ctl public.account_controls; till timestamptz;
begin
  perform public.admin_target(p_user);
  insert into public.account_controls (user_id) values (p_user) on conflict (user_id) do nothing;
  perform public.apply_due_limits(p_user);
  select * into ctl from public.account_controls where user_id = p_user for update;
  if p_kind = 'cool_off' then
    if p_value is null or p_value < 1 or p_value > 720 or p_value <> round(p_value) then raise exception 'invalid_duration'; end if;
    till := greatest(coalesce(ctl.cool_off_until, now()), now() + make_interval(hours => p_value::integer));
    update public.account_controls set cool_off_until = till where user_id = p_user;
    perform public.admin_log('rg.cool_off', 'player', p_user::text, jsonb_build_object('until', ctl.cool_off_until), jsonb_build_object('until', till), why);
    return jsonb_build_object('until', till);
  elsif p_kind = 'exclude' then
    if p_value is null or p_value < 1 or p_value > 3650 or p_value <> round(p_value) then raise exception 'invalid_duration'; end if;
    till := greatest(coalesce(ctl.excluded_until, now()), now() + make_interval(days => p_value::integer));
    update public.account_controls set excluded_until = till where user_id = p_user;
    perform public.admin_log('rg.exclude', 'player', p_user::text, jsonb_build_object('until', ctl.excluded_until), jsonb_build_object('until', till), why);
    return jsonb_build_object('until', till);
  elsif p_kind = any (array['max_bet', 'loss_daily', 'loss_weekly', 'loss_monthly', 'wager_daily', 'time_daily_min']) then
    if p_value is null or p_value < 0 or p_value <> round(p_value, 2) or p_value > 1000000000 then raise exception 'invalid_limit'; end if;
    if p_kind = 'time_daily_min' and (p_value <> round(p_value) or p_value > 1440) then raise exception 'invalid_limit'; end if;
    execute format('select %I::numeric from public.account_controls where user_id = $1', p_kind) into cur using p_user;
    if cur is not null and p_value >= cur then raise exception 'not_tighter'; end if;
    execute format('update public.account_controls set %I = $1 where user_id = $2', p_kind) using p_value, p_user;
    delete from public.limit_changes where user_id = p_user and key = p_kind;
    perform public.admin_log('rg.limit', 'player', p_user::text, jsonb_build_object(p_kind, cur), jsonb_build_object(p_kind, p_value), why);
    return jsonb_build_object(p_kind, p_value);
  end if;
  raise exception 'invalid_value';
end $$;

-- ============================ privileges ==========================================================================================
revoke execute on function public.my_verification(), public.request_verification(integer, text), public.withdraw_verification(), public.admin_kyc_queue(text),
  public.admin_kyc_decide(bigint, boolean, text), public.admin_kyc_set_tier(uuid, integer, text), public.admin_rg_overview(), public.admin_rg_apply(uuid, text, numeric, text) from public, anon;
grant execute on function public.my_verification(), public.request_verification(integer, text), public.withdraw_verification(), public.admin_kyc_queue(text),
  public.admin_kyc_decide(bigint, boolean, text), public.admin_kyc_set_tier(uuid, integer, text), public.admin_rg_overview(), public.admin_rg_apply(uuid, text, numeric, text) to authenticated;
