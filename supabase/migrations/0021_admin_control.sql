-- Vaultrush 0021: admin step B, control and visibility. Run after 0020. Running it again changes nothing.
--
-- For the admin site's Dashboard, Players, Chat, Live rooms and Rounds pages, and the matching player-side rules:
--   * Players: a searchable list with status and tags, one player's profile (account facts, flags, notes, tags, recent chat, bets, admin actions),
--     notes and tags written by staff.
--   * Account actions (each needs a reason, is written to the audit log, and can be lifted except closing): mute in chat, warn (the player sees the
--     message at their next visit), ban from betting, ban from the site (also ends the player's sign-in where the database allows it), force sign-out,
--     rename, reset a free claim, close and anonymise the account. Temporary actions end by themselves.
--   * Chat moderation: remove a message (players see "message removed"), clear recent messages, slow mode, lock the room, block links and words, pin a
--     message, staff messages, and a report button for players with a queue for staff.
--   * Live rooms: every battle and coinflip with its seats and stakes, cancel a waiting lobby (stakes refunded), mark a game suspicious or void
--     (a record only: coins are corrected on the Wallets page).
--   * Rounds: Crash and Double rounds with their bets, a seed check that recomputes a finished round, and a void record. Pausing a game is the game
--     switch of 0007. A running round is never stopped half way (rounds last seconds; the switch stops new ones).
--   * Dashboard: what is happening now, from the database.
-- Staff are never subject to bans, mutes, chat locks or filters. A ban cannot be placed on staff of the same or a higher rank.

-- ============================ tables ===============================================================================================
create table if not exists public.player_notes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  author      uuid,
  author_name text,
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists player_notes_user on public.player_notes (user_id, id desc);

create table if not exists public.player_tags (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  tag      text not null check (tag in ('vip', 'watch', 'friend', 'tester', 'streamer')),
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (user_id, tag)
);

create table if not exists public.account_flags (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('mute', 'warn', 'bet_ban', 'site_ban')),
  until       timestamptz,                                   -- null: until lifted
  message     text not null default '' check (char_length(message) <= 300),   -- what the player is told (a warning's text)
  reason      text not null,                                 -- why, for staff
  created_by  uuid,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz,                                   -- a warning the player has read
  lifted_at   timestamptz,
  lifted_by   uuid,
  lift_reason text
);
create index if not exists account_flags_user on public.account_flags (user_id, kind) where lifted_at is null;

create table if not exists public.chat_settings (
  id            integer primary key default 1 check (id = 1),
  slow_seconds  integer not null default 0 check (slow_seconds between 0 and 300),
  locked        boolean not null default false,
  links_allowed boolean not null default true,
  blocked_words text[] not null default '{}',
  pinned_id     bigint,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
insert into public.chat_settings (id) values (1) on conflict (id) do nothing;

alter table public.chat_messages add column if not exists removed_at timestamptz;
alter table public.chat_messages add column if not exists removed_by uuid;
alter table public.chat_messages add column if not exists is_staff boolean not null default false;

create table if not exists public.chat_reports (
  id          bigint generated always as identity primary key,
  message_id  bigint not null references public.chat_messages (id) on delete cascade,
  reporter    uuid not null references public.profiles (id) on delete cascade,
  reason      text not null default '' check (char_length(reason) <= 200),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  outcome     text check (outcome in ('removed', 'dismissed')),
  unique (message_id, reporter)
);
create index if not exists chat_reports_open on public.chat_reports (created_at desc) where resolved_at is null;

create table if not exists public.room_flags (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('battle', 'coinflip', 'round')),
  ref        text not null,
  flag       text not null check (flag in ('suspicious', 'void')),
  reason     text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists room_flags_ref on public.room_flags (kind, ref);

alter table public.player_notes  enable row level security;
alter table public.player_tags   enable row level security;
alter table public.account_flags enable row level security;
alter table public.chat_settings enable row level security;
alter table public.chat_reports  enable row level security;
alter table public.room_flags    enable row level security;
-- no policies: only the functions below read or write these tables
revoke all on public.player_notes, public.player_tags, public.account_flags, public.chat_settings, public.chat_reports, public.room_flags from anon, authenticated;

-- ============================ helpers ==============================================================================================
create or replace function public.flag_active(p_user uuid, p_kind text) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.account_flags where user_id = p_user and kind = p_kind and lifted_at is null and (until is null or until > now()))
$$;

-- The player an action is aimed at: it must exist, must not be the caller, and staff can only be acted on by a higher rank.
create or replace function public.admin_target(p_user uuid, p_open boolean default true) returns public.profiles language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pr public.profiles; theirs text;
begin
  select * into pr from public.profiles where id = p_user;
  if pr.id is null or (p_open and pr.deleted_at is not null) then raise exception 'player_not_found'; end if;
  if p_user = auth.uid() then raise exception 'not_allowed_self'; end if;
  theirs := public.admin_role_of(p_user);
  if theirs is not null and public.admin_rank_of(theirs) >= public.admin_rank_of(public.admin_role_of(auth.uid())) then raise exception 'rank_too_low'; end if;
  return pr;
end $$;

-- Ends a player's sign-in everywhere (and, with p_ban_until, refuses new sign-ins until then) where the database allows it.
-- Returns false when the sign-in tables cannot be changed from here; the bans themselves still apply on every request.
create or replace function public.auth_cut(p_user uuid, p_ban_until timestamptz default null, p_set_ban boolean default false) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    if p_set_ban then execute 'update auth.users set banned_until = $2 where id = $1' using p_user, p_ban_until; end if;
    execute 'delete from auth.sessions where user_id = $1' using p_user;
    return true;
  exception when insufficient_privilege or undefined_table or undefined_column then return false;
  end;
end $$;

-- ============================ the site guard learns about bans =====================================================================
-- Same as 0007, plus: a site ban refuses everything that goes through the guard (games, rewards, claims); a betting ban refuses games.
create or replace function public.site_guard(p_game text default null) returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.site_controls; uid uuid := auth.uid(); ctry text;
begin
  if uid is not null and public.admin_role_of(uid) is not null then return; end if;           -- staff are never locked out
  if uid is not null then
    if public.flag_active(uid, 'site_ban') then raise exception 'account_banned'; end if;
    if p_game is not null and public.flag_active(uid, 'bet_ban') then raise exception 'betting_banned'; end if;
  end if;
  select * into c from public.site_controls where id = 1;
  if c.maintenance_on then raise exception 'maintenance'; end if;
  ctry := public.request_country();
  if ctry is not null and ctry = any (c.blocked_countries) then raise exception 'country_blocked'; end if;
  if p_game is not null and p_game = any (c.games_off) then raise exception 'game_off'; end if;
end $$;

-- ============================ chat rules for players ==============================================================================
create or replace function public.chat_moderate() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.chat_settings; w text; low text := lower(new.body);
begin
  if public.admin_role_of(new.user_id) is not null then return new; end if;                  -- staff are not limited
  if public.flag_active(new.user_id, 'mute') or public.flag_active(new.user_id, 'site_ban') then raise exception 'chat_muted'; end if;
  select * into s from public.chat_settings where id = 1;
  if s.locked then raise exception 'chat_locked'; end if;
  if s.slow_seconds > 0 and exists (select 1 from public.chat_messages where user_id = new.user_id and created_at > now() - make_interval(secs => s.slow_seconds)) then raise exception 'chat_slow'; end if;
  if not s.links_allowed and low ~ '(https?://|www\.|[a-z0-9-]+\.(com|net|org|gg|io|ru|xyz|me|co|link|ly|tk)\b)' then raise exception 'chat_no_links'; end if;
  foreach w in array s.blocked_words loop
    if w <> '' and position(lower(w) in low) > 0 then raise exception 'chat_blocked_word'; end if;
  end loop;
  new.is_staff := false; new.removed_at := null; new.removed_by := null;
  return new;
end $$;
revoke execute on function public.chat_moderate() from public, anon, authenticated;
drop trigger if exists chat_moderate on public.chat_messages;
create trigger chat_moderate before insert on public.chat_messages for each row execute function public.chat_moderate();

-- What the chat window needs: room state and the pinned message. Any signed-in player may ask.
create or replace function public.chat_status() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slow_seconds', s.slow_seconds, 'locked', s.locked, 'links_allowed', s.links_allowed,
    'pinned', (select jsonb_build_object('id', m.id, 'display_name', m.display_name, 'body', m.body, 'is_staff', m.is_staff) from public.chat_messages m where m.id = s.pinned_id and m.removed_at is null))
  from public.chat_settings s where s.id = 1
