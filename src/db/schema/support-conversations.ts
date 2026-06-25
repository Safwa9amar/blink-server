import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { userRole } from "./enums";
import { users } from "./users";

// Lives with the table (not in enums.ts) so it ships in the additive
// 00023 migration rather than the baseline snapshot — same convention as
// news_status in ./news.ts.
export const supportConversationStatus = pgEnum("support_conversation_status", [
  "bot",
  "waiting",
  "assigned",
  "resolved",
]);

// One persistent support thread per user. The bot answers in `bot` mode; an
// escalation moves it to `waiting`; a dashboard agent claims it (`assigned`)
// and resolves it (`resolved`). Writes are server-only (service role); RLS is
// select-only (owner + staff). Subscribed to via Supabase Realtime.
export const supportConversations = pgTable(
  "support_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userRole: userRole("user_role").notNull(),
    status: supportConversationStatus("status").notNull().default("bot"),
    assignedAgentId: uuid("assigned_agent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    subject: text("subject"),
    locale: text("locale").notNull().default("en"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastMessagePreview: text("last_message_preview"),
    unreadForStaff: integer("unread_for_staff").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("idx_support_conversations_status").on(t.status),
    index("idx_support_conversations_assigned").on(t.assignedAgentId),
    index("idx_support_conversations_user").on(t.userId),
    index("idx_support_conversations_last_msg").on(t.lastMessageAt),
    pgPolicy("support_conversations_select_own_or_staff", {
      for: "select",
      using: sql`auth.uid() = user_id OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);
