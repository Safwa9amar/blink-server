import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { staffMcpTokens } from "./staff-mcp-tokens";

// One row per staff MCP tool call (20261019210000_staff_mcp_tokens.sql).
// Service-role only: RLS on, no client policies.
export const staffMcpAudit = pgTable(
  "staff_mcp_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tokenId: uuid("token_id").references(() => staffMcpTokens.id, { onDelete: "set null" }),
    userId: uuid("user_id"),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    source: text("source").notNull().default("mcp"), // 'mcp' | 'assistant'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_staff_mcp_audit_created").on(t.createdAt.desc()),
    index("idx_staff_mcp_audit_user").on(t.userId),
  ]
).enableRLS();
