-- FormLink core schema.
--
-- The product's rules, enforced in the database rather than trusted to the app:
--   * a record is only ever written by an explicit human Save (the app calls a
--     single insert; there is no auto-save path anywhere),
--   * every extracted value carries whether a human confirmed it,
--   * the ORIGINAL capture is stored, unmodified, beside the record.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Forms: an organization's paper form, recreated once.
-- ---------------------------------------------------------------------------
create table public.forms (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 120),
  -- The public link. Short, URL-safe, and unique: this is what staff open.
  slug         text not null unique check (slug ~ '^[a-z0-9-]{6,64}$'),
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  page_size    text not null default 'A4',
  -- Millimetre geometry + field list, in the WIRE shape the builder emits, so
  -- the row round-trips through exactly the parser that validated it
  -- (`parseStoredTemplate` in lib/templates/custom.ts). JSONB rather than a
  -- table per field: the template is read and written whole, always, and a
  -- schema migration per new field type would be a tax on the one thing this
  -- product must make cheap.
  template     jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index forms_status_idx on public.forms (status, updated_at desc);

-- ---------------------------------------------------------------------------
-- Records: one saved scan of one form.
-- ---------------------------------------------------------------------------
create table public.records (
  id             uuid primary key default gen_random_uuid(),
  form_id        uuid not null references public.forms (id) on delete cascade,
  -- Human-facing identifier, e.g. HSP-4F2A19. Random rather than sequential: a
  -- sequential id on a patient receipt tells a stranger how many patients were
  -- seen this week and lets anyone guess the neighbouring record.
  reference      text not null unique,
  -- The values as SAVED — after human review, never the model's raw output.
  -- Each entry: { key, label, type, value, source }, where `source` is one of
  -- read | corrected | typed | blank. That word is the audit trail.
  values         jsonb not null default '[]'::jsonb,
  -- Storage paths of the cropped images and the original capture.
  photo_path     text,
  signature_path text,
  thumb_path     text,
  original_path  text,
  -- What the pipeline reported at save time: page method, confidences, the
  -- reader's provider/mode. Kept so a record can always explain itself.
  extraction     jsonb not null default '{}'::jsonb,
  saved_by       text,
  created_at     timestamptz not null default now()
);

create index records_form_idx on public.records (form_id, created_at desc);
create index records_reference_idx on public.records (reference);

-- ---------------------------------------------------------------------------
-- Row level security.
--
-- THIS DEPLOYMENT HAS NO USER ACCOUNTS YET, and these policies are written for
-- that reality rather than pretending otherwise: the anon key may read
-- published forms and read/write records, and may NOT delete anything. Do not
-- read them as a multi-tenant authorization model — they are not one. When
-- auth lands they tighten to org membership, and until then the honest
-- statement is the one in the README: anyone with the URL can publish a form,
-- save a record, or read one.
-- ---------------------------------------------------------------------------
alter table public.forms   enable row level security;
alter table public.records enable row level security;

create policy forms_read_published on public.forms
  for select using (status = 'published');

create policy forms_insert on public.forms
  for insert with check (true);

create policy forms_update on public.forms
  for update using (true) with check (true);

create policy records_read on public.records
  for select using (true);

create policy records_insert on public.records
  for insert with check (true);

-- No delete policy on either table: deletion is not a thing this product does
-- from the browser, and the absence of a policy is the enforcement.

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger forms_touch_updated_at
  before update on public.forms
  for each row execute function public.touch_updated_at();
