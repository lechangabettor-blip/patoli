-- Súbaseee / Bájeseee: each tail/fade reaction is backed by exactly one of the viewer's fills,
-- so a single $5 bet cannot be reused as proof on every pick that shares the token.
alter table public.reactions add column if not exists proof_bet_id text references public.bets(id) on delete cascade;
create unique index if not exists reactions_proof_unique on public.reactions (proof_bet_id) where proof_bet_id is not null;
comment on column public.reactions.proof_bet_id is 'tail/fade only: the viewer''s own bets.id that proves it (one reaction per fill)';
