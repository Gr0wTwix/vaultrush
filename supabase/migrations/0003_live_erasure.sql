-- Vaultrush backend, part 3: deleting an account also removes the player's name from live games.
-- 0002 copied display names into live_coinflips (creator_name, joiner_name) and live_battles (seats). delete_account() in 0001
-- anonymised the profile but left those copies, so the privacy policy's promise ("your name in live games is replaced") was not true.
-- This replaces the function with the same behaviour plus that clean-up. Run it once in the SQL editor after 0002_live.sql.
-- (create or replace keeps the existing grants, so players can still call it.)

create or replace function public.delete_account() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); bal numeric; anon text;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.profiles where id = uid) then raise exception 'no_account'; end if;
  anon := 'deleted-' || substr(replace(uid::text, '-', ''), 1, 8);
  select balance into bal from public.wallets where user_id = uid for update;
  if bal > 0 then
    update public.wallets set balance = 0, updated_at = now() where user_id = uid;
    insert into public.ledger (user_id, kind, amount, balance_after) values (uid, 'adjustment', -bal, 0);
  end if;
  delete from public.chat_messages where user_id = uid;
  delete from public.limit_changes where user_id = uid;
  -- names copied into live games
  update public.live_coinflips set creator_name = anon where creator = uid;
  update public.live_coinflips set joiner_name = anon where joiner = uid;
  update public.live_battles b
     set seats = (select jsonb_agg(case when e <> 'null'::jsonb and e ->> 'uid' = uid::text then jsonb_set(e, '{name}', to_jsonb(anon)) else e end order by ord)
                    from jsonb_array_elements(b.seats) with ordinality as t(e, ord))
   where uid = any (b.player_ids);
  update public.profiles set display_name = anon, deleted_at = now() where id = uid;
end $$;
