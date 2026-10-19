import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

// Personal access tokens for the staff MCP server (POST /mcp), minted in the
// dashboard (20261019210000_staff_mcp_tokens.sql). Only sha256(token) hex is
// stored. Service-role only: RLS on, no client policies.
export const staffMcpTokens = pgTable(
  "staff_mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    ...timestamps,
  },
  (t) => [index("idx_staff_mcp_tokens_user").on(t.userId)]
).enableRLS();
