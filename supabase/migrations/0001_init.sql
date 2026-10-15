-- AEGIS brief dashboard: initial schema.
-- Binding spec: docs/CONTRACT.md section 6.
--
-- Safe to re-run. Tables use "if not exists", policies are dropped and
-- recreated, buckets are upserted. Apply with the Supabase SQL editor
-- (paste the whole file) or with `supabase db push`.
--
-- Access model:
--   anon           no access to anything below.
--   authenticated  read briefs and archive_index; own feedback; own settings.
--   service_role   the worker's key. Bypasses RLS for upserts and uploads.

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- gen_random_uuid() is built in on Postgres 13+, so no extension is needed.

-- Stamp updated_at on every update (including PostgREST upserts, which
-- fire BEFORE UPDATE triggers on the conflict path).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- One row per retained brief. data is the validated brief JSON (CONTRACT section 1).
create table if not exists public.briefs (
  date        text primary key check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- Single-row table holding the derived archive index (CONTRACT section 2).
create table if not exists public.archive_index (
  id          int primary key default 1 check (id = 1),
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- Reader feedback. user_id defaults to the caller so the client may omit it;
-- the insert policy still requires it to equal auth.uid().
create table if not exists public.feedback (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid default auth.uid() references auth.users(id) on delete cascade,
  created_at       timestamptz default now(),
  page             text,
  bug              text,
  change           text,
  screenshot_path  text
);

create index if not exists feedback_user_id_idx on public.feedback (user_id);

-- Per-user dashboard state.
create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  my_areas    jsonb default '[]'::jsonb,
  stars       jsonb default '[]'::jsonb,
  viewed      jsonb default '[]'::jsonb,
  theme       text,
  updated_at  timestamptz default now()
);

-- updated_at triggers
drop trigger if exists briefs_set_updated_at on public.briefs;
create trigger briefs_set_updated_at
  before update on public.briefs
  for each row execute function public.set_updated_at();

drop trigger if exists archive_index_set_updated_at on public.archive_index;
create trigger archive_index_set_updated_at
  before update on public.archive_index
  for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Grants (explicit, so the result does not depend on project defaults)
-- ---------------------------------------------------------------------------

-- Supabase grants everything on public tables to anon and authenticated by
-- default and relies on RLS alone. Narrow the grants as a second layer.
revoke all on table public.briefs, public.archive_index, public.feedback, public.user_settings
  from anon, authenticated;

grant select                 on table public.briefs        to authenticated;
grant select                 on table public.archive_index to authenticated;
grant select, insert         on table public.feedback      to authenticated;
grant select, insert, update on table public.user_settings to authenticated;

grant all on table public.briefs, public.archive_index, public.feedback, public.user_settings to service_role;

-- ---------------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------------

alter table public.briefs        enable row level security;
alter table public.archive_index enable row level security;
alter table public.feedback      enable row level security;
alter table public.user_settings enable row level security;

-- (select auth.uid()) is evaluated once per statement instead of per row.
-- It is equivalent to auth.uid() = user_id.

-- briefs: any signed-in user can read.
drop policy if exists "briefs: authenticated read" on public.briefs;
create policy "briefs: authenticated read"
  on public.briefs for select
  to authenticated
  using (true);

-- archive_index: any signed-in user can read.
drop policy if exists "archive_index: authenticated read" on public.archive_index;
create policy "archive_index: authenticated read"
  on public.archive_index for select
  to authenticated
  using (true);

-- feedback: insert own, read own. No update or delete for users.
drop policy if exists "feedback: insert own" on public.feedback;
create policy "feedback: insert own"
  on public.feedback for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "feedback: read own" on public.feedback;
create policy "feedback: read own"
  on public.feedback for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- user_settings: read, insert and update own row. No delete for users.
drop policy if exists "user_settings: read own" on public.user_settings;
create policy "user_settings: read own"
  on public.user_settings for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_settings: insert own" on public.user_settings;
create policy "user_settings: insert own"
  on public.user_settings for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_settings: update own" on public.user_settings;
create policy "user_settings: update own"
  on public.user_settings for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 4. Storage buckets (both private)
-- ---------------------------------------------------------------------------

-- rendered-briefs: the worker uploads <date>.html here when SYNC_TO_SUPABASE=1.
insert into storage.buckets (id, name, public)
values ('rendered-briefs', 'rendered-briefs', false)
on conflict (id) do update set public = false;

-- feedback-screenshots: users upload to <their uid>/<file>. Images only, 10 MB cap.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-screenshots', 'feedback-screenshots', false, 10485760, array['image/*'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects already has RLS enabled by Supabase. Do not alter the table.

drop policy if exists "rendered-briefs: authenticated read" on storage.objects;
create policy "rendered-briefs: authenticated read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'rendered-briefs');

drop policy if exists "feedback-screenshots: insert own folder" on storage.objects;
create policy "feedback-screenshots: insert own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'feedback-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "feedback-screenshots: read own folder" on storage.objects;
create policy "feedback-screenshots: read own folder"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'feedback-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
