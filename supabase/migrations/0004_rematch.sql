-- Doble o nada: a 10-second rematch window after a match. Either player opens it;
-- when both have tapped inside the window the server creates the next match
-- (same players, double stake, capped) and links it here.
alter table public.arena_matches add column if not exists rematch_a_at     timestamptz;
alter table public.arena_matches add column if not exists rematch_b_at     timestamptz;
alter table public.arena_matches add column if not exists rematch_expires_at timestamptz;
alter table public.arena_matches add column if not exists rematch_id       text references public.arena_matches(id);
alter table public.arena_matches add column if not exists parent_id        text references public.arena_matches(id);
