-- Vaultrush backend, part 6: the admin foundation (used by the separate admin site).
-- Run once in the SQL editor after 0005_rounds.sql. After it, make YOURSELF the owner with the one-time statement at the very end.
--
-- What is in here
--   * Staff roles with a rank (owner 100 > admin 80 > moderator 60 > compliance 50 > readonly 10). Players have no role.
--   * A catalogue of permissions, and which role holds which. Every permission is a switch: a higher rank can change the permissions of a
--     LOWER rank, only for permissions it holds itself. The owner holds everything and cannot be restricted.
--   * A three-step sign-in for staff: (1) a normal sign-in (Steam), (2) a two-factor code (the session must be "aal2"), (3) an admin
--     password, checked here. Steps 2 and 3 are re-checked on EVERY admin call; the unlocked session expires after 30 idle minutes.
--   * An append-only audit log (no update or delete is granted to anyone) written inside every admin action.
--   * A read-only data explorer for the owner (every query is logged first).
-- Nothing here can move money. No admin function exists that is not guarded by admin_guard() or admin_can().

-- ============================ roles and permissions ================================================================================
create table public.admin_role_defs (
  role        text primary key,
  rank        integer not null unique check (rank between 1 and 100),
  label       text not null,
  description text not null default ''
);
insert into public.admin_role_defs (role, rank, label, description) values
  ('owner',      100, 'Owner',      'Everything. Cannot be restricted. Assigned only by SQL.'),
  ('admin',       80, 'Admin',      'Runs the site day to day. No role management, no personal-data reveal, no wallet adjustments by default.'),
  ('moderator',   60, 'Moderator',  'Chat and community tools, live rooms. No e-mail addresses by default.'),
  ('compliance',  50, 'Compliance', 'Responsible play, verification and records.'),
  ('readonly',    10, 'Read-only',  'Looks, never touches.');

