-- Saved scans: one row per scan of one form, the way CardLink saves a
-- contact. The photograph lives in the existing private `crops` bucket under
-- scans/<id>/ and is streamed through the app, never served as a storage URL.
--
-- The earlier `forms` and `records` tables belong to the previous product and
-- are left untouched.

create table public.scans (
  id          uuid primary key default gen_random_uuid(),
  -- Which form definition the values belong to (school, hospital, ...).
  -- Validated by the app, not a check constraint, so adding a form is a code
  -- change rather than a migration.
  form        text not null,
  -- Human-facing id, e.g. SCH-4F2A19. Random rather than sequential.
  reference   text not null unique,
  -- The form's title field at save time, denormalised for listing and search.
  title       text not null default '',
  -- Every field of the form, keyed by field key, as the person confirmed it.
  values      jsonb not null default '{}'::jsonb,
  photo_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index scans_form_created_idx on public.scans (form, created_at desc);

create trigger scans_touch_updated_at
  before update on public.scans
  for each row execute function public.touch_updated_at();

-- No accounts yet. The anon key may read, write and delete scans; this is the
-- honest posture the README states, not a multi-tenant model.
alter table public.scans enable row level security;

create policy scans_select on public.scans for select using (true);
create policy scans_insert on public.scans for insert with check (true);
create policy scans_update on public.scans for update using (true) with check (true);
create policy scans_delete on public.scans for delete using (true);

-- Deleting a scan deletes its photograph; the crops bucket previously allowed
-- no deletes at all.
create policy crops_delete_scans on storage.objects
  for delete using (bucket_id = 'crops' and name like 'scans/%');
