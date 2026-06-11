import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationType } from "./enums";
import { users } from "./users";

// Per-language copy for a notification. `title`/`description` on the row stay the
// canonical (English) fallback the app renders when a language block is absent;
// these JSONB columns hold the localized strings the dashboard composer captures.
export interface NotificationCopy {
  title: string;
  description: string;
}

// NOTE: notifications has only `created_at` (no updated_at) — matches 00001.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    isUnread: boolean("is_unread").notNull().default(true),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    href: text("href"),
    // Localized copy ({ title, description }); null falls back to title/description.
    contentEng: jsonb("content_eng").$type<NotificationCopy>(),
    contentFr: jsonb("content_fr").$type<NotificationCopy>(),
    contentAr: jsonb("content_ar").$type<NotificationCopy>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    // Soft delete: dismissing a notification hides it from the user's feed but
    // keeps the row (audit/analytics). Reads filter `deleted_at IS NULL`; the
    // app's "delete" is an UPDATE setting this, never a row delete.
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_notifications_user").on(t.userId),
    index("idx_notifications_unread")
      .on(t.userId, t.isUnread)
      .where(sql`is_unread = true`),
    pgPolicy("notifications_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
    pgPolicy("notifications_update_own", { for: "update", using: sql`auth.uid() = user_id` }),
  ]
);