create table public.admin_permissions (
  key       text primary key,
  area      text not null,
  label     text not null,
  sensitive boolean not null default false          -- shown with a warning when switched on for a role
);
insert into public.admin_permissions (key, area, label, sensitive) values
  ('dashboard.view', 'Dashboard', 'See the live dashboard', false),
  ('players.view', 'Players', 'See players and their activity', false),
  ('players.view_email', 'Players', 'Reveal a player''s e-mail address', true),
  ('players.notes', 'Players', 'Write notes on players', false),
  ('players.tags', 'Players', 'Tag players', false),
  ('accounts.mute', 'Account actions', 'Mute and warn players', false),
  ('accounts.ban', 'Account actions', 'Ban from betting or from the site', true),
  ('accounts.signout', 'Account actions', 'Force a player to sign out', false),
  ('accounts.rename', 'Account actions', 'Rename a player', false),
  ('accounts.close', 'Account actions', 'Close and anonymise an account', true),
  ('chat.view', 'Chat', 'See the live chat and reports', false),
  ('chat.delete', 'Chat', 'Delete chat messages', false),
  ('chat.mute', 'Chat', 'Mute players in chat', false),
  ('chat.settings', 'Chat', 'Slow mode, word filter, lock chat', false),
  ('chat.post', 'Chat', 'Post and pin staff messages', false),
  ('rooms.view', 'Live rooms', 'See battles and coinflips', false),
  ('rooms.cancel', 'Live rooms', 'Cancel a waiting lobby', false),
  ('rooms.void', 'Live rooms', 'Void a finished game', true),
  ('rounds.view', 'Rounds', 'See Crash and Double rounds', false),
  ('rounds.pause', 'Rounds', 'Pause or resume a game', true),
  ('rounds.void', 'Rounds', 'Void a round', true),
  ('rounds.settings', 'Rounds', 'Change round timings', true),
  ('site.maintenance', 'Site', 'Switch maintenance mode', true),
  ('site.notice', 'Site', 'Show a site-wide notice', false),
  ('site.games', 'Site', 'Switch games on and off', true),
  ('site.countries', 'Site', 'Country restrictions', true),
  ('site.signups', 'Site', 'Open or close sign-ups', true),
  ('ledger.view', 'Money', 'See bets, wallets and the ledger', false),
  ('wallet.adjust', 'Money', 'Credit or debit a player''s wallet', true),
  ('rg.view', 'Responsible play', 'See limits, exclusions and risky play', false),
  ('rg.apply', 'Responsible play', 'Apply cool-offs, exclusions and tighter limits', true),
  ('compliance.view', 'Compliance', 'See verification and AML queues', false),
  ('compliance.review', 'Compliance', 'Approve, reject and clear cases', true),
  ('fairness.view', 'Fairness', 'See seeds, hashes and verification', false),
  ('fairness.run', 'Fairness', 'Run the RNG lab and audits', false),
  ('rewards.view', 'Rewards', 'See reward settings and claims', false),
  ('rewards.edit', 'Rewards', 'Change reward settings, reset claims', true),
  ('promos.manage', 'Rewards', 'Create and disable promo codes', true),
  ('races.manage', 'Rewards', 'Create and pay races', true),
  ('rain.manage', 'Rewards', 'Start rain', true),
  ('giveaways.manage', 'Rewards', 'Create giveaways and draw winners', true),
  ('config.view', 'Configuration', 'See game configuration', false),
  ('config.edit', 'Configuration', 'Change limits, timings and house edge', true),
  ('catalogue.view', 'Catalogue', 'See cases and items', false),
  ('catalogue.edit', 'Catalogue', 'Add, edit and delete cases, items and odds', true),
  ('bots.manage', 'Bots', 'Manage house bots', false),
  ('economy.view', 'Economy', 'See the economy monitor', false),
  ('risk.view', 'Risk', 'See abuse and risk signals', false),
  ('risk.manage', 'Risk', 'Act on risk signals, see device and IP data', true),
  ('announcements.manage', 'Announcements', 'Post banners and messages', false),
  ('legal.edit', 'Legal', 'Edit legal pages and terms versions', true),
  ('privacy.requests', 'Legal', 'Handle data requests', true),
  ('analytics.view', 'Analytics', 'See reports', false),
  ('analytics.export', 'Analytics', 'Export reports', false),
  ('system.view', 'System', 'See system health', false),
  ('system.manage', 'System', 'Run system tasks', true),
  ('dev.tools', 'System', 'Developer and test tools', true),
  ('audit.read', 'Security', 'Read the audit log', false),
  ('audit.export', 'Security', 'Export the audit log', true),
  ('roles.manage', 'Security', 'Grant staff roles and change role permissions (lower ranks only)', true),
  ('explorer.query', 'Security', 'Run read-only queries on the whole database', true),
  ('admin.security', 'Security', 'Change admin security settings', true);

create table public.admin_role_permissions (        -- a row means the role HOLDS the permission (the owner holds everything implicitly)
  role       text not null references public.admin_role_defs (role),
  permission text not null references public.admin_permissions (key),
  changed_by uuid,
  changed_at timestamptz not null default now(),
  primary key (role, permission)
);
-- default grants (the owner can change all of these from the admin site)
insert into public.admin_role_permissions (role, permission)
  select 'admin', key from public.admin_permissions
   where key not in ('roles.manage', 'explorer.query', 'admin.security', 'wallet.adjust', 'players.view_email', 'audit.export', 'dev.tools');
