import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRole } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

// In-app "delete my account" requests (20261006230012_account_deletion_requests.sql).
// The app files a request (POST /auth/account/deletion-request) and signs the
// user out; staff complete it — so financial records (transactions, dues) are
// never lost to a self-service hard delete.
export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
    reason: text("reason"),
    feedback: text("feedback"),
    status: text("status")
      .$type<"pending" | "completed" | "cancelled">()
      .notNull()
      .default("pending"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  (t) => [
    index("idx_account_deletion_requests_user").on(t.userId),
    index("idx_account_deletion_requests_status").on(t.status),
    pgPolicy("account_deletion_requests_select_own", {
      for: "select",
      using: sql`auth.uid() = user_id`,
    }),
  ]
);
