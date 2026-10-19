-- "Open match" = actively being played (signing/playing). Decided matches that are
-- settling or in the claim path must not block new games; their exposure is handled
-- by the server (unsettledOwed). Replaces arena_pair's status lists.
create or replace function public.arena_pair(p_profile uuid, p_eoa text, p_stake numeric, p_match_id text, p_deadline timestamptz)
returns table (matched boolean, match_id text) language plpgsql as $$
declare
  other record;
  existing text;
begin
  perform pg_advisory_xact_lock(hashtext('arena_pair'));
  select id into existing from public.arena_matches
    where (player_a = p_profile or player_b = p_profile) and status in ('signing','playing')
    order by created_at desc limit 1;
  if existing is not null then
    delete from public.arena_lobby where profile_id = p_profile;
    return query select true, existing;
    return;
  end if;
  delete from public.arena_lobby where expires_at < now();
  select * into other from public.arena_lobby
    where stake = p_stake and profile_id <> p_profile
    order by joined_at asc limit 1 for update skip locked;
  if other.profile_id is null then
    insert into public.arena_lobby (profile_id, eoa, stake)
      values (p_profile, p_eoa, p_stake)
      on conflict (profile_id) do update set stake = excluded.stake, joined_at = now(), expires_at = now() + interval '2 minutes';
    return query select false, null::text;
    return;
  end if;
  if exists (select 1 from public.arena_matches
             where (player_a = other.profile_id or player_b = other.profile_id)
               and status in ('signing','playing')) then
    delete from public.arena_lobby where profile_id = other.profile_id;
    insert into public.arena_lobby (profile_id, eoa, stake) values (p_profile, p_eoa, p_stake)
      on conflict (profile_id) do update set stake = excluded.stake, joined_at = now(), expires_at = now() + interval '2 minutes';
    return query select false, null::text;
    return;
  end if;
  delete from public.arena_lobby where profile_id in (other.profile_id, p_profile);
  insert into public.arena_matches (id, player_a, player_b, eoa_a, eoa_b, stake, deadline)
    values (p_match_id, other.profile_id, p_profile, other.eoa, p_eoa, p_stake, p_deadline);
  return query select true, p_match_id;
end $$;
