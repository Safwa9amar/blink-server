-- =====================================================================
-- Blink Server — User avatars storage bucket
-- =====================================================================
-- Profile pictures for all roles. Public read (served via the bucket's public
-- URL); uploads happen server-side through the service role (POST /auth/avatar),
-- which writes to a per-user folder `avatars/<user_id>/...`. Storage is Supabase
-- infra, not a Drizzle table, so it lives as a plain Supabase migration.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- The service role bypasses RLS on uploads. These policies additionally let an
-- authenticated user manage objects only in THEIR OWN folder (first path
-- segment = their uid), in case of future direct client uploads.
create policy "avatars_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
