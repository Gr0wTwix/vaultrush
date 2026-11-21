-- Vaultrush 0013: a slower Crash. Run after 0012_rewards.sql.
--
-- The multiplier now climbs as e^(0.00008 x ms) instead of e^(0.00012 x ms): 2x after 8.7 s (was 5.8 s), 5x after 20 s, 10x after 29 s. The pace lives in one
-- place, crash_rate(), used both for the moment a round crashes and for the multiplier a cash-out pays; the page uses the same number (CRASH_GROWTH in
-- src/fair.ts, checked against this function by tests/wallet-live-db.test.ts).
-- Only rounds that START after this migration are affected in practice: a round already running when it is applied simply crashes a little earlier.

create or replace function public.crash_rate() returns double precision language sql immutable as $$ select 0.00008::double precision $$;

create or replace function pg_temp.patch_fn(p_fn text, p_old text, p_new text) returns void language plpgsql as $$
declare fid oid; def text; n integer;
begin
  select p.oid into fid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if fid is null then raise exception 'patch_fn: % not found', p_fn; end if;
  def := pg_get_functiondef(fid);
  n := (length(def) - length(replace(def, p_old, ''))) / length(p_old);
  if n = 0 and position(p_new in def) > 0 then return; end if;                         -- already applied: running this file again changes nothing
  if n <> 1 then raise exception 'patch_fn: text found % times in %', n, p_fn; end if;
  execute replace(def, p_old, p_new);
end $$;

-- the instant a round crashes, and the multiplier a cash-out pays at the server's clock
select pg_temp.patch_fn('advance_round_internal', 'ln(cp::double precision) / 0.00012 / 1000.0', 'ln(cp::double precision) / public.crash_rate() / 1000.0');
select pg_temp.patch_fn('crash_cashout', 'exp(0.00012 * ms)', 'exp(public.crash_rate() * ms)');

revoke execute on function public.crash_rate() from public, anon, authenticated;
