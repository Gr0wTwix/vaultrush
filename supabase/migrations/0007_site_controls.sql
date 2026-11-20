-- Vaultrush 0007: site controls (admin step B1). Run in the Supabase SQL editor AFTER 0006_admin.sql.
--
-- One settings row that the admin site changes and the game site obeys:
--   * maintenance mode (with a message)          * a site-wide notice (info or warning)
--   * games switched on and off                  * sign-ups open or closed
--   * country restrictions
--
-- Everything the database can enforce, it enforces: the entry points of the live games, free-crate claims and sign-up refuse new activity when
-- their switch says so. Leaving and cashing out are NEVER blocked, so a paused game cannot trap anyone's stake. Staff (anyone with a role)
-- are not held back by maintenance or country rules, so the Owner can always get in to switch things back.
-- Games that still run only in the browser (Cases, Upgrade, Plinko, Mines) are paused by the page, which a determined player could bypass until the
-- wallet moves to the server (step D). That is stated honestly in docs/admin-site.md.
--
-- The country is read from the connection's country header (Supabase sits behind Cloudflare, which adds it). It is only compared against the list at the
-- moment of the request. It is not stored, and neither is the IP address. If the header is missing the country is unknown and the visitor is allowed.

create table public.site_controls (
  id                 integer primary key default 1 check (id = 1),         -- exactly one row
  maintenance_on     boolean not null default false,
  maintenance_message text not null default '' check (char_length(maintenance_message) <= 200),
  notice_on          boolean not null default false,
  notice_text        text not null default '' check (char_length(notice_text) <= 300),
  notice_kind        text not null default 'info' check (notice_kind in ('info', 'warn')),
  signups_open       boolean not null default true,
  games_off          text[] not null default '{}',
  blocked_countries  text[] not null default '{}',
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
insert into public.site_controls default values;
alter table public.site_controls enable row level security;       -- no policy: only the functions below read or write it
revoke all on public.site_controls from anon, authenticated;

-- The games that can be switched. (A new game is added here and in the page's list.)
create function public.site_games() returns text[] language sql immutable as $$
  select array['cases', 'battles', 'upgrade', 'crash', 'double', 'plinko', 'mines', 'coinflip']
$$;

-- Two-letter country of this request, or null when unknown. Cloudflare sends XX when it cannot tell.
create function public.request_country() returns text language plpgsql stable as $$
declare h text; c text;
begin
  begin h := current_setting('request.headers', true); exception when others then h := null; end;
  if h is null or h = '' then return null; end if;
  begin c := upper(nullif(trim((h::json) ->> 'cf-ipcountry'), '')); exception when others then c := null; end;
  if c is null or c !~ '^[A-Z]{2}$' or c = 'XX' then return null; end if;
  return c;
end $$;

-- The guard that the entry points call. p_game = null checks only maintenance and country (used by sign-up and free crates).
create function public.site_guard(p_game text default null) returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.site_controls; uid uuid := auth.uid(); ctry text;
begin
  if uid is not null and public.admin_role_of(uid) is not null then return; end if;           -- staff are never locked out
  select * into c from public.site_controls where id = 1;
  if c.maintenance_on then raise exception 'maintenance'; end if;
  ctry := public.request_country();
  if ctry is not null and ctry = any (c.blocked_countries) then raise exception 'country_blocked'; end if;
  if p_game is not null and p_game = any (c.games_off) then raise exception 'game_off'; end if;
end $$;

create function public.site_guard_signup() returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.site_controls;
begin
  perform public.site_guard(null);
  select * into c from public.site_controls where id = 1;
  if not c.signups_open then raise exception 'signups_closed'; end if;
end $$;

-- What the game site shows to everyone, signed in or not. Reveals only what the page needs to behave correctly.
create function public.site_status() returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.site_controls; uid uuid := auth.uid(); ctry text := public.request_country();
begin
  select * into c from public.site_controls where id = 1;
  return jsonb_build_object(
    'maintenance', c.maintenance_on, 'maintenance_message', c.maintenance_message,
    'notice', case when c.notice_on then jsonb_build_object('text', c.notice_text, 'kind', c.notice_kind) end,
    'signups_open', c.signups_open, 'games_off', to_jsonb(c.games_off),
    'country', ctry, 'country_blocked', ctry is not null and ctry = any (c.blocked_countries),
    'staff', uid is not null and public.admin_role_of(uid) is not null);
end $$;

-- ============================ put the guard into the existing entry points ===========================================================
-- Done by editing the stored function text, so the earlier migrations stay as they are. It fails loudly if an anchor is not found exactly once.
-- (A later migration that rewrites one of these functions must keep its guard line: tests/site-db.test.ts checks every one.)
create function pg_temp.guard_inject(p_fn text, p_re text, p_before boolean, p_stmt text) returns void language plpgsql as $$
declare fid oid; def text; n integer;
begin
  select p.oid into fid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if fid is null then raise exception 'guard_inject: % not found', p_fn; end if;
  def := pg_get_functiondef(fid);
  if position('site_guard' in def) > 0 then return; end if;                                    -- already guarded
  select count(*) into n from regexp_matches(def, p_re, 'g');
  if n <> 1 then raise exception 'guard_inject: anchor found % times in %', n, p_fn; end if;
  def := regexp_replace(def, '(' || p_re || ')', case when p_before then p_stmt || E'\\1' else E'\\1' || p_stmt end);
  execute def;
end $$;

select pg_temp.guard_inject(f.fn, E'\nbegin\r?\n', false, format(E'  perform public.site_guard(%L);\n', f.game))
from (values
  ('create_live_battle', 'battles'), ('join_live_battle', 'battles'), ('call_live_bot', 'battles'),
  ('create_live_coinflip', 'coinflip'), ('join_live_coinflip', 'coinflip'), ('call_live_coinflip_bot', 'coinflip'),
  ('crash_place_bet', 'crash'), ('place_bet', 'crash'), ('double_place_bet', 'double'),
  ('claim_free', null)
) as f(fn, game);
-- Sign-up: only for a NEW profile (a returning player's complete_signup returns early, before this point).
select pg_temp.guard_inject('complete_signup', E'\n\\s*if p_terms_version is null or', true, E'\n  perform public.site_guard_signup();');

-- ============================ the admin functions ====================================================================================
create function public.admin_controls_json() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('maintenance_on', c.maintenance_on, 'maintenance_message', c.maintenance_message, 'notice_on', c.notice_on, 'notice_text', c.notice_text,
    'notice_kind', c.notice_kind, 'signups_open', c.signups_open, 'games_off', to_jsonb(c.games_off), 'blocked_countries', to_jsonb(c.blocked_countries),
    'games', to_jsonb(public.site_games()), 'updated_at', c.updated_at, 'updated_by', (select display_name from public.profiles where id = c.updated_by))
  from public.site_controls c where c.id = 1
$$;

create function public.admin_get_controls() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('dashboard.view');
begin
  return public.admin_controls_json();
end $$;

create function public.admin_set_maintenance(p_on boolean, p_message text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('site.maintenance'); why text := public.admin_need_reason(p_reason); b jsonb := public.admin_controls_json(); msg text := trim(coalesce(p_message, ''));
begin
  if p_on is null then raise exception 'invalid_value'; end if;
  if char_length(msg) > 200 then raise exception 'text_too_long'; end if;
  update public.site_controls set maintenance_on = p_on, maintenance_message = msg, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('site.maintenance', 'site', 'controls', jsonb_build_object('on', b -> 'maintenance_on', 'message', b -> 'maintenance_message'), jsonb_build_object('on', p_on, 'message', msg), why);
  return public.admin_controls_json();
end $$;

create function public.admin_set_notice(p_on boolean, p_text text, p_kind text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('site.notice'); why text := public.admin_need_reason(p_reason); b jsonb := public.admin_controls_json(); t text := trim(coalesce(p_text, ''));
begin
  if p_on is null or p_kind is null or p_kind not in ('info', 'warn') then raise exception 'invalid_value'; end if;
  if char_length(t) > 300 then raise exception 'text_too_long'; end if;
  if p_on and t = '' then raise exception 'text_required'; end if;
  update public.site_controls set notice_on = p_on, notice_text = t, notice_kind = p_kind, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('site.notice', 'site', 'controls', jsonb_build_object('on', b -> 'notice_on', 'text', b -> 'notice_text', 'kind', b -> 'notice_kind'), jsonb_build_object('on', p_on, 'text', t, 'kind', p_kind), why);
  return public.admin_controls_json();
end $$;

create function public.admin_set_game(p_game text, p_off boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('site.games'); why text := public.admin_need_reason(p_reason); b jsonb := public.admin_controls_json(); cur text[];
begin
  if p_off is null then raise exception 'invalid_value'; end if;
  if p_game is null or not (p_game = any (public.site_games())) then raise exception 'unknown_game'; end if;
  select games_off into cur from public.site_controls where id = 1 for update;
  update public.site_controls set games_off = case when p_off then (select array_agg(distinct x order by x) from unnest(array_append(cur, p_game)) x) else array_remove(cur, p_game) end,
         updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('site.game', 'game', p_game, jsonb_build_object('off', p_game = any (cur)), jsonb_build_object('off', p_off), why);
  return public.admin_controls_json();
end $$;

create function public.admin_set_signups(p_open boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('site.signups'); why text := public.admin_need_reason(p_reason); b jsonb := public.admin_controls_json();
begin
  if p_open is null then raise exception 'invalid_value'; end if;
  update public.site_controls set signups_open = p_open, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('site.signups', 'site', 'controls', jsonb_build_object('open', b -> 'signups_open'), jsonb_build_object('open', p_open), why);
  return public.admin_controls_json();
end $$;

-- Replace the whole list of blocked countries (two-letter codes such as US, GB). The list is normalised: upper case, no duplicates, sorted.
create function public.admin_set_countries(p_codes text[], p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('site.countries'); why text := public.admin_need_reason(p_reason); b jsonb := public.admin_controls_json(); codes text[];
begin
  if p_codes is null then raise exception 'invalid_value'; end if;
  if exists (select 1 from unnest(p_codes) x where x is null or upper(trim(x)) !~ '^[A-Z]{2}$') or cardinality(p_codes) > 250 then raise exception 'invalid_country'; end if;
  select coalesce(array_agg(distinct upper(trim(x)) order by upper(trim(x))), '{}') into codes from unnest(p_codes) x;
  update public.site_controls set blocked_countries = codes, updated_at = now(), updated_by = uid where id = 1;
  perform public.admin_log('site.countries', 'site', 'controls', jsonb_build_object('blocked', b -> 'blocked_countries'), jsonb_build_object('blocked', to_jsonb(codes)), why);
  return public.admin_controls_json();
end $$;

-- ============================ privileges ===========================================================================================
revoke execute on function public.site_games(), public.request_country(), public.site_guard(text), public.site_guard_signup(), public.admin_controls_json() from public, anon, authenticated;
revoke execute on function public.site_status(), public.admin_get_controls(), public.admin_set_maintenance(boolean, text, text), public.admin_set_notice(boolean, text, text, text),
  public.admin_set_game(text, boolean, text), public.admin_set_signups(boolean, text), public.admin_set_countries(text[], text) from public, anon, authenticated;
grant execute on function public.site_status() to anon, authenticated;
grant execute on function public.admin_get_controls(), public.admin_set_maintenance(boolean, text, text), public.admin_set_notice(boolean, text, text, text),
  public.admin_set_game(text, boolean, text), public.admin_set_signups(boolean, text), public.admin_set_countries(text[], text) to authenticated;
