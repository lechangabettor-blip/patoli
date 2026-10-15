-- Patoli · initial schema (Supabase / Postgres)
-- Source of truth for money is the chain + Polymarket; this DB holds identity,
-- the social graph, and an INDEX of on-chain bets (rebuildable at any time).

create extension if not exists pgcrypto;

-- ───────────────────────────── profiles ──────────────────────────────
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  handle        text not null,
  display_name  text,
  avatar        text,                       -- emoji or seed string
  bio           text,
  eoa           text not null,              -- embedded-wallet address (lowercase)
  wallet        text not null,              -- Polymarket deposit wallet (lowercase)
  is_verified   boolean not null default false,  -- creator badge
  is_banned     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_eoa_format check (eoa ~ '^0x[0-9a-f]{40}$'),
  constraint profiles_wallet_format check (wallet ~ '^0x[0-9a-f]{40}$')
);
create unique index if not exists profiles_handle_key on public.profiles (handle);
create unique index if not exists profiles_eoa_key on public.profiles (eoa);
create unique index if not exists profiles_wallet_key on public.profiles (wallet);

-- private identity data (never readable by anon)
create table if not exists public.profile_private (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  issuer      text not null unique,          -- Magic DID issuer
  email       text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────── follows ───────────────────────────────
create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

-- ───────────────────────────── markets ───────────────────────────────
-- One row per Polymarket market (condition). Metadata cached from Gamma.
create table if not exists public.markets (
  condition_id   text primary key,          -- 0x…
  question       text not null,
  slug           text,
  event_slug     text,
  event_title    text,
  league         text,                      -- our LeagueId (ligamx, nfl, …) or null
  kind           text,                      -- moneyline | spread | total | other
  line           numeric,
  outcomes       jsonb not null default '[]'::jsonb,  -- [{index,label,tokenId}]
  game_start     timestamptz,
  closed         boolean not null default false,
  winning_index  int,                       -- null until resolved; -1 = void (50/50)
  resolved_at    timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists markets_open_idx on public.markets (closed, game_start);

-- ───────────────────────────── bets ──────────────────────────────────
-- One row per Polymarket fill attributed to Patoli (builder trades feed).
create table if not exists public.bets (
  id             text primary key,          -- Polymarket trade id
  profile_id     uuid references public.profiles(id) on delete set null,
  wallet         text not null,             -- maker (deposit wallet, lowercase)
  condition_id   text not null references public.markets(condition_id),
  token_id       text not null,
  outcome_index  int not null,
  outcome        text not null,
  side           text not null,             -- BUY | SELL
  size           numeric not null,          -- shares (each pays $1 if it wins)
  price          numeric not null,          -- 0–1
  usdc           numeric not null,          -- stake in USDC
  fee_usdc       numeric not null default 0,
  builder_fee    numeric not null default 0,
  tx_hash        text,
  matched_at     timestamptz not null,
  status         text not null default 'open',   -- open | won | lost | void
  pnl            numeric,                   -- settled P&L in USDC (null while open)
  created_at     timestamptz not null default now(),
  constraint bets_status check (status in ('open','won','lost','void')),
  constraint bets_side check (side in ('BUY','SELL'))
);
create index if not exists bets_profile_time_idx on public.bets (profile_id, matched_at desc);
create index if not exists bets_time_idx on public.bets (matched_at desc);
create index if not exists bets_condition_idx on public.bets (condition_id);
create index if not exists bets_wallet_idx on public.bets (wallet);

-- ───────────────────────────── reactions ─────────────────────────────
create table if not exists public.reactions (
  bet_id      text not null references public.bets(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'fire',
  created_at  timestamptz not null default now(),
  primary key (bet_id, profile_id, kind)
);

-- ───────────────────────────── indexer state ─────────────────────────
create table if not exists public.indexer_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ───────────────────────────── stats view ────────────────────────────
-- Record / units / ROI per profile, settled bets only. Units = pnl / stake, flat.
create or replace view public.profile_stats as
select
  p.id as profile_id,
  count(b.id) filter (where b.status in ('won','lost','void')) as settled,
  count(b.id) filter (where b.status = 'won')  as wins,
  count(b.id) filter (where b.status = 'lost') as losses,
  count(b.id) filter (where b.status = 'void') as voids,
  count(b.id) filter (where b.status = 'open') as open_bets,
  coalesce(sum(b.pnl) filter (where b.status in ('won','lost','void')), 0) as pnl,
  coalesce(sum(b.usdc) filter (where b.status in ('won','lost','void')), 0) as staked,
  case when coalesce(sum(b.usdc) filter (where b.status in ('won','lost','void')), 0) > 0
       then round(100 * coalesce(sum(b.pnl) filter (where b.status in ('won','lost','void')), 0)
                  / sum(b.usdc) filter (where b.status in ('won','lost','void')), 2)
       else 0 end as roi_pct,
  (select count(*) from public.follows f where f.followee_id = p.id) as followers,
  (select count(*) from public.follows f where f.follower_id = p.id) as following
from public.profiles p
left join public.bets b on b.profile_id = p.id
group by p.id;

-- ───────────────────────────── RLS ───────────────────────────────────
-- The app reads/writes through server routes with the service role.
-- Public tables are still readable by anon so a future client can read them;
-- nothing is writable by anon.
alter table public.profiles        enable row level security;
alter table public.profile_private enable row level security;
alter table public.follows         enable row level security;
alter table public.markets         enable row level security;
alter table public.bets            enable row level security;
alter table public.reactions       enable row level security;
alter table public.indexer_state   enable row level security;

drop policy if exists "public read profiles"  on public.profiles;
drop policy if exists "public read follows"   on public.follows;
drop policy if exists "public read markets"   on public.markets;
drop policy if exists "public read bets"      on public.bets;
drop policy if exists "public read reactions" on public.reactions;
create policy "public read profiles"  on public.profiles  for select to anon, authenticated using (not is_banned);
create policy "public read follows"   on public.follows   for select to anon, authenticated using (true);
create policy "public read markets"   on public.markets   for select to anon, authenticated using (true);
create policy "public read bets"      on public.bets      for select to anon, authenticated using (true);
create policy "public read reactions" on public.reactions for select to anon, authenticated using (true);
-- profile_private and indexer_state: no policies → service role only.

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists markets_touch on public.markets;
create trigger markets_touch before update on public.markets for each row execute function public.touch_updated_at();