$$;

-- A player reports a message (once per message; at most 20 reports an hour).
create or replace function public.report_chat(p_message bigint, p_reason text default '') returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.profiles where id = uid and deleted_at is null) then raise exception 'no_account'; end if;
  if not exists (select 1 from public.chat_messages where id = p_message and removed_at is null) then raise exception 'message_not_found'; end if;
  if (select count(*) from public.chat_reports where reporter = uid and created_at > now() - interval '1 hour') >= 20 then raise exception 'too_many_attempts'; end if;
  insert into public.chat_reports (message_id, reporter, reason) values (p_message, uid, left(coalesce(trim(p_reason), ''), 200)) on conflict (message_id, reporter) do nothing;
  return jsonb_build_object('reported', true);
end $$;

-- Warnings the player has not read yet, and marking one read.
create or replace function public.my_notices() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'message', message, 'at', created_at) order by id), '[]'::jsonb)
  from public.account_flags where user_id = auth.uid() and kind = 'warn' and lifted_at is null and seen_at is null
$$;
create or replace function public.ack_notice(p_id bigint) returns void language sql security definer set search_path = public, pg_temp as $$
  update public.account_flags set seen_at = now() where id = p_id and user_id = auth.uid() and kind = 'warn' and seen_at is null
$$;

-- ============================ dashboard ===========================================================================================
create or replace function public.admin_dashboard() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('dashboard.view'); t0 timestamptz := public.rg_day_start(0);
begin
  return jsonb_build_object(
    'players', jsonb_build_object(
      'total', (select count(*) from public.profiles where deleted_at is null),
      'new_today', (select count(*) from public.profiles where created_at >= t0),
      'new_7d', (select count(*) from public.profiles where created_at >= public.rg_day_start(6)),
      'active_15m', (select count(distinct u) from (select user_id as u from public.bets where created_at > now() - interval '15 minutes'
                      union all select user_id from public.round_bets where created_at > now() - interval '15 minutes'
                      union all select user_id from public.chat_messages where created_at > now() - interval '15 minutes') a),
      'active_today', (select count(distinct u) from (select user_id as u from public.bets where created_at >= t0
                      union all select user_id from public.round_bets where created_at >= t0
                      union all select user_id from public.chat_messages where created_at >= t0) a)),
    'bets_15m', (select jsonb_build_object('count', count(*), 'staked', coalesce(sum(amount), 0)) from public.bets where created_at > now() - interval '15 minutes'),
    'chat_15m', (select count(*) from public.chat_messages where created_at > now() - interval '15 minutes'),
    'rooms', jsonb_build_object(
      'battles_waiting', (select count(*) from public.live_battles where status = 'waiting'),
      'coinflips_waiting', (select count(*) from public.live_coinflips where status = 'waiting'),
      'stuck', (select count(*) from public.live_battles where status = 'waiting' and created_at < now() - interval '30 minutes')
             + (select count(*) from public.live_coinflips where status = 'waiting' and created_at < now() - interval '30 minutes')),
    'rounds', coalesce((select jsonb_agg(x order by x ->> 'game') from (
        select jsonb_build_object('game', r.game, 'id', r.id, 'status', r.status, 'betting_ends_at', r.betting_ends_at,
               'bets', (select count(*) from public.round_bets b where b.round_id = r.id), 'staked', (select coalesce(sum(amount), 0) from public.round_bets b where b.round_id = r.id)) as x
          from (select distinct on (game) * from public.game_rounds order by game, id desc) r) q), '[]'::jsonb),
    'flags', (select jsonb_build_object('mute', count(*) filter (where kind = 'mute'), 'warn', count(*) filter (where kind = 'warn'), 'bet_ban', count(*) filter (where kind = 'bet_ban'),
                                        'site_ban', count(*) filter (where kind = 'site_ban'))
                from public.account_flags where lifted_at is null and (until is null or until > now())),
    'reports_open', (select count(*) from public.chat_reports where resolved_at is null),
    'site', (select jsonb_build_object('maintenance_on', maintenance_on, 'notice_on', notice_on, 'games_off', games_off, 'signups_open', signups_open) from public.site_controls where id = 1),
    'chat', (select jsonb_build_object('locked', locked, 'slow_seconds', slow_seconds) from public.chat_settings where id = 1),
    'signups_7d', coalesce((select jsonb_agg(jsonb_build_object('day', d::date, 'count', (select count(*) from public.profiles p where p.created_at >= d and p.created_at < d + interval '1 day')) order by d)
                            from generate_series(public.rg_day_start(6), t0, interval '1 day') d), '[]'::jsonb),
    'bets_24h', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'count', (select count(*) from public.bets b where b.created_at >= h and b.created_at < h + interval '1 hour'),
                                                             'staked', (select coalesce(sum(amount), 0) from public.bets b where b.created_at >= h and b.created_at < h + interval '1 hour')) order by h)
                          from generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h), '[]'::jsonb),
    'now', (extract(epoch from now()) * 1000)::bigint);
