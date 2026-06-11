-- =====================================================================
-- Blink Server — Notifications soft delete
-- =====================================================================
-- A user dismissing a notification must NOT remove the row from the DB — it is
-- hidden from their feed only. Add `deleted_at`; reads filter it out, and the
-- app's "delete" becomes an UPDATE setting this timestamp (via the existing
-- notifications_update_own policy). The hard-delete path is retired.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- Feed reads are per-user and skip dismissed rows.
CREATE INDEX IF NOT EXISTS "idx_notifications_user_active"
  ON "notifications" USING btree ("user_id")
  WHERE deleted_at IS NULL;

-- The hard-delete policy added in 00014 is no longer used (dismiss is an
-- UPDATE). Drop it so a row delete can't be issued from the client.
DROP POLICY IF EXISTS "notifications_delete_own" ON "notifications";
