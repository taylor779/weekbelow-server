-- Run in the Supabase SQL editor, in TWO steps.
--
-- STEP 1 (any time): version history for brainstorm boards (server-only table).
create table if not exists public.board_versions (
  id              uuid primary key default gen_random_uuid(),
  board_key       text not null,            -- "<agency>:<projectId|global>[::<cardId>…]"
  agency_id       text not null,
  board_name      text,
  board_json      jsonb not null,
  card_count      int,
  label           text,                     -- e.g. "Before restore"
  created_by      text,
  created_by_name text,
  created_at      timestamptz not null default now()
);
alter table public.board_versions enable row level security;   -- no policies: Railway only
create index if not exists board_versions_key on public.board_versions (board_key, created_at desc);

-- STEP 2 — ONLY AFTER the new web app.html (share-link guests via Railway) is deployed:
-- lock shared_boards down. Until now anyone with the public anon key could read, change or delete
-- every studio's shared boards. After this, only members of the owning studio can touch their rows
-- (guests and other studios go through Railway with the service role).
drop policy if exists "bsh delete" on public.shared_boards;
drop policy if exists "bsh insert" on public.shared_boards;
drop policy if exists "bsh read"   on public.shared_boards;
drop policy if exists "bsh update" on public.shared_boards;
create policy "bsh owner members" on public.shared_boards for all to authenticated
  using (owner_agency_id in (select m.agency_id::text from public.agency_members m where m.user_id = auth.uid() and coalesce(m.active, true)))
  with check (owner_agency_id in (select m.agency_id::text from public.agency_members m where m.user_id = auth.uid() and coalesce(m.active, true)));
revoke all on table public.shared_boards from anon;
