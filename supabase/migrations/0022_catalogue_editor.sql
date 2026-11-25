-- Vaultrush 0022: admin step C, the case catalogue editor. Run after 0021. Running it again changes nothing.
--
-- The cases already live in the database (0008, filled by the generated 0015) and every opening is drawn from these tables. From now on the
-- admin site can change them, and the game site reads the published catalogue at start-up (catalogue_public), so what players see and what
-- the server draws are the same thing.
--   * A case's contents are given as chances (in tickets out of 100,000, so 1,000 tickets = 1%); they must add up to exactly 100,000.
--   * A paid case must return between 70% and 98% of its price on average (its expected value / price); outside that it is refused.
--   * Every save writes a numbered version with the full contents, the person and the reason; any version can be restored. The current
--     version number is public, so the odds a player opened against can always be shown.
--   * A case that a waiting battle uses cannot be re-priced or switched off until that battle starts or is cancelled (its refund uses the price).
--   * Switching a case off (active = false) hides it on the site and the server refuses to open it; nothing is deleted.
-- NOTE: re-running the generated 0015_real_cases.sql (npm run build:catalogue) replaces every case and would undo edits made here. From now on
-- the database is the source of truth for cases; see docs/real-catalogue.md.

-- ============================ columns and history ===============================================================================
alter table public.catalog_cases add column if not exists hue integer check (hue is null or hue between 0 and 360);   -- null: the page's own value
alter table public.catalog_cases add column if not exists tag text check (tag is null or char_length(tag) <= 20);
alter table public.catalog_cases add column if not exists art text check (art is null or art ~ '^[a-z0-9-]{2,30}$');      -- show another case's picture
alter table public.catalog_cases add column if not exists sort integer not null default 0;
alter table public.catalog_cases add column if not exists version integer not null default 1;
alter table public.catalog_cases add column if not exists updated_at timestamptz;
alter table public.catalog_cases add column if not exists updated_by uuid;

create table if not exists public.catalog_case_history (
  id         bigint generated always as identity primary key,
  case_id    text not null,
  version    integer not null,
  snapshot   jsonb not null,                                -- {name, price, reward, active, hue, tag, art, entries: [{item, from, to}]}
  changed_by uuid,
  changed_at timestamptz not null default now(),
  reason     text,
  unique (case_id, version)
);
alter table public.catalog_case_history enable row level security;          -- no policy: read through the functions below
revoke all on public.catalog_case_history from anon, authenticated;

-- ============================ helpers ==========================================================================================
create or replace function public.catalog_case_json(p_id text) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('name', c.name, 'price', c.price, 'reward', c.reward, 'active', c.active, 'hue', c.hue, 'tag', c.tag, 'art', c.art,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('item', e.item_id, 'from', e.ticket_from, 'to', e.ticket_to) order by e.ticket_from) from public.catalog_case_entries e where e.case_id = c.id), '[]'::jsonb))
  from public.catalog_cases c where c.id = p_id
$$;
create or replace function public.catalog_case_ev(p_id text) returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(i.value * (e.ticket_to - e.ticket_from + 1)) / 100000.0, 0) from public.catalog_case_entries e join public.catalog_items i on i.id = e.item_id where e.case_id = p_id
$$;
create or replace function public.catalog_case_in_use(p_id text) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.live_battles where status = 'waiting' and p_id = any (case_ids))
$$;
-- The first version of every existing case is recorded once, so the very first edit can be undone.
insert into public.catalog_case_history (case_id, version, snapshot, reason)
select c.id, c.version, public.catalog_case_json(c.id), 'as installed (0015)' from public.catalog_cases c
on conflict (case_id, version) do nothing;

