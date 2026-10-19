-- Patoli · Arena (PvP piedra·papel·tijera). Money lives in the PatoliArena
-- contract; this DB coordinates matches off-chain and keeps the public record.
-- Everything here is evidence (signed by players) or derived state.

-- ───────────────────────────── lobby ─────────────────────────────────
create table if not exists public.arena_lobby (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  eoa         text not null,
  stake       numeric not null,             -- token units in USD (1 = $1)
  joined_at   timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '2 minutes'
);
create index if not exists arena_lobby_stake_idx on public.arena_lobby (stake, joined_at);

-- ───────────────────────────── matches ───────────────────────────────
create table if not exists public.arena_matches (
  id            text primary key,           -- bytes32 hex (0x…), also the on-chain match id
  player_a      uuid not null references public.profiles(id),
  player_b      uuid not null references public.profiles(id),
  eoa_a         text not null,
  eoa_b         text not null,
  stake         numeric not null,
  best_of       int  not null default 3,
  deadline      timestamptz not null,       -- Match.deadline (dispute path opens after)
  status        text not null default 'signing',
  -- signing → playing → ready (decided by score: settles from the moves) → settled
  --                     → finished (forfeit/abandon: on-chain claim) → disputed → settled
  --                     → cancelled (never started)
  sig_a         text,                       -- EIP-712 Match signatures (public: evidence)
  sig_b         text,
  round         int  not null default 0,    -- current round (1-based once playing)
  score_a       int  not null default 0,
  score_b       int  not null default 0,
  winner_eoa    text,                       -- null = draw (when finished)
  settle_tx     text,
  claim_tx      text,                       -- dispute path: operator-filed claim
  settle_error  text,                       -- short generic code only (public table)
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  settled_at    timestamptz,
  constraint arena_matches_status check (status in ('signing','playing','finished','ready','settled','cancelled','disputed')),
  constraint arena_matches_players check (player_a <> player_b)
);
create index if not exists arena_matches_a_idx on public.arena_matches (player_a, created_at desc);
create index if not exists arena_matches_b_idx on public.arena_matches (player_b, created_at desc);
create index if not exists arena_matches_status_idx on public.arena_matches (status);

-- ───────────────────────────── rounds ────────────────────────────────
-- Commits (hash + signature) are public evidence. Reveals become public only
-- once BOTH players revealed; until then they sit in arena_round_secrets.
create table if not exists public.arena_rounds (
  match_id      text not null references public.arena_matches(id) on delete cascade,
  round         int  not null,
  commit_a      text,  commit_sig_a text,  commit_ack_a text,  committed_a_at timestamptz,
  commit_b      text,  commit_sig_b text,  commit_ack_b text,  committed_b_at timestamptz,
  move_a        int,   salt_a text,  reveal_ack_a text,
  move_b        int,   salt_b text,  reveal_ack_b text,
  outcome       text,                       -- 'a' | 'b' | 'tie' | null
  opened_at     timestamptz not null default now(),
  commit_deadline timestamptz,
  reveal_deadline timestamptz,
  resolved_at   timestamptz,
  primary key (match_id, round)
);

create table if not exists public.arena_round_secrets (
  match_id  text not null,
  round     int  not null,
  side      text not null check (side in ('a','b')),
  move      int  not null check (move between 1 and 3),
  salt      text not null,
  ack       text not null,                  -- operator RevealAck signature
  primary key (match_id, round, side)
);

-- ───────────────────────────── settlements ───────────────────────────
create table if not exists public.arena_settlements (
  id          bigserial primary key,
  tx_hash     text,
  match_ids   text[] not null,
  status      text not null default 'sent', -- sent | confirmed | failed
  error       text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────── pairing (atomic) ──────────────────────
-- Called by the server with the joining player. Pairs with the oldest other
-- waiting player at the same stake, or queues the caller. Row locks make two
-- simultaneous joins safe.
create or replace function public.arena_pair(p_profile uuid, p_eoa text, p_stake numeric, p_match_id text, p_deadline timestamptz)
returns table (matched boolean, match_id text) language plpgsql as $$
declare
  other record;
  existing text;
begin
  -- serialize all pairing (beta scale) → no double pairing, no lock-order deadlocks
  perform pg_advisory_xact_lock(hashtext('arena_pair'));
  select id into existing from public.arena_matches
    where (player_a = p_profile or player_b = p_profile) and status in ('signing','playing','finished','ready','disputed')
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
  -- the other player must not have an open match either (their lobby row may be stale)
  if exists (select 1 from public.arena_matches
             where (player_a = other.profile_id or player_b = other.profile_id)
               and status in ('signing','playing','finished','ready','disputed')) then
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

-- ───────────────────────────── stats view ────────────────────────────
create or replace view public.arena_stats as
select p.id as profile_id,
  count(m.id) filter (where m.status in ('finished','ready','settled') and m.winner_eoa = p.eoa) as wins,
  count(m.id) filter (where m.status in ('finished','ready','settled') and m.winner_eoa is not null and m.winner_eoa <> p.eoa) as losses,
  count(m.id) filter (where m.status in ('finished','ready','settled') and m.winner_eoa is null) as draws,
  coalesce(sum(case when m.status in ('finished','ready','settled') and m.winner_eoa = p.eoa then m.stake
                    when m.status in ('finished','ready','settled') and m.winner_eoa is not null then -m.stake else 0 end), 0) as pnl
from public.profiles p
left join public.arena_matches m on (m.player_a = p.id or m.player_b = p.id)
group by p.id, p.eoa;

-- ───────────────────────────── RLS ───────────────────────────────────
alter table public.arena_lobby enable row level security;
alter table public.arena_matches enable row level security;
alter table public.arena_rounds enable row level security;
alter table public.arena_round_secrets enable row level security;
alter table public.arena_settlements enable row level security;
-- public read for the record + realtime; writes only via service role (server)
drop policy if exists "public read arena_matches" on public.arena_matches;
create policy "public read arena_matches" on public.arena_matches for select to anon, authenticated using (true);
drop policy if exists "public read arena_rounds" on public.arena_rounds;
create policy "public read arena_rounds" on public.arena_rounds for select to anon, authenticated using (true);
-- lobby, secrets, settlements: no anon policy at all

-- realtime: browsers subscribe to match + round changes (read-only)
do $$ begin
  alter publication supabase_realtime add table public.arena_matches;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.arena_rounds;
exception when duplicate_object then null; end $$;