insert into public.admin_role_permissions (role, permission) values
  ('moderator', 'dashboard.view'), ('moderator', 'players.view'), ('moderator', 'players.notes'), ('moderator', 'players.tags'), ('moderator', 'accounts.mute'),
  ('moderator', 'chat.view'), ('moderator', 'chat.delete'), ('moderator', 'chat.mute'), ('moderator', 'chat.settings'), ('moderator', 'chat.post'),
  ('moderator', 'rooms.view'), ('moderator', 'rooms.cancel'), ('moderator', 'rounds.view'), ('moderator', 'announcements.manage'),
  ('compliance', 'dashboard.view'), ('compliance', 'players.view'), ('compliance', 'players.view_email'), ('compliance', 'players.notes'), ('compliance', 'ledger.view'),
  ('compliance', 'rg.view'), ('compliance', 'rg.apply'), ('compliance', 'compliance.view'), ('compliance', 'compliance.review'), ('compliance', 'fairness.view'),
  ('compliance', 'audit.read'), ('compliance', 'analytics.view'), ('compliance', 'analytics.export'), ('compliance', 'risk.view'),
  ('readonly', 'dashboard.view'), ('readonly', 'players.view'), ('readonly', 'chat.view'), ('readonly', 'rooms.view'), ('readonly', 'rounds.view'), ('readonly', 'ledger.view'),
  ('readonly', 'rg.view'), ('readonly', 'compliance.view'), ('readonly', 'fairness.view'), ('readonly', 'rewards.view'), ('readonly', 'config.view'), ('readonly', 'catalogue.view'),
  ('readonly', 'economy.view'), ('readonly', 'risk.view'), ('readonly', 'analytics.view'), ('readonly', 'system.view'), ('readonly', 'audit.read');

create table public.admin_roles (                   -- who is staff. Players have no row.
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  role       text not null references public.admin_role_defs (role),
  granted_by uuid,
  granted_at timestamptz not null default now()
);

-- ============================ the sign-in chain =====================================================================================
create table public.admin_security (                -- the admin password (hashed) and its lockout
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  password_hash   text not null,
  password_set_at timestamptz not null default now(),
  failed_count    integer not null default 0,
  locked_until    timestamptz
);
create table public.admin_sessions (                -- an unlocked admin session; expires 30 minutes after the last admin call
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- ============================ the audit log =========================================================================================
create table public.admin_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_name  text,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  meta        jsonb not null default '{}'
);
create index admin_audit_at on public.admin_audit_log (at desc);
create index admin_audit_actor on public.admin_audit_log (actor, at desc);

-- ============================ internal helpers (not callable by clients) ===========================================================
create function public.admin_role_of(p_uid uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.admin_roles where user_id = p_uid
$$;
create function public.admin_rank_of(p_role text) returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select rank from public.admin_role_defs where role = p_role), 0)
$$;
create function public.admin_aal2() returns boolean language sql stable as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;
create function public.admin_has_perm(p_role text, p_perm text) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_role = 'owner' or exists (select 1 from public.admin_role_permissions where role = p_role and permission = p_perm)
$$;
-- Non-raising check used by row-level security: staff, two-factor session, unlocked, and the permission.
create function public.admin_can(p_perm text) returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r text;
begin
  if uid is null then return false; end if;
  r := public.admin_role_of(uid);
  if r is null or not public.admin_aal2() then return false; end if;
  if not exists (select 1 from public.admin_sessions where user_id = uid and expires_at > now()) then return false; end if;
  return public.admin_has_perm(r, p_perm);
end $$;
-- The guard at the top of every admin function. Raises a distinct error for each missing step. Extends the idle timeout.
create function public.admin_guard(p_perm text default null) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r text;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  r := public.admin_role_of(uid);
  if r is null then raise exception 'admin_denied'; end if;
  if not public.admin_aal2() then raise exception 'admin_mfa_required'; end if;
  if not exists (select 1 from public.admin_sessions where user_id = uid and expires_at > now()) then raise exception 'admin_session_required'; end if;
  if p_perm is not null and not public.admin_has_perm(r, p_perm) then raise exception 'admin_denied'; end if;
  update public.admin_sessions set last_seen_at = now(), expires_at = now() + interval '30 minutes' where user_id = uid;
  return uid;
end $$;
create function public.admin_log(p_action text, p_target_type text default null, p_target_id text default null, p_before jsonb default null,
                                 p_after jsonb default null, p_reason text default null, p_meta jsonb default '{}') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); new_id bigint;
begin
  insert into public.admin_audit_log (actor, actor_name, actor_role, action, target_type, target_id, before, after, reason, meta)
  values (uid, (select display_name from public.profiles where id = uid), public.admin_role_of(uid), p_action, p_target_type, p_target_id, p_before, p_after, p_reason, coalesce(p_meta, '{}'))
  returning admin_audit_log.id into new_id;
  return new_id;