end $$;

-- ============================ players =============================================================================================
-- p_filter: '' (everyone), 'banned', 'muted', 'warned', 'excluded', 'closed', 'staff', or 'tag:<tag>'.
create or replace function public.admin_players(p_query text default '', p_filter text default '', p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.view'); q text := replace(replace(trim(coalesce(p_query, '')), '%', ''), '_', ''); f text := coalesce(p_filter, '');
        lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); off integer := greatest(coalesce(p_offset, 0), 0); is_id boolean;
begin
  is_id := q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', p.id, 'name', p.display_name, 'created_at', p.created_at, 'closed', p.deleted_at is not null,
      'staff_role', public.admin_role_of(p.id), 'balance', w.balance, 'wagered', w.wagered,
      'last_seen', greatest((select max(created_at) from public.bets b where b.user_id = p.id), (select max(created_at) from public.round_bets b where b.user_id = p.id),
                            (select max(created_at) from public.chat_messages m where m.user_id = p.id)),
      'flags', coalesce((select jsonb_agg(distinct kind) from public.account_flags a where a.user_id = p.id and a.lifted_at is null and (a.until is null or a.until > now())), '[]'::jsonb),
      'tags', coalesce((select jsonb_agg(tag order by tag) from public.player_tags t where t.user_id = p.id), '[]'::jsonb),
      'excluded', exists (select 1 from public.account_controls c where c.user_id = p.id and (c.excluded_until > now() or c.cool_off_until > now()))) as x
    from public.profiles p left join public.wallets w on w.user_id = p.id
    where (q = '' or (is_id and p.id = q::uuid) or (not is_id and p.display_name ilike '%' || q || '%'))
      and case
        when f = '' then true
        when f = 'banned' then exists (select 1 from public.account_flags a where a.user_id = p.id and a.kind in ('bet_ban', 'site_ban') and a.lifted_at is null and (a.until is null or a.until > now()))
        when f = 'muted' then exists (select 1 from public.account_flags a where a.user_id = p.id and a.kind = 'mute' and a.lifted_at is null and (a.until is null or a.until > now()))
        when f = 'warned' then exists (select 1 from public.account_flags a where a.user_id = p.id and a.kind = 'warn' and a.lifted_at is null)
        when f = 'excluded' then exists (select 1 from public.account_controls c where c.user_id = p.id and (c.excluded_until > now() or c.cool_off_until > now()))
        when f = 'closed' then p.deleted_at is not null
        when f = 'staff' then public.admin_role_of(p.id) is not null
        when f like 'tag:%' then exists (select 1 from public.player_tags t where t.user_id = p.id and t.tag = substr(f, 5))
        else false end
    order by p.created_at desc limit lim offset off) s), '[]'::jsonb);
end $$;

