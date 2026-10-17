import { sql } from "drizzle-orm";
import { check, index, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userRole } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

// In-app "delete my account" requests (20261006230012_account_deletion_requests.sql).
// The app files a request (POST /auth/account/deletion-request) and signs the
// user out; staff complete it — so financial records (transactions, dues) are
// never lost to a self-service hard delete. Completing wipes the user's personal
// data, so the request keeps who it was (`user_snapshot`) and which staff member
// processed it — the console's deletion history.
//
// `scope`: `account` deletes the whole account; `role` removes only `role`
// from a multi-role account (staff take it off granted_roles and clear its
// documents; the other roles stay). 20261011134918_signup_role_and_role_deletion.sql.

/** Who the account belonged to, captured just before staff wiped it. */
export interface DeletedUserSnapshot {
  name: string | null;
  phone_number: string | null;
  email: string | null;
}
export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
    scope: text("scope").$type<"account" | "role">().notNull().default("account"),
    reason: text("reason"),
    feedback: text("feedback"),
    status: text("status")
      .$type<"pending" | "completed" | "cancelled">()
      .notNull()
      .default("pending"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
    // Staff member who completed or cancelled it.
    processedBy: uuid("processed_by").references(() => users.id, { onDelete: "set null" }),
    userSnapshot: jsonb("user_snapshot").$type<DeletedUserSnapshot>(),
    ...timestamps,
  },
  (t) => [
    index("idx_account_deletion_requests_user").on(t.userId),
    // One pending request per user and role.
    uniqueIndex("account_deletion_requests_one_pending")
      .on(t.userId, t.role)
      .where(sql`status = 'pending'`),
    check("account_deletion_requests_scope_check", sql`scope in ('account', 'role')`),
    index("idx_account_deletion_requests_status").on(t.status),
    pgPolicy("account_deletion_requests_select_own", {
      for: "select",
      using: sql`auth.uid() = user_id`,
    }),
  ]
);
