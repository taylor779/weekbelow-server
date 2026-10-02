-- Run once in the Supabase SQL editor (any time).
-- Which app version each signed-in device is running (native app check-in → Railway; admins see it on Team).
create table if not exists public.app_installs (
  install_id   text primary key,          -- random per-install id kept on the device
  user_id      text not null,             -- auth uid
  agency_id    text not null,
  member_id    text,
  platform     text,                      -- "mac" | "ios" | "ipad"
  device_name  text,
  version      text,                      -- e.g. "2.0.0"
  build        text,                      -- e.g. "202610021"
  last_seen    timestamptz not null default now()
);
alter table public.app_installs enable row level security;   -- no policies: Railway only
revoke all on table public.app_installs from anon, authenticated;
create index if not exists app_installs_agency on public.app_installs (agency_id, last_seen desc);