create or replace function public.admin_player(p_user uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.view'); me text := public.admin_role_of(auth.uid()); pr public.profiles; au jsonb;
begin
  select * into pr from public.profiles where id = p_user;
  if pr.id is null then raise exception 'player_not_found'; end if;
  begin
    execute 'select jsonb_build_object(''provider'', raw_app_meta_data ->> ''provider'', ''last_sign_in_at'', last_sign_in_at, ''banned_until'', banned_until) from auth.users where id = $1' into au using p_user;
  exception when others then au := null; end;
  return jsonb_build_object(
    'player', jsonb_build_object('id', pr.id, 'name', pr.display_name, 'created_at', pr.created_at, 'closed', pr.deleted_at is not null, 'closed_at', pr.deleted_at,
      'age_confirmed_at', pr.age_confirmed_at, 'terms_version', pr.terms_version, 'staff_role', public.admin_role_of(pr.id), 'sign_in', au),
    'wallet', case when public.admin_has_perm(me, 'ledger.view') then (select jsonb_build_object('balance', balance, 'wagered', wagered, 'won', won) from public.wallets where user_id = p_user) end,
    'flags', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'until', until, 'message', message, 'reason', reason, 'at', created_at, 'by', (select display_name from public.profiles x where x.id = a.created_by),
                        'seen_at', seen_at, 'lifted_at', lifted_at, 'lift_reason', lift_reason, 'active', lifted_at is null and (until is null or until > now())) order by id desc)
                      from (select * from public.account_flags where user_id = p_user order by id desc limit 50) a), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'body', body, 'author', author_name, 'at', created_at) order by id desc)
                      from (select * from public.player_notes where user_id = p_user order by id desc limit 50) n), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(tag order by tag) from public.player_tags where user_id = p_user), '[]'::jsonb),
    'chat', case when public.admin_has_perm(me, 'chat.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'body', body, 'at', created_at, 'removed_at', removed_at) order by id desc)
                      from (select * from public.chat_messages where user_id = p_user order by id desc limit 30) m), '[]'::jsonb) end,
    'bets', case when public.admin_has_perm(me, 'ledger.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'game', game, 'amount', amount, 'payout', payout, 'at', created_at) order by id desc)
                      from (select * from public.bets where user_id = p_user order by id desc limit 20) b), '[]'::jsonb) end,
    'games', jsonb_build_object('battles', (select count(*) from public.live_battles where p_user = any (player_ids)),
                                'coinflips', (select count(*) from public.live_coinflips where creator = p_user or joiner = p_user),
                                'round_bets', (select count(*) from public.round_bets where user_id = p_user)),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'at', claimed_at) order by kind) from public.free_claims where user_id = p_user), '[]'::jsonb),
    'controls', case when public.admin_has_perm(me, 'rg.view') then (select jsonb_build_object('excluded_until', excluded_until, 'cool_off_until', cool_off_until, 'kyc_tier', kyc_tier) from public.account_controls where user_id = p_user) end,
    'actions', case when public.admin_has_perm(me, 'audit.read') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', at, 'action', action, 'actor', actor_name, 'reason', reason) order by id desc)
                      from (select * from public.admin_audit_log where target_id = p_user::text order by id desc limit 50) l), '[]'::jsonb) end);
end $$;

