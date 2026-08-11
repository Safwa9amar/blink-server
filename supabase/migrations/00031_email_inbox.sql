-- =====================================================================
-- Blink Server — Customer email inbox (IMAP intake + SMTP replies)
-- =====================================================================
-- Authored to mirror src/db/schema/email-threads.ts + email-messages.ts.
-- Applied via the existing `npm run db:push` pipeline. Additive only.
-- RLS is SELECT-only for staff — all writes are server-side via the service
-- role (the IMAP poller and the SMTP reply route). Both tables join the
-- supabase_realtime publication so the dashboard inbox can subscribe.

CREATE TYPE "public"."email_thread_status" AS ENUM('open', 'assigned', 'closed');
CREATE TYPE "public"."email_direction" AS ENUM('inbound', 'outbound');

CREATE TABLE IF NOT EXISTS "email_threads" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_email"        text NOT NULL,
  "customer_name"         text,
  "user_id"               uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "subject"               text,
  "normalized_subject"    text DEFAULT '' NOT NULL,
  "status"                "email_thread_status" DEFAULT 'open' NOT NULL,
  "assigned_agent_id"     uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "last_message_at"       timestamptz DEFAULT now() NOT NULL,
  "last_message_preview"  text,
  "last_direction"        "email_direction",
  "unread_for_staff"      integer DEFAULT 0 NOT NULL,
  "message_count"         integer DEFAULT 0 NOT NULL,
  "created_at"            timestamptz DEFAULT now() NOT NULL,
  "updated_at"            timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "email_messages" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id"     uuid NOT NULL REFERENCES "public"."email_threads"("id") ON DELETE CASCADE,
  "direction"     "email_direction" NOT NULL,
  "message_id"    text,
  "in_reply_to"   text,
  "from_email"    text NOT NULL,
  "from_name"     text,
  "to_email"      text NOT NULL,
  "subject"       text,
  "body_text"     text DEFAULT '' NOT NULL,
  "body_html"     text,
  "sender_id"     uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "meta"          jsonb,
  "created_at"    timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_email_threads_status"       ON "email_threads"  USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_email_threads_assigned"     ON "email_threads"  USING btree ("assigned_agent_id");
CREATE INDEX IF NOT EXISTS "idx_email_threads_customer"     ON "email_threads"  USING btree ("customer_email");
CREATE INDEX IF NOT EXISTS "idx_email_threads_last_msg"     ON "email_threads"  USING btree ("last_message_at");
CREATE INDEX IF NOT EXISTS "idx_email_threads_norm_subject" ON "email_threads"  USING btree ("normalized_subject");
CREATE INDEX IF NOT EXISTS "idx_email_messages_thread"      ON "email_messages" USING btree ("thread_id", "created_at");

-- Idempotency: a given RFC Message-ID is stored once, so re-polling IMAP is a
-- no-op. Partial (outbound rows may carry a null message_id before send).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_messages_message_id"
  ON "email_messages" USING btree ("message_id") WHERE "message_id" IS NOT NULL;

ALTER TABLE "email_threads"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;

-- Staff-only visibility (external customers aren't authenticated Blink users, so
-- there is no owner policy). Writes bypass RLS via the service role.
CREATE POLICY "email_threads_select_staff" ON "email_threads"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
  );

CREATE POLICY "email_messages_select_staff" ON "email_messages"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
  );

-- updated_at auto-bump (reuses update_updated_at() from the baseline migration).
CREATE TRIGGER trg_email_threads_updated_at
  BEFORE UPDATE ON "email_threads" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Realtime ────────────────────────────────────────────────────────
-- Full row images (updates/deletes) + membership in the publication so the
-- dashboard inbox can subscribe (RLS-scoped to staff).
ALTER TABLE "email_threads"  REPLICA IDENTITY FULL;
ALTER TABLE "email_messages" REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_threads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_messages;
