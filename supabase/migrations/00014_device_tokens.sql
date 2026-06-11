-- =====================================================================
-- Blink Server — Device push tokens + notification delete policy
-- =====================================================================
-- Authored in Drizzle (src/db/schema/device-tokens.ts). Stores Expo push
-- tokens so the server can deliver push notifications (src/lib/push.ts) to
-- every device a user has registered. Additive only.

CREATE TABLE "device_tokens" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"    uuid NOT NULL,
  "token"      text NOT NULL,
  "platform"   text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);

ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "idx_device_tokens_user" ON "device_tokens" USING btree ("user_id");

-- A user manages only their own device tokens. Server writes go through the
-- service role (bypasses RLS), same as the rest of the app routes.
CREATE POLICY "device_tokens_select_own" ON "device_tokens" AS PERMISSIVE FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "device_tokens_insert_own" ON "device_tokens" AS PERMISSIVE FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
CREATE POLICY "device_tokens_update_own" ON "device_tokens" AS PERMISSIVE FOR UPDATE TO public USING (auth.uid() = user_id);
CREATE POLICY "device_tokens_delete_own" ON "device_tokens" AS PERMISSIVE FOR DELETE TO public USING (auth.uid() = user_id);

-- updated_at auto-bump (reuses update_updated_at() from 00001).
CREATE TRIGGER trg_device_tokens_updated_at
  BEFORE UPDATE ON "device_tokens" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Notifications: allow a user to delete their own ─────────────────
-- The baseline (00001) shipped select/update policies only; the mobile app's
-- swipe-to-delete needs a delete policy too.
CREATE POLICY "notifications_delete_own" ON "notifications" AS PERMISSIVE FOR DELETE TO public USING (auth.uid() = user_id);
