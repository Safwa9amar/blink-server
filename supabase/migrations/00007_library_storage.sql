-- =====================================================================
-- Blink Server — Blink Library product images storage bucket
-- =====================================================================
-- Product photos for the Blink Library catalog. Public read (served via the
-- bucket's public URL); uploads happen from the dashboard admin console — the
-- browser uploads directly to Storage via a service-role signed upload URL
-- (see blink-dashboard/src/app/d/library/action.ts). Storage is Supabase infra,
-- not a Drizzle table, so it lives as a plain Supabase migration. Mirrors the
-- `news` bucket (00003_news_storage.sql).

insert into storage.buckets (id, name, public)
values ('library', 'library', true)
on conflict (id) do nothing;

-- The service role bypasses RLS on uploads; these policies additionally allow an
-- authenticated user to manage objects in the library bucket.
create policy "library_storage_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'library');
create policy "library_storage_update" on storage.objects
  for update to authenticated using (bucket_id = 'library');
create policy "library_storage_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'library');
