-- 0012 · fee counted once · one definition of "staked" · one clock per job   (2026-10-29)

-- 1. Polymarket's `feeUsdc` on a builder fill ALREADY CONTAINS the builder fee. Verified on the live
--    /builder/trades feed on 2026-10-28/29: feeUsdc − builderFee = rate · p·(1−p) · size exactly
--    (3% NFL, 5% Liga MX), and on 0% markets feeUsdc == builderFee. The indexer used to add
--    `builder_fee` on top, so every settled P&L was understated by the builder fee (~0.5% of the
--    stake). Recompute every settled BUY from the fill itself. Idempotent: safe to run again.
update public.bets
set pnl = case
  when status = 'won'  then size - (usdc + fee_usdc)
  when status = 'lost' then -(usdc + fee_usdc)
  else pnl
end
where side = 'BUY' and status in ('won', 'lost');

-- 2. One definition of the record. staked = what left the wallet on settled BUY fills (shares +
--    fees), the same number the feed cards and the rolling windows use; ROI = pnl / staked.
--    Counts cover BUY rows only (a SELL is an early close whose P&L lives on the BUY row).
--    Column list, order and types are unchanged, so `create or replace` is allowed.
create or replace view public.profile_stats as
select
  p.id as profile_id,
  count(b.id) filter (where b.side = 'BUY' and b.status in ('won','lost','void')) as settled,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'won')  as wins,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'lost') as losses,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'void') as voids,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'open') as open_bets,
  coalesce(sum(b.pnl) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0) as pnl,
  coalesce(sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost')), 0) as staked,
  case when coalesce(sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost')), 0) > 0
       then round(100 * coalesce(sum(b.pnl) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0)
                  / sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost')), 2)
       else 0 end as roi_pct,
  (select count(*) from public.follows f where f.followee_id = p.id) as followers,
  (select count(*) from public.follows f where f.follower_id = p.id) as following,
  coalesce(sum(
    case
      when b.side = 'BUY' and b.status = 'won' and b.price > 0 then (1 / b.price) - 1
      when b.side = 'BUY' and b.status = 'lost' then -1
      else 0
    end
  ), 0) as units
from public.profiles p
left join public.bets b on b.profile_id = p.id
group by p.id;

-- 3. One clock per job. The indexer and the Arena settler run from Vercel cron every minute and
--    also on demand (a user's post-bet sync, an instant settle), each run on its own instance, so
--    two could overlap and settle or send twice. Postgres advisory locks do not fit PostgREST
--    (pooled connections: a session lock may never be released, a transaction lock ends with the
--    RPC call), so this is a lease: one row per job with an expiry, taken and released through
--    two small functions. Service role only.
create table if not exists public.job_locks (
  name         text primary key,
  locked_until timestamptz not null default 'epoch',
  holder       text,
  updated_at   timestamptz not null default now()
);
alter table public.job_locks enable row level security;
-- no policies on purpose: anon/authenticated never read or write locks

create or replace function public.acquire_job_lock(p_name text, p_ttl_seconds integer, p_holder text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  got integer;
begin
  insert into public.job_locks (name) values (p_name) on conflict (name) do nothing;
  update public.job_locks
     set locked_until = now() + make_interval(secs => p_ttl_seconds),
         holder       = p_holder,
         updated_at   = now()
   where name = p_name
     and locked_until < now();
  get diagnostics got = row_count;
  return got > 0;
end;
$$;

create or replace function public.release_job_lock(p_name text, p_holder text)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.job_locks
     set locked_until = 'epoch', updated_at = now()
   where name = p_name and holder = p_holder;
$$;

revoke execute on function public.acquire_job_lock(text, integer, text) from public, anon, authenticated;
revoke execute on function public.release_job_lock(text, text) from public, anon, authenticated;
grant execute on function public.acquire_job_lock(text, integer, text) to service_role;
grant execute on function public.release_job_lock(text, text) to service_role;
