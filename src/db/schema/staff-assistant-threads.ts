import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Private per-staff chat threads for the dashboard AI assistant
// (20261019220000_staff_assistant.sql). Service-role only: RLS on, no policies.
export const staffAssistantThreads = pgTable(
  "staff_assistant_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    ...timestamps,
  },
  (t) => [index("idx_staff_assistant_threads_user").on(t.userId, t.updatedAt.desc())]
).enableRLS();
