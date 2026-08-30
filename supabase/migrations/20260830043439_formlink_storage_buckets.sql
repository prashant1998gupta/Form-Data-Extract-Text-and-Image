-- Two buckets, split by what the product promises about each.
--
-- `captures` holds the ORIGINAL uploaded image — the "original form archived"
-- half of the product, and the reason the spec's Must item exists. Private:
-- a photograph of a filled patient form is medical data.
--
-- `crops` holds the extracted photograph, signature and thumb impression.
-- Also private. Neither is ever served to a browser as a storage URL: the app
-- streams them through `/api/records/[reference]/image/[kind]` so no bearer
-- token for a patient's photograph outlives the page it was rendered in.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('captures', 'captures', false, 26214400, array['image/jpeg','image/png','image/webp']),
  ('crops',    'crops',    false, 10485760, array['image/png','image/jpeg'])
on conflict (id) do nothing;

-- The anon key may write and read objects in these buckets, and may not
-- delete them: a saved record's evidence is not something a browser revokes.
create policy captures_insert on storage.objects
  for insert with check (bucket_id = 'captures');
create policy captures_read on storage.objects
  for select using (bucket_id in ('captures', 'crops'));
create policy crops_insert on storage.objects
  for insert with check (bucket_id = 'crops');
