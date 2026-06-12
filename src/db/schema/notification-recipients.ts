import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notifications } from "./notifications";
import { users } from "./users";

// Per-user delivery + state for a notification. A notification's CONTENT lives
// once in `notifications`; this junction records each user who received it and
// their own read/archive state — so a broadcast is 1 content row + N small rows
// here, and one user's actions never touch another's. Deleting a user cascades
// only their recipient rows; the notification content survives for everyone else.
//
// "Delete" in the app is an ARCHIVE: it sets `archived_at` (never a row delete),
// so the notification is preserved and can be viewed in the archive / restored.
//
// No `updated_at` — state changes are explicit UPDATEs and there's no trigger.
export const notificationRecipients = pgTable(
  "notification_recipients",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isUnread: boolean("is_unread").notNull().default(true),
    // Per-user archive marker. NULL = in the active feed; set = archived (the
    // app's "delete"). Reads filter on it; restore clears it.
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.userId] }),
    // Feed reads are per-user, split by active vs archived.
    index("idx_notification_recipients_user").on(t.userId, t.archivedAt),
    // Unread-badge count: per-user, only the unread rows.
    index("idx_notification_recipients_unread")
      .on(t.userId)
      .where(sql`is_unread = true`),
    pgPolicy("notification_recipients_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
    pgPolicy("notification_recipients_update_own", { for: "update", using: sql`auth.uid() = user_id` }),
  ]
);
