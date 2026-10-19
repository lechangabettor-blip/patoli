-- Why a "doble o nada" could not be created (shown to both players).
alter table public.arena_matches add column if not exists rematch_error text;
-- One rematch per match: lets the server insert the child first and detect a double-create.
create unique index if not exists arena_matches_parent_key on public.arena_matches (parent_id) where parent_id is not null;
