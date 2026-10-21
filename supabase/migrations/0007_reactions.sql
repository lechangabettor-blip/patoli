-- Reactions (🔥) on any feed item: sports bets keep their bet id; battles use "battle:<match id>".
-- The original FK to bets(id) made battles impossible to react to, so the column becomes a plain key.
alter table public.reactions drop constraint if exists reactions_bet_id_fkey;
comment on column public.reactions.bet_id is 'Feed item id: bets.id, or battle:<arena_matches.id>';
create index if not exists reactions_item_idx on public.reactions (bet_id, kind);