end $$;
create function public.admin_need_reason(p_reason text) returns text language plpgsql immutable as $$
begin
  if p_reason is null or char_length(trim(p_reason)) < 3 then raise exception 'reason_required'; end if;
  return trim(p_reason);
end $$;

-- ============================ row-level security and privileges ===================================================================
alter table public.admin_role_defs        enable row level security;
alter table public.admin_permissions      enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_roles            enable row level security;
alter table public.admin_security         enable row level security;
alter table public.admin_sessions         enable row level security;
alter table public.admin_audit_log        enable row level security;
create policy audit_read on public.admin_audit_log for select to authenticated using (public.admin_can('audit.read'));
-- every other table has RLS on and no policy: only the functions below (security definer) touch them.
revoke all on public.admin_role_defs, public.admin_permissions, public.admin_role_permissions, public.admin_roles, public.admin_security, public.admin_sessions, public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;      -- RLS decides; nobody is granted insert, update or delete, including the owner

-- ============================ the public API =========================================================================================
-- What does the caller's session look like right now? Callable by any signed-in player; reveals nothing to a non-admin.
create function public.admin_status() returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r text; sec public.admin_security; ses public.admin_sessions;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  r := public.admin_role_of(uid);
  if r is null then return jsonb_build_object('is_admin', false); end if;
  select * into sec from public.admin_security where user_id = uid;
  select * into ses from public.admin_sessions where user_id = uid and expires_at > now();
  return jsonb_build_object('is_admin', true, 'role', r, 'label', (select label from public.admin_role_defs where role = r), 'rank', public.admin_rank_of(r),
    'mfa', public.admin_aal2(), 'password_set', sec.user_id is not null, 'unlocked', ses.user_id is not null,
    'expires_at', ses.expires_at, 'locked_until', case when sec.locked_until > now() then sec.locked_until end);
end $$;

-- Password rules: at least 14 characters, at least 3 of lower/upper/digit/symbol, nothing obvious, not your display name.
create function public.admin_password_ok(p_password text, p_name text) returns void language plpgsql immutable as $$
declare classes integer;
begin
  if p_password is null or char_length(p_password) < 14 or char_length(p_password) > 200 then raise exception 'weak_password'; end if;
  classes := (p_password ~ '[a-z]')::int + (p_password ~ '[A-Z]')::int + (p_password ~ '[0-9]')::int + (p_password ~ '[^A-Za-z0-9]')::int;
  if classes < 3 then raise exception 'weak_password'; end if;
  if lower(p_password) ~ '(password|12345|qwerty|admin|letmein|vaultrush)' then raise exception 'weak_password'; end if;
  if p_password ~ '^(.)\1+$' then raise exception 'weak_password'; end if;
  if char_length(coalesce(p_name, '')) >= 3 and position(lower(p_name) in lower(p_password)) > 0 then raise exception 'weak_password'; end if;
end $$;

-- Set (first time) or change the admin password. Staff with a two-factor session only. Changing needs the current password.
create function public.admin_set_password(p_new text, p_current text default null) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); sec public.admin_security; nm text;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.admin_role_of(uid) is null then raise exception 'admin_denied'; end if;
  if not public.admin_aal2() then raise exception 'admin_mfa_required'; end if;
  select display_name into nm from public.profiles where id = uid;
  select * into sec from public.admin_security where user_id = uid for update;
  if found then
    if sec.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'until', sec.locked_until); end if;
    if p_current is null or sec.password_hash <> crypt(p_current, sec.password_hash) then
      update public.admin_security set failed_count = case when failed_count + 1 >= 5 then 0 else failed_count + 1 end,
             locked_until = case when failed_count + 1 >= 5 then now() + interval '15 minutes' end where user_id = uid;
      perform public.admin_log('admin.password_failed', 'admin', uid::text, null, null, null, jsonb_build_object('step', 'change'));
      return jsonb_build_object('ok', false, 'reason', 'wrong_password');
    end if;
  end if;
  perform public.admin_password_ok(p_new, nm);
  insert into public.admin_security (user_id, password_hash) values (uid, crypt(p_new, gen_salt('bf', 12)))
    on conflict (user_id) do update set password_hash = excluded.password_hash, password_set_at = now(), failed_count = 0, locked_until = null;
  delete from public.admin_sessions where user_id = uid;           -- unlock again with the new password
  perform public.admin_log(case when sec.user_id is null then 'admin.password_set' else 'admin.password_changed' end, 'admin', uid::text);
  return jsonb_build_object('ok', true);
