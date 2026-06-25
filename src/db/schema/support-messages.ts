import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { supportConversations } from "./support-conversations";
import { users } from "./users";

export const supportMessageSender = pgEnum("support_message_sender", [
  "user",
  "bot",
  "agent",
  "system",
]);

// One message in a support thread. `meta` carries system-event details
// (escalation reason, agent name) or AI model/usage. No updated_at (events are
// append-only) — matches notifications / notification_recipients.
export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => supportConversations.id, { onDelete: "cascade" }),
    sender: supportMessageSender("sender").notNull(),
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_support_messages_conversation").on(t.conversationId, t.createdAt),
    pgPolicy("support_messages_select_own_or_staff", {
      for: "select",
      using: sql`EXISTS (
        SELECT 1 FROM support_conversations sc
        WHERE sc.id = conversation_id
          AND (sc.user_id = auth.uid()
               OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL))
      )`,
    }),
  ]
);
