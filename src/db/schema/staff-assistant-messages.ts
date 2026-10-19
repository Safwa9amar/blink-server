import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { staffAssistantThreads } from "./staff-assistant-threads";

// Messages of a staff assistant thread (20261019220000_staff_assistant.sql).
// role 'tool' rows hold tool results; assistant rows that requested tools carry
// tool_calls = [{ id, name, arguments }]. Service-role only: RLS on, no policies.
export const staffAssistantMessages = pgTable(
  "staff_assistant_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => staffAssistantThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant' | 'tool'
    content: text("content").notNull().default(""),
    toolCalls: jsonb("tool_calls").$type<{ id: string; name: string; arguments: string }[]>(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolOk: boolean("tool_ok"),
    rowCount: integer("row_count"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [index("idx_staff_assistant_messages_thread").on(t.threadId, t.id)]
).enableRLS();
