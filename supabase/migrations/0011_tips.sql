-- Tips: pUSD sent from one deposit wallet to another, recorded only after the server has read
-- the Transfer log of that transaction on Polygon. Private: never in the feed; the recipient sees
-- their own total in Perfil.
create table if not exists public.tips (
  tx_hash      text primary key,            -- Polygon tx, lowercase 0x…
  from_profile uuid not null references public.profiles(id) on delete cascade,
  to_profile   uuid not null references public.profiles(id) on delete cascade,
  amount       numeric not null check (amount > 0 and amount <= 100),
  created_at   timestamptz not null default now()
);
create index if not exists tips_to_idx on public.tips (to_profile, created_at desc);
create index if not exists tips_from_idx on public.tips (from_profile, created_at desc);
alter table public.tips enable row level security;
-- no public policy: only the service role reads/writes tips
