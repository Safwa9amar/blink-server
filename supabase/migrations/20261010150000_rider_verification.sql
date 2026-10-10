-- =====================================================================
-- Rider verification (Become a Partner piece 3)
-- =====================================================================
-- Mirrors src/db/schema/rider-profiles.ts. Riders upload driving licence +
-- national ID (front/back) to the private `rider-documents` bucket; staff
-- review each document; the server lets a rider work only once
-- verification_status = 'approved' (src/lib/rider-access.ts).

DO $$ BEGIN
  CREATE TYPE "rider_verification_status" AS ENUM ('not_submitted', 'pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- { license_front|license_back|id_front|id_back:
--   { path, status pending|verified|rejected, note, uploaded_at } }
ALTER TABLE "rider_profiles"
  ADD COLUMN IF NOT EXISTS "documents" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "verification_status" "rider_verification_status"
    DEFAULT 'not_submitted' NOT NULL;

-- Legacy licence URLs (never filled by the app, 0 rows today) are carried
-- into documents as pending; the columns are dropped in a later migration
-- once nothing reads them (20261010150500_rider_profiles_drop_license_urls.sql).
UPDATE "rider_profiles"
SET "documents" = "documents"
  || CASE WHEN "license_front_url" IS NOT NULL THEN jsonb_build_object('license_front',
       jsonb_build_object('path', "license_front_url", 'status', 'pending', 'note', NULL,
                          'uploaded_at', to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
     ELSE '{}'::jsonb END
  || CASE WHEN "license_back_url" IS NOT NULL THEN jsonb_build_object('license_back',
       jsonb_build_object('path', "license_back_url", 'status', 'pending', 'note', NULL,
                          'uploaded_at', to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
     ELSE '{}'::jsonb END
WHERE "license_front_url" IS NOT NULL OR "license_back_url" IS NOT NULL;

-- Only riders whose active role is rider at migration time predate
-- verification and are grandfathered as approved. rider_profiles rows that
-- belong to other roles (customers who unlocked rider, or stray rows from
-- the old /auth/role) keep the column default 'not_submitted'.
UPDATE public.rider_profiles rp
   SET verification_status = 'approved'
  FROM public.users u
 WHERE u.id = rp.user_id AND u.role = 'rider';

-- A new (unverified) rider starts offline; going online is gated server-side.
ALTER TABLE "rider_profiles" ALTER COLUMN "is_available" SET DEFAULT false;

-- ─── Privileges: clients read their row, never write it ──────────────
-- The app and the dashboard never write rider_profiles directly (all writes
-- go through blink-server with the service role). Without this, a rider
-- could PATCH is_available / verification_status / documents via PostgREST.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.rider_profiles FROM anon, authenticated;

-- Defence in depth, as for the sibling guards in
-- 20261010100000_verification_columns_lockdown.sql: even if a broad grant
-- comes back, client roles can't touch these columns. Server writes
-- (service_role / postgres) are exempt.
CREATE OR REPLACE FUNCTION public.guard_rider_profiles_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
       TG_OP = 'INSERT'
    OR (TG_OP = 'UPDATE' AND (
         new.verification_status IS DISTINCT FROM old.verification_status
      OR new.documents IS DISTINCT FROM old.documents
      OR new.is_available IS DISTINCT FROM old.is_available
    ))
  ) THEN
    RAISE EXCEPTION 'permission denied: privileged rider_profiles column' USING errcode = '42501';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_rider_profiles_guard_privileged ON public.rider_profiles;
CREATE TRIGGER trg_rider_profiles_guard_privileged
  BEFORE INSERT OR UPDATE ON public.rider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_rider_profiles_privileged_columns();

-- ─── Storage: private bucket for the documents ───────────────────────
-- Uploads go through POST /riders/uploads (service role). Staff and the app
-- read through short-lived signed URLs created by the server.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('rider-documents', 'rider-documents', false, 8388608,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false;

-- A rider may read objects in their own folder (<uid>/...); no client writes.
DROP POLICY IF EXISTS "rider_documents_select_own" ON storage.objects;
CREATE POLICY "rider_documents_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'rider-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
