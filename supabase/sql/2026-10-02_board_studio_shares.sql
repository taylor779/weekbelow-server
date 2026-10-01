-- Brainstorm boards shared with another studio (by an email of someone in that studio).
-- Run once in the Supabase SQL editor (project fdjnzzrrodrjkngqzewy).
-- Only the Railway server (service role) reads or writes this table: RLS is on with no policies,
-- so app clients can't list who a board is shared with.
create table if not exists public.board_studio_shares (
  id                uuid primary key default gen_random_uuid(),
  board_key         text not null,              -- shared_boards.board_key ("<ownerAgency>:<projectId|global>")
  board_name        text,
  owner_agency_id   text not null,
  guest_agency_id   text not null,
  role              text not null default 'edit' check (role in ('edit', 'view')),
  invited_email     text,
  invited_member_id text,
  created_by        text,                       -- owner's agency_members.id
  created_at        timestamptz not null default now(),
  unique (board_key, guest_agency_id)
);
alter table public.board_studio_shares enable row level security;
create index if not exists board_studio_shares_guest on public.board_studio_shares (guest_agency_id);
create index if not exists board_studio_shares_board on public.board_studio_shares (board_key);
