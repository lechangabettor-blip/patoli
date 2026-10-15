-- Handle changes: cooldown + hold released names + redirect old links.
alter table public.profiles add column if not exists handle_changed_at timestamptz;

create table if not exists public.handle_history (
  handle      text primary key,                 -- the released handle
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  released_at timestamptz not null default now()
);
create index if not exists handle_history_profile_idx on public.handle_history (profile_id);

alter table public.handle_history enable row level security;
drop policy if exists "public read handle_history" on public.handle_history;
create policy "public read handle_history" on public.handle_history for select to anon, authenticated using (true);