-- ============================ what the game site reads ============================================================================
-- Every case that is on, with its drop table. Anyone may read it (it is what the case pages show anyway).
create or replace function public.catalogue_public() returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('cases', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'price', c.price, 'reward', c.reward, 'hue', c.hue, 'tag', c.tag, 'art', c.art,
      'sort', c.sort, 'version', c.version,
      'entries', (select jsonb_agg(jsonb_build_array(e.item_id, e.ticket_from, e.ticket_to) order by e.ticket_from) from public.catalog_case_entries e where e.case_id = c.id)) order by c.sort, c.price), '[]'::jsonb))
  from public.catalog_cases c where c.active
$$;

-- ============================ the editor ========================================================================================
create or replace function public.admin_catalogue_cases() returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'price', c.price, 'reward', c.reward, 'active', c.active, 'hue', c.hue, 'tag', c.tag, 'art', c.art,
            'sort', c.sort, 'version', c.version, 'updated_at', c.updated_at, 'items', (select count(*) from public.catalog_case_entries e where e.case_id = c.id),
            'ev', round(public.catalog_case_ev(c.id), 4), 'opens_7d', (select count(*) from public.bets b where b.game = 'cases' and b.params ->> 'case' = c.id and b.created_at > now() - interval '7 days'),
            'in_use', public.catalog_case_in_use(c.id)) order by c.reward, c.sort, c.price)
          from public.catalog_cases c), '[]'::jsonb);
end $$;

create or replace function public.admin_catalogue_case(p_id text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.view'); c public.catalog_cases;
begin
  select * into c from public.catalog_cases where id = p_id;
  if c.id is null then raise exception 'case_not_found'; end if;
  return jsonb_build_object('id', c.id, 'name', c.name, 'price', c.price, 'reward', c.reward, 'active', c.active, 'hue', c.hue, 'tag', c.tag, 'art', c.art, 'sort', c.sort,
    'version', c.version, 'updated_at', c.updated_at, 'ev', round(public.catalog_case_ev(c.id), 4), 'in_use', public.catalog_case_in_use(c.id),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('item', i.id, 'name', i.name, 'rarity', i.rarity, 'value', i.value, 'tickets', e.ticket_to - e.ticket_from + 1, 'from', e.ticket_from, 'to', e.ticket_to) order by e.ticket_from)
                         from public.catalog_case_entries e join public.catalog_items i on i.id = e.item_id where e.case_id = c.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('version', h.version, 'at', h.changed_at, 'by', (select display_name from public.profiles p where p.id = h.changed_by), 'reason', h.reason,
                         'price', h.snapshot -> 'price', 'items', jsonb_array_length(h.snapshot -> 'entries')) order by h.version desc)
                         from public.catalog_case_history h where h.case_id = c.id), '[]'::jsonb));
end $$;

-- Items to put in a case: name contains every word of p_query, value between p_min and p_max, dearest first. Old invented items are left out.
create or replace function public.admin_catalogue_items(p_query text default '', p_min numeric default 0, p_max numeric default null, p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.view'); words text[]; lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  select coalesce(array_agg(w), '{}') into words from unnest(regexp_split_to_array(lower(trim(coalesce(p_query, ''))), '\s+')) w where w <> '';
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'rarity', i.rarity, 'value', i.value) order by i.value desc, i.id)
          from (select * from public.catalog_items i where i.active and not coalesce(i.legacy, false) and i.name is not null
                  and i.value >= coalesce(p_min, 0) and (p_max is null or i.value <= p_max)
                  and not exists (select 1 from unnest(words) w where position(w in lower(i.name)) = 0)
                order by i.value desc, i.id limit lim) i), '[]'::jsonb);
end $$;

