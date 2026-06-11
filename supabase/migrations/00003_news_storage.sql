-- =====================================================================
-- Blink Server — News images storage bucket
-- =====================================================================
-- Covers + inline body images for the News CMS. Public read (served via the
-- bucket's public URL); uploads happen server-side through the service role
-- (the dashboard admin console). Storage is Supabase infra, not a Drizzle table,
-- so it lives as a plain Supabase migration.

insert into storage.buckets (id, name, public)
values ('news', 'news', true)
on conflict (id) do nothing;

-- The service role bypasses RLS on uploads; these policies additionally allow an
-- authenticated user to manage objects in the news bucket (future client uploads).
create policy "news_storage_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'news');
create policy "news_storage_update" on storage.objects
  for update to authenticated using (bucket_id = 'news');
create policy "news_storage_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'news');