create or replace function public.admin_player_note(p_user uuid, p_body text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.notes'); body text := trim(coalesce(p_body, '')); nid bigint;
begin
  if body = '' then raise exception 'text_required'; end if;
  if char_length(body) > 1000 then raise exception 'text_too_long'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'player_not_found'; end if;
  insert into public.player_notes (user_id, author, author_name, body) values (p_user, uid, (select display_name from public.profiles where id = uid), body) returning id into nid;
  perform public.admin_log('player.note', 'player', p_user::text, null, jsonb_build_object('note_id', nid), null, jsonb_build_object('length', char_length(body)));
  return jsonb_build_object('id', nid);
end $$;

create or replace function public.admin_player_tag(p_user uuid, p_tag text, p_on boolean) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.tags');
begin
  if p_tag is null or p_tag not in ('vip', 'watch', 'friend', 'tester', 'streamer') then raise exception 'invalid_value'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'player_not_found'; end if;
  if p_on then insert into public.player_tags (user_id, tag, added_by) values (p_user, p_tag, uid) on conflict do nothing;
  else delete from public.player_tags where user_id = p_user and tag = p_tag; end if;
  perform public.admin_log(case when p_on then 'player.tag' else 'player.untag' end, 'player', p_user::text, null, jsonb_build_object('tag', p_tag));
  return coalesce((select jsonb_agg(tag order by tag) from public.player_tags where user_id = p_user), '[]'::jsonb);
end $$;

-- ============================ account actions ======================================================================================
-- p_minutes: how long (null = until lifted; a warning has no duration). p_message: what the player is told (required for a warning).
create or replace function public.admin_flag_player(p_user uuid, p_kind text, p_minutes integer, p_message text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid; why text := public.admin_need_reason(p_reason); pr public.profiles; till timestamptz; fid bigint; msg text := trim(coalesce(p_message, '')); cut boolean := null;
begin
  if p_kind is null or p_kind not in ('mute', 'warn', 'bet_ban', 'site_ban') then raise exception 'invalid_value'; end if;
  uid := public.admin_guard(case when p_kind in ('mute', 'warn') then 'accounts.mute' else 'accounts.ban' end);
  pr := public.admin_target(p_user);
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 525600) then raise exception 'invalid_value'; end if;       -- up to a year
  if char_length(msg) > 300 then raise exception 'text_too_long'; end if;
  if p_kind = 'warn' and msg = '' then raise exception 'text_required'; end if;
  till := case when p_kind = 'warn' or p_minutes is null then null else now() + make_interval(mins => p_minutes) end;
  insert into public.account_flags (user_id, kind, until, message, reason, created_by) values (p_user, p_kind, till, msg, why, uid) returning id into fid;
  if p_kind = 'site_ban' then cut := public.auth_cut(p_user, coalesce(till, now() + interval '100 years'), true); end if;
  perform public.admin_log('account.' || p_kind, 'player', p_user::text, null, jsonb_build_object('until', till, 'message', msg), why, jsonb_build_object('flag_id', fid, 'signed_out', cut));
  return jsonb_build_object('id', fid, 'until', till, 'signed_out', cut);
end $$;

create or replace function public.admin_lift_flag(p_flag bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard(null); why text := public.admin_need_reason(p_reason); f public.account_flags; cut boolean := null;
begin
  select * into f from public.account_flags where id = p_flag for update;
  if f.id is null then raise exception 'invalid_value'; end if;
  uid := public.admin_guard(case when f.kind in ('mute', 'warn') then 'accounts.mute' else 'accounts.ban' end);
  perform public.admin_target(f.user_id, false);
  if f.lifted_at is not null then return jsonb_build_object('id', f.id, 'lifted_at', f.lifted_at); end if;
  update public.account_flags set lifted_at = now(), lifted_by = uid, lift_reason = why where id = p_flag;
  if f.kind = 'site_ban' and not public.flag_active(f.user_id, 'site_ban') then
    begin execute 'update auth.users set banned_until = null where id = $1' using f.user_id; cut := true;
    exception when insufficient_privilege or undefined_table or undefined_column then cut := false; end;
  end if;
  perform public.admin_log('account.lift_' || f.kind, 'player', f.user_id::text, jsonb_build_object('flag_id', f.id, 'until', f.until), null, why, jsonb_build_object('sign_in_restored', cut));
  return jsonb_build_object('id', f.id, 'lifted_at', now());
end $$;

create or replace function public.admin_sign_out(p_user uuid, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('accounts.signout'); why text := public.admin_need_reason(p_reason); cut boolean;
begin
  perform public.admin_target(p_user, false);
  cut := public.auth_cut(p_user);
  perform public.admin_log('account.sign_out', 'player', p_user::text, null, null, why, jsonb_build_object('signed_out', cut));
  return jsonb_build_object('signed_out', cut);
end $$;

create or replace function public.admin_rename(p_user uuid, p_name text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('accounts.rename'); why text := public.admin_need_reason(p_reason); pr public.profiles; nm text := trim(coalesce(p_name, ''));
begin
  pr := public.admin_target(p_user);
  if nm !~ '^[A-Za-z0-9_ -]{2,20}$' or lower(nm) like 'deleted-%' or lower(nm) like 'player-%' then raise exception 'invalid_name'; end if;
  begin update public.profiles set display_name = nm where id = p_user;
  exception when unique_violation then raise exception 'name_taken'; end;
  perform public.admin_log('account.rename', 'player', p_user::text, jsonb_build_object('name', pr.display_name), jsonb_build_object('name', nm), why);
  return jsonb_build_object('name', nm);
end $$;

create or replace function public.admin_reset_claim(p_user uuid, p_kind text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rewards.edit'); why text := public.admin_need_reason(p_reason); was timestamptz;
begin
  if p_kind is null or p_kind not in ('welcome', 'daily_case') then raise exception 'invalid_value'; end if;
  perform public.admin_target(p_user);
  delete from public.free_claims where user_id = p_user and kind = p_kind returning claimed_at into was;
  perform public.admin_log('account.reset_claim', 'player', p_user::text, jsonb_build_object('kind', p_kind, 'claimed_at', was), null, why);
  return jsonb_build_object('kind', p_kind, 'was', was);
end $$;

-- Close and anonymise, as delete_account() does for a player's own account, and refuse their sign-in from then on.
-- p_confirm must repeat the player's current name, so a slip of the mouse cannot close the wrong account.
create or replace function public.admin_close_account(p_user uuid, p_confirm text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('accounts.close'); why text := public.admin_need_reason(p_reason); pr public.profiles; bal numeric; anon text; cut boolean;
begin
  pr := public.admin_target(p_user);
  if public.admin_role_of(p_user) is not null then raise exception 'staff_account'; end if;
  if coalesce(trim(p_confirm), '') <> pr.display_name then raise exception 'confirm_mismatch'; end if;
  anon := 'deleted-' || substr(replace(p_user::text, '-', ''), 1, 8);
  select balance into bal from public.wallets where user_id = p_user for update;
  if bal > 0 then
    update public.wallets set balance = 0, updated_at = now() where user_id = p_user;
    insert into public.ledger (user_id, kind, amount, balance_after) values (p_user, 'adjustment', -bal, 0);
  end if;
  delete from public.chat_messages where user_id = p_user;
  delete from public.limit_changes where user_id = p_user;
  update public.live_coinflips set creator_name = anon where creator = p_user;
  update public.live_coinflips set joiner_name = anon where joiner = p_user;
  update public.live_battles b
     set seats = (select jsonb_agg(case when e <> 'null'::jsonb and e ->> 'uid' = p_user::text then jsonb_set(e, '{name}', to_jsonb(anon)) else e end order by ord)
                    from jsonb_array_elements(b.seats) with ordinality as t(e, ord))
   where p_user = any (b.player_ids);
  update public.round_bets set display_name = anon where user_id = p_user;
  update public.profiles set display_name = anon, deleted_at = now() where id = p_user;
  cut := public.auth_cut(p_user, now() + interval '100 years', true);
  perform public.admin_log('account.close', 'player', p_user::text, jsonb_build_object('name', pr.display_name, 'balance', bal), jsonb_build_object('name', anon), why, jsonb_build_object('signed_out', cut));
  return jsonb_build_object('name', anon, 'balance_removed', coalesce(bal, 0), 'signed_out', cut);
end $$;

-- ============================ chat moderation ======================================================================================
create or replace function public.admin_chat(p_before bigint default null, p_query text default '', p_only_removed boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.view'); q text := replace(replace(trim(coalesce(p_query, '')), '%', ''), '_', '');
begin
  return jsonb_build_object(
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'name', display_name, 'body', body, 'at', created_at, 'is_staff', is_staff,
                     'removed_at', removed_at, 'removed_by', (select display_name from public.profiles x where x.id = m.removed_by),
                     'reports', (select count(*) from public.chat_reports r where r.message_id = m.id and r.resolved_at is null)) order by id desc)
                   from (select * from public.chat_messages where (p_before is null or id < p_before) and (q = '' or body ilike '%' || q || '%' or display_name ilike '%' || q || '%')
                           and (not p_only_removed or removed_at is not null) order by id desc limit 100) m), '[]'::jsonb),
    'settings', (select to_jsonb(s) - 'id' from public.chat_settings s where s.id = 1));
end $$;

create or replace function public.admin_chat_remove(p_message bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.delete'); why text := public.admin_need_reason(p_reason); m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message for update;
  if m.id is null then raise exception 'message_not_found'; end if;
  if m.removed_at is null then
    update public.chat_messages set body = 'removed', removed_at = now(), removed_by = uid where id = p_message;
    update public.chat_reports set resolved_at = now(), resolved_by = uid, outcome = 'removed' where message_id = p_message and resolved_at is null;
    update public.chat_settings set pinned_id = null where pinned_id = p_message;
    perform public.admin_log('chat.remove', 'player', m.user_id::text, jsonb_build_object('message_id', m.id, 'body', m.body, 'name', m.display_name), null, why);
  end if;
  return jsonb_build_object('id', p_message, 'removed', true);
end $$;

-- Removes every message of the last p_minutes (1 to 1440).
create or replace function public.admin_chat_clear(p_minutes integer, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.delete'); why text := public.admin_need_reason(p_reason); n integer;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then raise exception 'invalid_value'; end if;
  update public.chat_messages set body = 'removed', removed_at = now(), removed_by = uid where removed_at is null and created_at > now() - make_interval(mins => p_minutes);
  get diagnostics n = row_count;
  update public.chat_reports r set resolved_at = now(), resolved_by = uid, outcome = 'removed'
   where resolved_at is null and exists (select 1 from public.chat_messages m where m.id = r.message_id and m.removed_at is not null);
  update public.chat_settings set pinned_id = null where pinned_id in (select id from public.chat_messages where removed_at is not null);
  perform public.admin_log('chat.clear', null, null, null, jsonb_build_object('removed', n, 'minutes', p_minutes), why);
  return jsonb_build_object('removed', n);
end $$;

create or replace function public.admin_chat_settings(p_slow integer, p_locked boolean, p_links boolean, p_words text[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.settings'); why text := public.admin_need_reason(p_reason); old public.chat_settings; words text[];
begin
  if p_slow is null or p_slow < 0 or p_slow > 300 or p_locked is null or p_links is null then raise exception 'invalid_value'; end if;
  select coalesce(array_agg(distinct w order by w), '{}') into words from (select lower(trim(x)) as w from unnest(coalesce(p_words, '{}')) x) t where w <> '';
  if cardinality(words) > 200 or exists (select 1 from unnest(words) w where char_length(w) > 40) then raise exception 'text_too_long'; end if;
  select * into old from public.chat_settings where id = 1;
  update public.chat_settings set slow_seconds = p_slow, locked = p_locked, links_allowed = p_links, blocked_words = words, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('chat.settings', null, null, jsonb_build_object('slow_seconds', old.slow_seconds, 'locked', old.locked, 'links_allowed', old.links_allowed, 'words', cardinality(old.blocked_words)),
                           jsonb_build_object('slow_seconds', p_slow, 'locked', p_locked, 'links_allowed', p_links, 'words', cardinality(words)), why);
  return (select to_jsonb(s) - 'id' from public.chat_settings s where s.id = 1);
end $$;

-- Pin a message (or unpin with null).
create or replace function public.admin_chat_pin(p_message bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.post'); why text := public.admin_need_reason(p_reason);
begin
  if p_message is not null and not exists (select 1 from public.chat_messages where id = p_message and removed_at is null) then raise exception 'message_not_found'; end if;
  update public.chat_settings set pinned_id = p_message, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log(case when p_message is null then 'chat.unpin' else 'chat.pin' end, null, p_message::text, null, null, why);
  return public.chat_status();
end $$;

-- A message from staff, shown with a staff badge.
create or replace function public.admin_chat_post(p_body text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.post'); body text := trim(coalesce(p_body, '')); mid bigint;
begin
  if body = '' then raise exception 'text_required'; end if;
  if char_length(body) > 140 then raise exception 'text_too_long'; end if;
  insert into public.chat_messages (user_id, body, is_staff) values (uid, body, true) returning id into mid;       -- chat_moderate leaves staff rows as they are
  perform public.admin_log('chat.post', null, mid::text, null, jsonb_build_object('body', body));
  return jsonb_build_object('id', mid);
end $$;

create or replace function public.admin_chat_reports(p_open boolean default true) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'message_id', r.message_id, 'body', m.body, 'author', m.display_name, 'author_id', m.user_id, 'removed', m.removed_at is not null,
                     'reporter', (select display_name from public.profiles x where x.id = r.reporter), 'reason', r.reason, 'at', r.created_at, 'resolved_at', r.resolved_at, 'outcome', r.outcome) order by r.id desc)
                   from (select * from public.chat_reports where (p_open and resolved_at is null) or (not p_open and resolved_at is not null) order by id desc limit 200) r
                   join public.chat_messages m on m.id = r.message_id), '[]'::jsonb);
end $$;

create or replace function public.admin_chat_dismiss(p_report bigint, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('chat.delete'); why text := public.admin_need_reason(p_reason); r public.chat_reports;
begin
  select * into r from public.chat_reports where id = p_report;
  if r.id is null then raise exception 'invalid_value'; end if;
  update public.chat_reports set resolved_at = now(), resolved_by = uid, outcome = 'dismissed' where message_id = r.message_id and resolved_at is null;
  perform public.admin_log('chat.dismiss_report', null, r.message_id::text, null, null, why);
  return jsonb_build_object('id', p_report, 'outcome', 'dismissed');
end $$;

-- ============================ live rooms ==========================================================================================
create or replace function public.admin_rooms(p_kind text, p_status text default null, p_limit integer default 50) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rooms.view'); lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if p_kind = 'battles' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'format', b.format, 'mode', b.mode, 'cases', b.case_ids, 'seats', b.seats, 'status', b.status, 'cost', public.battle_cost(b.case_ids),
              'creator', (select display_name from public.profiles x where x.id = b.creator), 'created_at', b.created_at, 'started_at', b.started_at, 'server_hash', b.server_hash,
              'seed', case when b.status = 'running' then (select server_seed from public.live_battle_secrets s where s.battle_id = b.id) end,
              'stuck', b.status = 'waiting' and b.created_at < now() - interval '30 minutes',
              'flags', coalesce((select jsonb_agg(jsonb_build_object('flag', f.flag, 'reason', f.reason, 'at', f.created_at)) from public.room_flags f where f.kind = 'battle' and f.ref = b.id::text), '[]'::jsonb)) order by b.created_at desc)
            from (select * from public.live_battles where p_status is null or status = p_status order by created_at desc limit lim) b), '[]'::jsonb);
  elsif p_kind = 'coinflips' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'creator', f.creator_name, 'side', f.side, 'amount', f.amount, 'joiner', f.joiner_name, 'bot', f.status = 'done' and f.joiner is null,
              'status', f.status, 'result', f.result, 'winner', case when f.winner is null then null when f.winner = f.creator then f.creator_name else coalesce(f.joiner_name, 'bot') end,
              'created_at', f.created_at, 'finished_at', f.finished_at, 'server_hash', f.server_hash,
              'seed', case when f.status = 'done' then (select server_seed from public.live_coinflip_secrets s where s.flip_id = f.id) end,
              'stuck', f.status = 'waiting' and f.created_at < now() - interval '30 minutes',
              'flags', coalesce((select jsonb_agg(jsonb_build_object('flag', g.flag, 'reason', g.reason, 'at', g.created_at)) from public.room_flags g where g.kind = 'coinflip' and g.ref = f.id::text), '[]'::jsonb)) order by f.id desc)
            from (select * from public.live_coinflips where p_status is null or status = p_status order by id desc limit lim) f), '[]'::jsonb);
  end if;
  raise exception 'invalid_value';
