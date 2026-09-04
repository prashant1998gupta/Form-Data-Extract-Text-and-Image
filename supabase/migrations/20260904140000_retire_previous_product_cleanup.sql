-- The previous product's files and its `captures` bucket were deleted through
-- the Storage API under the temporary policies the last migration created.
-- With nothing left for them to cover, they go too. What remains for
-- storage: crops_insert, crops_read and crops_delete_scans on `crops`.
drop policy if exists retire_read on storage.objects;
drop policy if exists retire_delete on storage.objects;
drop policy if exists retire_bucket_select on storage.buckets;
drop policy if exists retire_bucket_delete on storage.buckets;
