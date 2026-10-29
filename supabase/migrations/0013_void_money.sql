-- 0013 · void bets count their money   (2026-10-29)
--
-- A market resolved 50/50 (postponed game, split payout) pays 1/n of a dollar per share, so a
-- voided bet still moves money: a favourite bought at 80¢ loses 30¢ a share plus the fee. The
-- indexer now writes that real P&L on void BUY rows (status stays 'void', Unidades stay 0 — a
-- push for the tipster record). The view must count those rows in `staked` so ROI = pnl / staked
-- keeps one definition with the rolling windows. Same columns, order and types as 0012.
create or replace view public.profile_stats as
select
  p.id as profile_id,
  count(b.id) filter (where b.side = 'BUY' and b.status in ('won','lost','void')) as settled,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'won')  as wins,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'lost') as losses,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'void') as voids,
  count(b.id) filter (where b.side = 'BUY' and b.status = 'open') as open_bets,
  coalesce(sum(b.pnl) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0) as pnl,
  coalesce(sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0) as staked,
  case when coalesce(sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0) > 0
       then round(100 * coalesce(sum(b.pnl) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 0)
                  / sum(b.usdc + b.fee_usdc) filter (where b.side = 'BUY' and b.status in ('won','lost','void')), 2)
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

-- Void BUY rows settled before today carried pnl 0; recompute from the market's outcome count.
update public.bets b
set pnl = b.size / greatest(coalesce(jsonb_array_length(m.outcomes), 2), 1) - (b.usdc + b.fee_usdc)
from public.markets m
where m.condition_id = b.condition_id
  and b.side = 'BUY'
  and b.status = 'void'
  and m.winning_index = -1;
