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
import { users } from "./users";

// Lives with the table (not in enums.ts) so it ships in the additive 00031
// migration rather than the baseline snapshot — same convention as
// support_conversation_status in ./support-conversations.ts.
//
// `open`     — needs a reply (a fresh inbound landed, or a closed thread was
//              reopened by a new inbound).
// `assigned` — a dashboard agent has claimed it.
// `closed`   — resolved by staff. A new inbound reopens it to `open`.
export const emailThreadStatus = pgEnum("email_thread_status", [
  "open",
  "assigned",
  "closed",
]);

export const emailDirection = pgEnum("email_direction", ["inbound", "outbound"]);

// One customer email conversation. The external party is identified by
// `customer_email` (an app user or a stranger — `user_id` is linked only when
// the address matches a users.email). Threading groups inbound mail by RFC
// Message-ID reference (In-Reply-To/References) and falls back to a normalized
// subject + participant match. Writes are server-only (IMAP poller + SMTP
// reply route, both service role); RLS is select-only for staff. Subscribed to
// via Supabase Realtime so the dashboard inbox updates live.
export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // External counterpart (lowercased) + the display name from the From header.
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),
    // Linked Blink user when customer_email matches users.email (else null).
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    subject: text("subject"),
    // Subject with Re:/Fwd: prefixes stripped + lowercased — the grouping key.
    normalizedSubject: text("normalized_subject").notNull().default(""),
    status: emailThreadStatus("status").notNull().default("open"),
    assignedAgentId: uuid("assigned_agent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastMessagePreview: text("last_message_preview"),
    // Direction of the most recent message — lets the inbox flag threads
    // waiting on us (`inbound`) vs already answered (`outbound`).
    lastDirection: emailDirection("last_direction"),
    unreadForStaff: integer("unread_for_staff").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("idx_email_threads_status").on(t.status),
    index("idx_email_threads_assigned").on(t.assignedAgentId),
    index("idx_email_threads_customer").on(t.customerEmail),
    index("idx_email_threads_last_msg").on(t.lastMessageAt),
    index("idx_email_threads_norm_subject").on(t.normalizedSubject),
    // Staff-only visibility — external customers aren't authenticated Blink
    // users, so there is no owner policy. Only non-null staff_role sees threads.
    // (The IMAP poller + reply route write through the service role, bypassing
    // RLS entirely.)
    pgPolicy("email_threads_select_staff", {
      for: "select",
      using: sql`EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);