end $$;

-- Step 3 of the sign-in: the admin password. Five wrong tries lock the admin sign-in for 15 minutes. Wrong passwords are RETURNED, not raised,
-- so the failed-attempt counter is saved (a raised error would roll it back).
create function public.admin_unlock(p_password text) returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := auth.uid(); sec public.admin_security; exp timestamptz;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.admin_role_of(uid) is null then raise exception 'admin_denied'; end if;
  if not public.admin_aal2() then raise exception 'admin_mfa_required'; end if;
  select * into sec from public.admin_security where user_id = uid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_password'); end if;
  if sec.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'until', sec.locked_until); end if;
  if p_password is null or sec.password_hash <> crypt(p_password, sec.password_hash) then
    update public.admin_security set failed_count = case when failed_count + 1 >= 5 then 0 else failed_count + 1 end,
           locked_until = case when failed_count + 1 >= 5 then now() + interval '15 minutes' end where user_id = uid;
    perform public.admin_log('admin.unlock_failed', 'admin', uid::text, null, null, null, jsonb_build_object('failed_count', sec.failed_count + 1));
    return jsonb_build_object('ok', false, 'reason', 'wrong_password', 'remaining', greatest(0, 5 - (sec.failed_count + 1)));
  end if;
  update public.admin_security set failed_count = 0, locked_until = null where user_id = uid;
  exp := now() + interval '30 minutes';
  insert into public.admin_sessions (user_id, expires_at) values (uid, exp)
    on conflict (user_id) do update set started_at = now(), last_seen_at = now(), expires_at = exp;
  perform public.admin_log('admin.unlock', 'admin', uid::text);
  return jsonb_build_object('ok', true, 'expires_at', exp);
end $$;

create function public.admin_lock() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.admin_role_of(uid) is null then raise exception 'admin_denied'; end if;
  if exists (select 1 from public.admin_sessions where user_id = uid) then
    delete from public.admin_sessions where user_id = uid;
    perform public.admin_log('admin.lock', 'admin', uid::text);
  end if;
end $$;

-- A heartbeat: keeps an active session alive and tells the page how long is left.
create function public.admin_touch() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard(null);
begin
  return jsonb_build_object('expires_at', (select expires_at from public.admin_sessions where user_id = uid));
end $$;

-- The permissions the caller holds (the owner holds all of them, including ones added later).
create function public.admin_my_permissions() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard(null); r text := public.admin_role_of(auth.uid());
begin
  return coalesce((select jsonb_agg(key order by key) from public.admin_permissions where public.admin_has_perm(r, key)), '[]'::jsonb);
end $$;

-- ============================ roles and the permission matrix ======================================================================
create function public.admin_list_admins() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('roles.manage');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', p.display_name, 'role', a.role, 'rank', public.admin_rank_of(a.role),
                    'granted_at', a.granted_at) order by public.admin_rank_of(a.role) desc, p.display_name) from public.admin_roles a join public.profiles p on p.id = a.user_id), '[]'::jsonb);
end $$;

create function public.admin_find_player(p_query text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.view');
begin
  if p_query is null or char_length(trim(p_query)) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', p.id, 'name', p.display_name, 'created_at', p.created_at, 'role', a.role) as x
                    from public.profiles p left join public.admin_roles a on a.user_id = p.id
                    where p.display_name ilike '%' || replace(replace(trim(p_query), '%', ''), '_', '') || '%' and p.deleted_at is null order by p.display_name limit 20) t), '[]'::jsonb);
end $$;

