import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRole } from "./enums";
import { users } from "./users";

// Canned replies for the dashboard inbox. Service-role only (RLS on, no
// policies). `locale` null = any language; `target_role` null = any role.
export const supportMacros = pgTable("support_macros", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  locale: text("locale"),
  targetRole: userRole("target_role"),
  uses: integer("uses").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// SLA targets per ticket priority (low|normal|high|urgent). Service-role only.
export const supportSlaPolicies = pgTable("support_sla_policies", {
  priority: text("priority").primaryKey(),
  firstResponseMinutes: integer("first_response_minutes").notNull(),
  resolutionMinutes: integer("resolution_minutes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});
