-- =====================================================================
-- Blink Server — Support live chat (AI bot + human escalation)
-- =====================================================================
-- Authored to mirror src/db/schema/support-conversations.ts +
-- support-messages.ts. Applied via the existing `npm run db:push` pipeline.
-- Additive only. RLS is SELECT-only (owner + staff) — all writes are
-- server-side via the service role. Both tables join the supabase_realtime
-- publication so the app & dashboard can subscribe (RLS-scoped).

CREATE TYPE "public"."support_conversation_status" AS ENUM('bot', 'waiting', 'assigned', 'resolved');
CREATE TYPE "public"."support_message_sender" AS ENUM('user', 'bot', 'agent', 'system');

CREATE TABLE IF NOT EXISTS "support_conversations" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"               uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "user_role"             "user_role" NOT NULL,
  "status"                "support_conversation_status" DEFAULT 'bot' NOT NULL,
  "assigned_agent_id"     uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "subject"               text,
  "locale"                text DEFAULT 'en' NOT NULL,
  "last_message_at"       timestamptz DEFAULT now() NOT NULL,
  "last_message_preview"  text,
  "unread_for_staff"      integer DEFAULT 0 NOT NULL,
  "created_at"            timestamptz DEFAULT now() NOT NULL,
  "updated_at"            timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "support_messages" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id"  uuid NOT NULL REFERENCES "public"."support_conversations"("id") ON DELETE CASCADE,
  "sender"           "support_message_sender" NOT NULL,
  "sender_id"        uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "body"             text NOT NULL,
  "meta"             jsonb,
  "created_at"       timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_support_conversations_status"   ON "support_conversations" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_support_conversations_assigned" ON "support_conversations" USING btree ("assigned_agent_id");
CREATE INDEX IF NOT EXISTS "idx_support_conversations_user"     ON "support_conversations" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_support_conversations_last_msg" ON "support_conversations" USING btree ("last_message_at");
CREATE INDEX IF NOT EXISTS "idx_support_messages_conversation"  ON "support_messages" USING btree ("conversation_id", "created_at");

ALTER TABLE "support_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;

-- Owner sees own conversation; any staff member (non-null staff_role) sees all.
CREATE POLICY "support_conversations_select_own_or_staff" ON "support_conversations"
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)
  );

CREATE POLICY "support_messages_select_own_or_staff" ON "support_messages"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM support_conversations sc
      WHERE sc.id = conversation_id
        AND (sc.user_id = auth.uid()
             OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL))
    )
  );

-- updated_at auto-bump (reuses update_updated_at() from the baseline migration).
CREATE TRIGGER trg_support_conversations_updated_at
  BEFORE UPDATE ON "support_conversations" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Realtime (new idiom for this repo) ──────────────────────────────
-- postgres_changes needs full row images for deletes/updates and the tables
-- in the supabase_realtime publication. Subscribers are RLS-scoped.
ALTER TABLE "support_conversations" REPLICA IDENTITY FULL;
ALTER TABLE "support_messages" REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
