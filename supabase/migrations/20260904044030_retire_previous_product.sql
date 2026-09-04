-- Retires the previous product's tables. Its `forms` and `records` held demo
-- data only; the current product keeps its own rows in `scans`.
drop table if exists public.records;
drop table if exists public.forms;

-- The old read policy named both buckets; the current one names the one that
-- stays. `captures` (the previous product's archived uploads) is emptied and
-- deleted through the Storage API right after this migration — storage rows
-- cannot be deleted from SQL — under the temporary policies below, which
-- the next migration drops.
drop policy if exists captures_insert on storage.objects;
drop policy if exists captures_read on storage.objects;
create policy crops_read on storage.objects
  for select using (bucket_id = 'crops');

create policy retire_read on storage.objects
  for select using (bucket_id = 'captures');
create policy retire_delete on storage.objects
  for delete using (bucket_id = 'captures' or (bucket_id = 'crops' and name not like 'scans/%'));
create policy retire_bucket_select on storage.buckets
  for select using (id = 'captures');
create policy retire_bucket_delete on storage.buckets
  for delete using (id = 'captures');