-- Create (p_version = 0) or change a case. p_entries: [{"item": id, "tickets": n}, ...] adding up to 100,000; ticket ranges are given out in that order.
-- p_version must be the version the editor loaded, so two people cannot overwrite each other without noticing ('case_changed').
create or replace function public.admin_catalogue_save(p_id text, p_version integer, p_name text, p_price numeric, p_hue integer, p_tag text, p_art text, p_sort integer,
                                                       p_entries jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.edit'); why text := public.admin_need_reason(p_reason); c public.catalog_cases; nm text := trim(coalesce(p_name, ''));
        e jsonb; n integer := 0; total integer := 0; t integer; at integer := 0; ev numeric := 0; v numeric; rtp numeric; before jsonb; created boolean := false; ids text[] := '{}';
begin
  if p_id is null or p_id !~ '^[a-z0-9-]{2,30}$' then raise exception 'invalid_case_id'; end if;
  if char_length(nm) < 2 or char_length(nm) > 40 then raise exception 'invalid_case_name'; end if;
  if p_price is null or p_price < 0 or p_price > 100000 or p_price <> round(p_price, 2) then raise exception 'invalid_price'; end if;
  if p_hue is not null and (p_hue < 0 or p_hue > 360) then raise exception 'invalid_value'; end if;
  if p_tag is not null and char_length(p_tag) > 20 then raise exception 'text_too_long'; end if;
  if p_art is not null and p_art !~ '^[a-z0-9-]{2,30}$' then raise exception 'invalid_value'; end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 1 or jsonb_array_length(p_entries) > 60 then raise exception 'invalid_entries'; end if;
  perform pg_advisory_xact_lock(hashtextextended('catalogue:' || p_id, 0));
  select * into c from public.catalog_cases where id = p_id for update;
  if c.id is null then
    if coalesce(p_version, 0) <> 0 then raise exception 'case_not_found'; end if;
    created := true;
  else
    if p_version is distinct from c.version then raise exception 'case_changed'; end if;
    if p_price <> c.price and public.catalog_case_in_use(p_id) then raise exception 'case_in_use'; end if;
    before := public.catalog_case_json(p_id);
  end if;
  -- check every entry before changing anything
  for e in select * from jsonb_array_elements(p_entries) loop
    t := (e ->> 'tickets')::integer;
    if t is null or t < 1 or t > 100000 or (e ->> 'item') is null then raise exception 'invalid_entries'; end if;
    if (e ->> 'item') = any (ids) then raise exception 'duplicate_item'; end if;
    select value into v from public.catalog_items where id = e ->> 'item' and active and not coalesce(legacy, false);
    if v is null then raise exception 'unknown_item'; end if;
    ids := ids || (e ->> 'item'); total := total + t; ev := ev + v * t;
  end loop;
  if total <> 100000 then raise exception 'tickets_not_100000'; end if;
  ev := ev / 100000.0;
  if not coalesce(c.reward, false) then                                          -- reward crates are never sold, so they have no return to check
    if p_price <= 0 then raise exception 'invalid_price'; end if;
    rtp := ev / p_price;
    if rtp < 0.70 or rtp > 0.98 then raise exception 'rtp_out_of_range'; end if;
  end if;
  if created then
    insert into public.catalog_cases (id, name, reward, price, active, hue, tag, art, sort, version, updated_at, updated_by)
    values (p_id, nm, false, p_price, true, p_hue, nullif(trim(p_tag), ''), p_art, coalesce(p_sort, 0), 1, now(), uid) returning * into c;
  else
    update public.catalog_cases set name = nm, price = p_price, hue = p_hue, tag = nullif(trim(p_tag), ''), art = p_art, sort = coalesce(p_sort, sort),
           version = version + 1, updated_at = now(), updated_by = uid where id = p_id returning * into c;
    delete from public.catalog_case_entries where case_id = p_id;
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    t := (e ->> 'tickets')::integer;
    insert into public.catalog_case_entries (case_id, item_id, ticket_from, ticket_to) values (p_id, e ->> 'item', at, at + t - 1);
    at := at + t; n := n + 1;
  end loop;
  insert into public.catalog_case_history (case_id, version, snapshot, changed_by, reason) values (p_id, c.version, public.catalog_case_json(p_id), uid, why);
  perform public.admin_log(case when created then 'catalogue.create' else 'catalogue.edit' end, 'case', p_id,
                           case when before is null then null else before - 'entries' || jsonb_build_object('items', jsonb_array_length(before -> 'entries')) end,
                           jsonb_build_object('name', nm, 'price', p_price, 'items', n, 'ev', round(ev, 4), 'version', c.version), why);
  return jsonb_build_object('id', p_id, 'version', c.version, 'ev', round(ev, 4), 'rtp', case when p_price > 0 then round(ev / p_price, 4) end, 'created', created);
end $$;

-- Switch a case on or off (off: hidden on the site and refused by the server; nothing is deleted).
create or replace function public.admin_catalogue_set_active(p_id text, p_active boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.edit'); why text := public.admin_need_reason(p_reason); c public.catalog_cases;
begin
  select * into c from public.catalog_cases where id = p_id for update;
  if c.id is null then raise exception 'case_not_found'; end if;
  if p_active is null then raise exception 'invalid_value'; end if;
  if c.active = p_active then return jsonb_build_object('id', p_id, 'active', p_active); end if;
  if not p_active and public.catalog_case_in_use(p_id) then raise exception 'case_in_use'; end if;
  update public.catalog_cases set active = p_active, updated_at = now(), updated_by = uid where id = p_id;
  perform public.admin_log(case when p_active then 'catalogue.enable' else 'catalogue.disable' end, 'case', p_id, jsonb_build_object('active', c.active), jsonb_build_object('active', p_active), why);
  return jsonb_build_object('id', p_id, 'active', p_active);
end $$;

-- Put back an earlier version's contents (as a new version, so the history is never rewritten). The same checks as a save apply.
create or replace function public.admin_catalogue_restore(p_id text, p_version integer, p_reason text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.admin_guard('catalogue.edit'); why text := public.admin_need_reason(p_reason); h public.catalog_case_history; c public.catalog_cases;
begin
  select * into c from public.catalog_cases where id = p_id;
  if c.id is null then raise exception 'case_not_found'; end if;
  select * into h from public.catalog_case_history where case_id = p_id and version = p_version;
  if h.id is null then raise exception 'invalid_value'; end if;
  return public.admin_catalogue_save(p_id, c.version, h.snapshot ->> 'name', (h.snapshot ->> 'price')::numeric, (h.snapshot ->> 'hue')::integer, h.snapshot ->> 'tag', h.snapshot ->> 'art', c.sort,
    (select jsonb_agg(jsonb_build_object('item', x ->> 'item', 'tickets', (x ->> 'to')::integer - (x ->> 'from')::integer + 1) order by (x ->> 'from')::integer) from jsonb_array_elements(h.snapshot -> 'entries') x),
    why || ' (restored version ' || p_version || ')');
end $$;

-- ============================ privileges ===========================================================================================
revoke execute on function public.catalog_case_json(text), public.catalog_case_ev(text), public.catalog_case_in_use(text) from public, anon, authenticated;
revoke execute on function public.catalogue_public(), public.admin_catalogue_cases(), public.admin_catalogue_case(text), public.admin_catalogue_items(text, numeric, numeric, integer),
  public.admin_catalogue_save(text, integer, text, numeric, integer, text, text, integer, jsonb, text), public.admin_catalogue_set_active(text, boolean, text),
  public.admin_catalogue_restore(text, integer, text) from public;
grant execute on function public.catalogue_public() to anon, authenticated;
grant execute on function public.admin_catalogue_cases(), public.admin_catalogue_case(text), public.admin_catalogue_items(text, numeric, numeric, integer),
  public.admin_catalogue_save(text, integer, text, numeric, integer, text, text, integer, jsonb, text), public.admin_catalogue_set_active(text, boolean, text),
  public.admin_catalogue_restore(text, integer, text) to authenticated;
revoke execute on function public.admin_catalogue_cases(), public.admin_catalogue_case(text), public.admin_catalogue_items(text, numeric, numeric, integer),
  public.admin_catalogue_save(text, integer, text, numeric, integer, text, text, integer, jsonb, text), public.admin_catalogue_set_active(text, boolean, text),
  public.admin_catalogue_restore(text, integer, text) from anon;