end $$;

-- Cancel a lobby nobody has started yet; every stake goes back, as when the creator leaves.
create or replace function public.admin_room_cancel(p_kind text, p_id text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rooms.cancel'); why text := public.admin_need_reason(p_reason); b public.live_battles; f public.live_coinflips; u uuid; cost numeric; n integer := 0;
begin
  if p_kind = 'battle' then
    select * into b from public.live_battles where id = p_id::uuid for update;
    if b.id is null then raise exception 'battle_not_found'; end if;
    if b.status <> 'waiting' then raise exception 'already_started'; end if;
    update public.live_battles set status = 'cancelled' where id = b.id;
    cost := public.battle_cost(b.case_ids);
    foreach u in array b.player_ids loop perform public.wallet_credit(u, cost, 'refund'); n := n + 1; end loop;
    perform public.admin_log('rooms.cancel', 'battle', b.id::text, jsonb_build_object('status', 'waiting'), jsonb_build_object('status', 'cancelled'), why, jsonb_build_object('refunded', n, 'each', cost));
    return jsonb_build_object('refunded', n, 'each', cost);
  elsif p_kind = 'coinflip' then
    select * into f from public.live_coinflips where id = p_id::bigint for update;
    if f.id is null then raise exception 'flip_not_found'; end if;
    if f.status <> 'waiting' then raise exception 'flip_not_open'; end if;
    update public.live_coinflips set status = 'cancelled', finished_at = now() where id = f.id;
    perform public.wallet_credit(f.creator, f.amount, 'refund');
    perform public.admin_log('rooms.cancel', 'coinflip', f.id::text, jsonb_build_object('status', 'waiting'), jsonb_build_object('status', 'cancelled'), why, jsonb_build_object('refunded', 1, 'each', f.amount));
    return jsonb_build_object('refunded', 1, 'each', f.amount);
  end if;
  raise exception 'invalid_value';
exception when invalid_text_representation then raise exception 'invalid_value';
end $$;

-- Mark a battle, coinflip or round as suspicious or void. A record only: no coins move (correct them on the Wallets page).
create or replace function public.admin_room_flag(p_kind text, p_id text, p_flag text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid; why text := public.admin_need_reason(p_reason); fid bigint;
begin
  if p_kind is null or p_kind not in ('battle', 'coinflip', 'round') or p_flag is null or p_flag not in ('suspicious', 'void') then raise exception 'invalid_value'; end if;
  uid := public.admin_guard(case when p_kind = 'round' then 'rounds.void' when p_flag = 'void' then 'rooms.void' else 'rooms.cancel' end);
  if (p_kind = 'battle' and not exists (select 1 from public.live_battles where id::text = p_id))
     or (p_kind = 'coinflip' and not exists (select 1 from public.live_coinflips where id::text = p_id))
     or (p_kind = 'round' and not exists (select 1 from public.game_rounds where id::text = p_id)) then raise exception 'invalid_value'; end if;
  insert into public.room_flags (kind, ref, flag, reason, created_by) values (p_kind, p_id, p_flag, why, uid) returning id into fid;
  perform public.admin_log('rooms.' || p_flag, p_kind, p_id, null, null, why);
  return jsonb_build_object('id', fid);
end $$;

-- ============================ rounds ==============================================================================================
create or replace function public.admin_rounds(p_game text, p_before bigint default null, p_limit integer default 30) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rounds.view'); lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if p_game is null or p_game not in ('crash', 'double') then raise exception 'invalid_game'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'created_at', r.created_at, 'betting_ends_at', r.betting_ends_at, 'finished_at', r.finished_at,
            'server_hash', r.server_hash, 'result', case when r.status = 'finished' or p_game = 'double' then r.result end,
            'seed', case when r.status = 'finished' then (select server_seed from public.game_round_secrets s where s.round_id = r.id) end,
            'bets', (select count(*) from public.round_bets b where b.round_id = r.id), 'staked', (select coalesce(sum(amount), 0) from public.round_bets b where b.round_id = r.id),
            'paid', case when r.status = 'finished' then (select coalesce(sum(locked), 0) from public.round_bets b where b.round_id = r.id) end,
            'flags', coalesce((select jsonb_agg(jsonb_build_object('flag', f.flag, 'reason', f.reason, 'at', f.created_at)) from public.room_flags f where f.kind = 'round' and f.ref = r.id::text), '[]'::jsonb)) order by r.id desc)
          from (select * from public.game_rounds where game = p_game and (p_before is null or id < p_before) order by id desc limit lim) r), '[]'::jsonb);