-- Give someone a staff role, change it, or take it away (p_role = null). Only over LOWER ranks, never yourself, never the owner role.
create function public.admin_set_role(p_user uuid, p_role text, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('roles.manage'); me text := public.admin_role_of(auth.uid()); cur text; why text := public.admin_need_reason(p_reason);
begin
  if p_user = uid then raise exception 'not_allowed_self'; end if;
  if not exists (select 1 from public.profiles where id = p_user and deleted_at is null) then raise exception 'no_account'; end if;
  if p_role is not null and not exists (select 1 from public.admin_role_defs where role = p_role) then raise exception 'unknown_role'; end if;
  if p_role = 'owner' then raise exception 'owner_by_sql_only'; end if;
  cur := public.admin_role_of(p_user);
  if cur = 'owner' then raise exception 'rank_too_low'; end if;
  if public.admin_rank_of(me) <= public.admin_rank_of(cur) or (p_role is not null and public.admin_rank_of(me) <= public.admin_rank_of(p_role)) then raise exception 'rank_too_low'; end if;
  if p_role is null then
    delete from public.admin_roles where user_id = p_user;
    delete from public.admin_sessions where user_id = p_user;
  else
    insert into public.admin_roles (user_id, role, granted_by) values (p_user, p_role, uid)
      on conflict (user_id) do update set role = excluded.role, granted_by = uid, granted_at = now();
    if cur is distinct from p_role then delete from public.admin_sessions where user_id = p_user; end if;
  end if;
  perform public.admin_log('role.set', 'player', p_user::text, jsonb_build_object('role', cur), jsonb_build_object('role', p_role), why);
  return jsonb_build_object('user_id', p_user, 'role', p_role);
end $$;

-- The whole matrix: every role, every permission, and who holds what (the owner column is always full and locked).
create function public.admin_permission_matrix() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('roles.manage');
begin
  return jsonb_build_object(
    'roles', (select jsonb_agg(jsonb_build_object('role', role, 'rank', rank, 'label', label, 'description', description) order by rank desc) from public.admin_role_defs),
    'permissions', (select jsonb_agg(jsonb_build_object('key', key, 'area', area, 'label', label, 'sensitive', sensitive) order by area, key) from public.admin_permissions),
    'grants', (select coalesce(jsonb_agg(jsonb_build_object('role', role, 'permission', permission)), '[]'::jsonb) from public.admin_role_permissions));
end $$;

-- Switch one permission for one role. You may only change a role BELOW your own rank, and only grant what you hold yourself.
create function public.admin_set_permission(p_role text, p_permission text, p_allowed boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('roles.manage'); me text := public.admin_role_of(auth.uid()); why text := public.admin_need_reason(p_reason); had boolean;
begin
  if p_role = 'owner' then raise exception 'owner_is_fixed'; end if;
  if not exists (select 1 from public.admin_role_defs where role = p_role) then raise exception 'unknown_role'; end if;
  if not exists (select 1 from public.admin_permissions where key = p_permission) then raise exception 'unknown_permission'; end if;
  if public.admin_rank_of(me) <= public.admin_rank_of(p_role) then raise exception 'rank_too_low'; end if;
  if p_allowed and not public.admin_has_perm(me, p_permission) then raise exception 'cannot_grant_what_you_lack'; end if;
  had := exists (select 1 from public.admin_role_permissions where role = p_role and permission = p_permission);
  if p_allowed and not had then insert into public.admin_role_permissions (role, permission, changed_by) values (p_role, p_permission, uid);
  elsif not p_allowed and had then delete from public.admin_role_permissions where role = p_role and permission = p_permission;
  end if;
  perform public.admin_log('permission.set', 'role', p_role, jsonb_build_object('permission', p_permission, 'allowed', had), jsonb_build_object('permission', p_permission, 'allowed', p_allowed), why);
  return jsonb_build_object('role', p_role, 'permission', p_permission, 'allowed', p_allowed);
end $$;

-- ============================ one real permission-gated action: reveal an e-mail ==================================================
create function public.admin_player_email(p_user uuid, p_reason text) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('players.view_email'); why text := public.admin_need_reason(p_reason); mail text;
begin
  select email into mail from auth.users where id = p_user;
  perform public.admin_log('pii.reveal', 'player', p_user::text, null, null, why, jsonb_build_object('field', 'email'));     -- the address itself is never written to the log
  return mail;
end $$;

-- ============================ the owner's data explorer (read-only) =================================================================
-- Runs ONE read-only statement and returns up to p_limit rows. The statement is written to the audit log first. The transaction is then switched
-- to read-only, so nothing inside it (not even a data-changing CTE) can change data. Time limit 5 s. It sees everything, including secret seeds:
-- do not play with the account you use to look at them.
create function public.admin_query(p_sql text, p_limit integer default 200) returns json language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := public.admin_guard('explorer.query'); q text; lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000); rows json; cols json; n integer;
begin
  q := regexp_replace(trim(coalesce(p_sql, '')), ';+\s*$', '');
  -- The attempt is logged FIRST. Problems with the query are returned as data (not raised), so the log entry is kept even when the query fails.
  perform public.admin_log('explorer.query', 'sql', null, null, null, null, jsonb_build_object('sql', left(q, 8000)));
  if q = '' or char_length(q) > 8000 then return json_build_object('error', 'invalid_query', 'columns', '[]'::json, 'rows', '[]'::json, 'truncated', false); end if;
  if q !~* '^(select|with|table|values)(\s|$)' then return json_build_object('error', 'read_only_only', 'columns', '[]'::json, 'rows', '[]'::json, 'truncated', false); end if;
  if position(';' in q) > 0 then return json_build_object('error', 'one_statement_only', 'columns', '[]'::json, 'rows', '[]'::json, 'truncated', false); end if;
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '5000', true);
  begin
    execute format('select count(*) from (select 1 from (%s) _q limit %s) c', q, lim + 1) into n;
    execute format('select coalesce(json_agg(row_to_json(t)), ''[]''::json) from (select * from (%s) _q limit %s) t', q, lim) into rows;
  exception when others then
    return json_build_object('error', sqlerrm, 'columns', '[]'::json, 'rows', '[]'::json, 'truncated', false);
  end;
  cols := case when n > 0 then (select json_agg(k) from json_object_keys(rows -> 0) k) else '[]'::json end;
  return json_build_object('columns', cols, 'rows', rows, 'truncated', n > lim);
