-- Unidades: tipster-style record independent of stake size (same rule as the LeChanga Challenge).
-- won  → decimal odds − 1   (a 1.90 winner adds +0.9u)
-- lost → −1u
-- void → 0
-- Only BUY fills count (a SELL is an early close; its P&L lives on the BUY row).
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
