-- =====================================================================
-- Blink Server — in-app account deletion requests
-- =====================================================================
-- Mirrors src/db/schema/account-deletion-requests.ts. The app files a request
-- (POST /auth/account/deletion-request) and signs out; staff complete it.

CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"      uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "role"         "user_role" NOT NULL,
  "reason"       text,
  "feedback"     text,
  "status"       text DEFAULT 'pending' NOT NULL
    CHECK ("status" IN ('pending', 'completed', 'cancelled')),
  "processed_at" timestamptz,
  "created_at"   timestamptz DEFAULT now() NOT NULL,
  "updated_at"   timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_account_deletion_requests_user"   ON "account_deletion_requests" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_account_deletion_requests_status" ON "account_deletion_requests" ("status");
-- One open request per user.
CREATE UNIQUE INDEX IF NOT EXISTS "account_deletion_requests_one_pending"
  ON "account_deletion_requests" ("user_id") WHERE "status" = 'pending';

ALTER TABLE "account_deletion_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_deletion_requests_select_own" ON "account_deletion_requests";
CREATE POLICY "account_deletion_requests_select_own" ON "account_deletion_requests"
  FOR SELECT USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS trg_account_deletion_requests_updated_at ON "account_deletion_requests";
CREATE TRIGGER trg_account_deletion_requests_updated_at
  BEFORE UPDATE ON "account_deletion_requests" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
