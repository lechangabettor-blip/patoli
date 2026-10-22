-- When a sports bet settled. Rolling windows (últimos 7 / 30 días) count a bet by this moment.
-- Backfilled from the market's resolution time for bets settled before this column existed.
alter table public.bets add column if not exists settled_at timestamptz;

update public.bets b
set settled_at = coalesce(m.resolved_at, now())
from public.markets m
where m.condition_id = b.condition_id
  and b.status <> 'open'
  and b.settled_at is null;

create index if not exists bets_profile_settled_idx on public.bets (profile_id, settled_at desc);
