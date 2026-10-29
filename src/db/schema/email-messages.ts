import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { emailDirection, emailThreads } from "./email-threads";
import { users } from "./users";

// One email in a thread. `inbound` rows are parsed from IMAP by the poller;
// `outbound` rows are staff replies sent over SMTP. Append-only (no updated_at,
// matching support_messages / notifications). `message_id` is the RFC Message-ID
// header — unique so re-polling the same IMAP message is a no-op (idempotent).
// `meta` carries attachment summaries, cc, and the raw From/To when useful.
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    direction: emailDirection("direction").notNull(),
    // RFC 5322 Message-ID (with angle brackets) — the idempotency key for
    // inbound polling and the anchor outbound replies reference.
    messageId: text("message_id"),
    // The Message-ID this message replies to (In-Reply-To), used for threading.
    inReplyTo: text("in_reply_to"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    toEmail: text("to_email").notNull(),
    subject: text("subject"),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    // Staff user who sent an outbound reply (null for inbound / system).
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_email_messages_thread").on(t.threadId, t.createdAt),
    // Idempotency: a given Message-ID is stored once. Partial (message_id may be
    // null for outbound rows we generate before the header exists).
    uniqueIndex("uq_email_messages_message_id")
      .on(t.messageId)
      .where(sql`message_id IS NOT NULL`),
    pgPolicy("email_messages_select_staff", {
      for: "select",
      using: sql`EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);
