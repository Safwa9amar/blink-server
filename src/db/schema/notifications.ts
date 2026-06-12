import { sql } from "drizzle-orm";
import {
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationType } from "./enums";

// Per-language copy for a notification. `title`/`description` on the row stay the
// canonical (English) fallback the app renders when a language block is absent;
// these JSONB columns hold the localized strings the dashboard composer captures.
export interface NotificationCopy {
  title: string;
  description: string;
}

// The notification CONTENT, stored ONCE regardless of how many users receive it.
// Per-user delivery + read/archive state lives in notification_recipients, so a
// broadcast is 1 row here + N recipient rows (no content duplication). The `id`
// is the shared, canonical id used in URLs and deep links — every API endpoint
// scopes to the caller via the recipient join, never via a per-user content row.
//
// NOTE: only `created_at` (no updated_at) — matches the baseline.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: notificationType("type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    // Explicit deep-link override only. When null, the API derives the typed
    // detail href at READ time from the requesting user's role + this id (the
    // role segment differs per recipient, so it can't be stored on the shared row).
    href: text("href"),
    // Localized copy ({ title, description }); null falls back to title/description.
    contentEng: jsonb("content_eng").$type<NotificationCopy>(),
    contentFr: jsonb("content_fr").$type<NotificationCopy>(),
    contentAr: jsonb("content_ar").$type<NotificationCopy>(),
    // Audit/analytics: the roles a broadcast targeted (null for 1:1 system sends).
    targetRoles: text("target_roles").array(),
    // Staff/sender who created it; null for system-generated notifications.
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  () => [
    // Content is read through notification_recipients (service-role on the server).
    // Direct client reads are allowed only for notifications the caller received.
    pgPolicy("notifications_select_recipient", {
      for: "select",
      using: sql`EXISTS (
        SELECT 1 FROM notification_recipients nr
        WHERE nr.notification_id = id AND nr.user_id = auth.uid()
      )`,
    }),
  ]
);
