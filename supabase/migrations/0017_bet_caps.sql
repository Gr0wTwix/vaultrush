-- Vaultrush 0017: verification is only needed above 10,000 coins. Run after 0016 (it needs the functions of 0004, 0008 and 0011).
--
-- The most one bet, case opening, upgrade stake, battle or coinflip may cost, by verification level (kyc_tier):
--   level 0 (new account)             1,000 -> 10,000
--   level 1 (email + date of birth)   2,500 -> 25,000
--   level 2 (full, simulated check)   5,000 -> 50,000
-- Anything above a level's cap is refused with 'tier_cap_exceeded' ("bets this large need a higher verification level"), so a player who has not verified can
-- stake up to 10,000 and needs verification for more. The three live games also had a hard limit of 5,000 per bet (coinflip, Crash, Double); it is now 50,000, the
-- highest level's cap, so the level caps are the only thing that decides.
-- The page uses the same numbers (TIER_MAX_BET in src/kyc.ts, checked against this file by tests/bet-caps-db.test.ts). Running this file again changes nothing.

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

-- the verification-level caps (the gate every game's stake goes through, and the older Crash demo bet)
select pg_temp.patch_fn('wallet_gate', 'case ctl.kyc_tier when 0 then 1000 when 1 then 2500 else 5000 end', 'case ctl.kyc_tier when 0 then 10000 when 1 then 25000 else 50000 end');
select pg_temp.patch_fn('place_bet', 'case ctl.kyc_tier when 0 then 1000 when 1 then 2500 else 5000 end', 'case ctl.kyc_tier when 0 then 10000 when 1 then 25000 else 50000 end');

-- the hard per-bet limit of the live games (in the functions, and the coinflip table's own rule)
select pg_temp.patch_fn('create_live_coinflip', 'p_amount > 5000', 'p_amount > 50000');
select pg_temp.patch_fn('crash_place_bet', 'p_amount > 5000', 'p_amount > 50000');
select pg_temp.patch_fn('double_place_bet', 'p_amount > 5000', 'p_amount > 50000');
alter table public.live_coinflips drop constraint if exists live_coinflips_amount_check;
alter table public.live_coinflips add constraint live_coinflips_amount_check check (amount >= 0.10 and amount <= 50000);