end $$;

-- The bets of one round. While a Crash round runs, its crash point stays secret (only the finished round shows it).
create or replace function public.admin_round_bets(p_round bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('rounds.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'user_id', b.user_id, 'name', b.display_name, 'lane', b.lane, 'amount', b.amount, 'auto_cashout', b.auto_cashout,
            'cashouts', b.cashouts, 'paid', b.locked, 'done', b.done, 'at', b.created_at) order by b.amount desc, b.id)
          from public.round_bets b where b.round_id = p_round), '[]'::jsonb);
end $$;

-- Recomputes a finished round from its revealed seed: does the seed match the published hash, and does it give the recorded result?
create or replace function public.admin_round_verify(p_round bigint) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := public.admin_guard('rounds.view'); r public.game_rounds; seed text; f double precision; expected jsonb; hash_ok boolean;
begin
  select * into r from public.game_rounds where id = p_round;
  if r.id is null then raise exception 'invalid_value'; end if;
  if r.status <> 'finished' then raise exception 'round_not_finished'; end if;
  select server_seed into seed from public.game_round_secrets where round_id = r.id;
  hash_ok := encode(digest(seed, 'sha256'), 'hex') = r.server_hash;
  f := public.round_float(seed, r.id);
  expected := case when r.game = 'crash' then jsonb_build_object('point', public.crash_point_of(f)) else jsonb_build_object('n', floor(f * 15)::integer) end;
  return jsonb_build_object('id', r.id, 'game', r.game, 'hash_ok', hash_ok, 'recorded', r.result, 'recomputed', expected,
                            'result_ok', case when r.game = 'crash' then (r.result ->> 'point')::numeric = (expected ->> 'point')::numeric else (r.result ->> 'n')::integer = (expected ->> 'n')::integer end);
