-- =====================================================================
-- Blink Server — account deletion history
-- =====================================================================
-- Mirrors src/db/schema/account-deletion-requests.ts. Completing a request wipes
-- the user's personal data, so the request keeps who the account belonged to
-- (`user_snapshot`) and which staff member processed it (`processed_by`).
-- Applied via MCP; the file name matches the recorded version.

ALTER TABLE "account_deletion_requests"
  ADD COLUMN IF NOT EXISTS "processed_by" uuid,
  ADD COLUMN IF NOT EXISTS "user_snapshot" jsonb;

DO $$ BEGIN
  ALTER TABLE "account_deletion_requests"
    ADD CONSTRAINT "account_deletion_requests_processed_by_fkey"
    FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_account_deletion_requests_processed_at"
  ON "account_deletion_requests" ("processed_at" DESC);
