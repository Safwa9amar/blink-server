import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { mfaPolicy } from "./_shared";
import { users } from "./users";

export const STAFF_NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type StaffNotificationSeverity = (typeof STAFF_NOTIFICATION_SEVERITIES)[number];

// The dashboard bell / inbox: things staff should hear about (a sign-up, a
// partner uploading documents, a store or product sent for review, a customer
// waiting on support, a fired alert, …). Rows are written ONLY by triggers on
// the source tables, through staff_notify() (migration
// 20261019120000_staff_notifications.sql) — so every write path is covered.
//
// A row is a `kind` + display `params`, not copy: the dashboard renders it in
// en/fr/ar and maps the kind to the page (and so the staff roles) it belongs
// to. `summary` is an English fallback for kinds the dashboard doesn't know.
// Events sharing a `group_key` within an hour fold into one row
// (`occurrences` + 1, `last_at` bumped). Service role only (dashboard server).
export const staffNotifications = pgTable(
  "staff_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // "<area>.<event>", e.g. "rider.documents", "product.review".
    kind: text("kind").notNull(),
    severity: text("severity").$type<StaffNotificationSeverity>().notNull().default("info"),
    // The record it is about (store, rider user, order, conversation, …).
    entityId: uuid("entity_id"),
    params: jsonb("params").$type<Record<string, string | number>>().notNull().default({}),
    summary: text("summary").notNull(),
    groupKey: text("group_key"),
    occurrences: integer("occurrences").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    // Last event folded into the row; drives ordering and unread state.
    lastAt: timestamp("last_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_staff_notifications_last").on(t.lastAt.desc(), t.id.desc()),
    index("idx_staff_notifications_kind").on(t.kind, t.lastAt.desc()),
    index("idx_staff_notifications_group")
      .on(t.groupKey, t.createdAt.desc())
      .where(sql`group_key IS NOT NULL`),
    check("staff_notifications_severity_check", sql`severity IN ('info', 'warning', 'critical')`),
    mfaPolicy("staff_notifications_mfa"),
    pgPolicy("staff_notifications_staff_select", {
      for: "select",
      using: sql`EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);

// Per-staff read marks: read when read_at >= the notification's last_at.
export const staffNotificationReads = pgTable(
  "staff_notification_reads",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => staffNotifications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.notificationId] }),
    pgPolicy("staff_notification_reads_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
  ]
);

// Per-staff "mark all read" watermark: everything up to read_all_at is read.
// No row = the last 7 days count as unread.
export const staffNotificationState = pgTable(
  "staff_notification_state",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    readAllAt: timestamp("read_all_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  () => [pgPolicy("staff_notification_state_select_own", { for: "select", using: sql`auth.uid() = user_id` })]
);
