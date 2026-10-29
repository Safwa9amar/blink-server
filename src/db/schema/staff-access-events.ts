import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { staffRole } from "./enums";
import { users } from "./users";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

// Dashboard Access audit trail (20261014200000_staff_access_events.sql).
// Service-role only: RLS on, no client policies.
export const staffAccessEvents = pgTable(
  "staff_access_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    targetId: uuid("target_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    fromRole: staffRole("from_role"),
    toRole: staffRole("to_role"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "staff_access_events_action_check",
      sql`${t.action} in ('created', 'granted', 'role_changed', 'revoked', 'suspended', 'reinstated', 'password_reset', 'password_changed', 'password_recovered', 'mfa_enrolled', 'mfa_removed', 'passkey_added', 'passkey_removed', 'mfa_reset', 'passkeys_reset', 'reset_email_sent')`
    ),
    index("idx_staff_access_events_created").on(t.createdAt.desc()),
    index("idx_staff_access_events_target").on(t.targetId, t.createdAt.desc()),
  ]
).enableRLS();