end $$;

-- ============================ privileges ==========================================================================================
revoke execute on function public.flag_active(uuid, text), public.admin_target(uuid, boolean), public.auth_cut(uuid, timestamptz, boolean) from public, anon, authenticated;
revoke execute on function public.chat_status(), public.report_chat(bigint, text), public.my_notices(), public.ack_notice(bigint),
  public.admin_dashboard(), public.admin_players(text, text, integer, integer), public.admin_player(uuid), public.admin_player_note(uuid, text), public.admin_player_tag(uuid, text, boolean),
  public.admin_flag_player(uuid, text, integer, text, text), public.admin_lift_flag(bigint, text), public.admin_sign_out(uuid, text), public.admin_rename(uuid, text, text),
  public.admin_reset_claim(uuid, text, text), public.admin_close_account(uuid, text, text),
  public.admin_chat(bigint, text, boolean), public.admin_chat_remove(bigint, text), public.admin_chat_clear(integer, text), public.admin_chat_settings(integer, boolean, boolean, text[], text),
  public.admin_chat_pin(bigint, text), public.admin_chat_post(text), public.admin_chat_reports(boolean), public.admin_chat_dismiss(bigint, text),
  public.admin_rooms(text, text, integer), public.admin_room_cancel(text, text, text), public.admin_room_flag(text, text, text, text),
  public.admin_rounds(text, bigint, integer), public.admin_round_bets(bigint), public.admin_round_verify(bigint) from public, anon;
grant execute on function public.chat_status(), public.report_chat(bigint, text), public.my_notices(), public.ack_notice(bigint),
  public.admin_dashboard(), public.admin_players(text, text, integer, integer), public.admin_player(uuid), public.admin_player_note(uuid, text), public.admin_player_tag(uuid, text, boolean),
  public.admin_flag_player(uuid, text, integer, text, text), public.admin_lift_flag(bigint, text), public.admin_sign_out(uuid, text), public.admin_rename(uuid, text, text),
  public.admin_reset_claim(uuid, text, text), public.admin_close_account(uuid, text, text),
  public.admin_chat(bigint, text, boolean), public.admin_chat_remove(bigint, text), public.admin_chat_clear(integer, text), public.admin_chat_settings(integer, boolean, boolean, text[], text),
  public.admin_chat_pin(bigint, text), public.admin_chat_post(text), public.admin_chat_reports(boolean), public.admin_chat_dismiss(bigint, text),
  public.admin_rooms(text, text, integer), public.admin_room_cancel(text, text, text), public.admin_room_flag(text, text, text, text),
  public.admin_rounds(text, bigint, integer), public.admin_round_bets(bigint), public.admin_round_verify(bigint) to authenticated;
