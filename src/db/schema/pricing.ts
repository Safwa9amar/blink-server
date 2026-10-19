import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Configurable fees (20261018120000_pricing_config.sql). One catalog row per
// key holds the default value; scoped, dated overrides sit on top. Resolution
// rules and the key catalog: src/lib/pricing. RLS is enabled with NO policies —
// only the service role (server + dashboard console) reads or writes these.

export const pricingSettings = pgTable("pricing_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}).enableRLS();

export const pricingOverrides = pgTable(
  "pricing_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key")
      .notNull()
      .references(() => pricingSettings.key),
    // Scope: a null column means "any".
    service: text("service"),
    wilayaCode: text("wilaya_code"),
    merchantId: uuid("merchant_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => users.id, { onDelete: "cascade" }),
    // The FULL value of the fee (never a partial merge).
    value: jsonb("value").$type<unknown>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  (t) => [
    check("pricing_overrides_one_partner", sql`merchant_id is null or agent_id is null`),
    check("pricing_overrides_window", sql`ends_at is null or starts_at is null or ends_at > starts_at`),
    index("idx_pricing_overrides_key").on(t.key).where(sql`archived_at is null`),
  ]
).enableRLS();

export const pricingChanges = pgTable(
  "pricing_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    overrideId: uuid("override_id"),
    action: text("action")
      .$type<"update_default" | "create_override" | "update_override" | "archive_override">()
      .notNull(),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pricing_changes_key").on(t.key, t.createdAt),
    index("idx_pricing_changes_override").on(t.overrideId).where(sql`override_id is not null`),
  ]
).enableRLS();