end $$;

-- ============================ privileges ===========================================================================================
revoke execute on function public.admin_role_of(uuid), public.admin_rank_of(text), public.admin_aal2(), public.admin_has_perm(text, text), public.admin_can(text),
  public.admin_guard(text), public.admin_log(text, text, text, jsonb, jsonb, text, jsonb), public.admin_need_reason(text), public.admin_password_ok(text, text) from public, anon, authenticated;
grant execute on function public.admin_can(text) to authenticated;        -- row-level security calls it as the signed-in role
revoke execute on function public.admin_status(), public.admin_set_password(text, text), public.admin_unlock(text), public.admin_lock(), public.admin_touch(),
  public.admin_my_permissions(), public.admin_list_admins(), public.admin_find_player(text), public.admin_set_role(uuid, text, text), public.admin_permission_matrix(),
  public.admin_set_permission(text, text, boolean, text), public.admin_player_email(uuid, text), public.admin_query(text, integer) from public, anon, authenticated;
grant execute on function public.admin_status(), public.admin_set_password(text, text), public.admin_unlock(text), public.admin_lock(), public.admin_touch(),
  public.admin_my_permissions(), public.admin_list_admins(), public.admin_find_player(text), public.admin_set_role(uuid, text, text), public.admin_permission_matrix(),
  public.admin_set_permission(text, text, boolean, text), public.admin_player_email(uuid, text), public.admin_query(text, integer) to authenticated;

-- ============================ make YOURSELF the owner (run this ONE statement by hand, once, after the migration) ============================
-- Replace YOUR_DISPLAY_NAME with your player name on the site, then run only this statement in the SQL editor:
--
--   insert into public.admin_roles (user_id, role, granted_by)
--   select id, 'owner', id from public.profiles where lower(display_name) = lower('YOUR_DISPLAY_NAME');
--
-- Nobody can become owner any other way (the admin functions refuse it), so nobody can promote themselves.
