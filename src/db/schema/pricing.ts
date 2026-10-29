import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";
import type { ZoneGeometry } from "../../lib/geo/zones";

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

// Zone pricing (20261029120000_zone_pricing.sql): tiers classify places
// (urban / town / rural, staff can add more); zones are polygons drawn on the
// dashboard map, each with a tier. Points outside every zone take the
// `zone_defaults` unzoned tier. Spec: specs/2026-10-29-zone-pricing-design.md.
export const pricingTiers = pgTable(
  "pricing_tiers",
  {
    code: text("code").primaryKey(),
    names: jsonb("names").$type<{ en: string; fr: string; ar: string }>().notNull(),
    color: text("color").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  () => [
    check("pricing_tiers_code", sql`code ~ '^[a-z][a-z0-9_]{1,23}$'`),
    check("pricing_tiers_color", sql`color ~ '^#[0-9A-Fa-f]{6}$'`),
  ]
).enableRLS();

export const pricingZones = pgTable(
  "pricing_zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tier: text("tier")
      .notNull()
      .references(() => pricingTiers.code),
    wilayaCode: text("wilaya_code"),
    // GeoJSON Polygon | MultiPolygon, [lng, lat]; validated server-side.
    geometry: jsonb("geometry").$type<ZoneGeometry>().notNull(),
    priority: integer("priority").notNull().default(0),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  (t) => [
    check("pricing_zones_name", sql`char_length(name) between 1 and 80`),
    index("idx_pricing_zones_live").on(t.tier).where(sql`archived_at is null`),
  ]
).enableRLS();

// Vehicle classes (20261029180000_vehicle_classes.sql): staff-defined products
// (Bicycle / Moto / Moto Comfort …) that fares are priced and jobs matched by.
// Spec: specs/2026-10-29-zone-pricing-design.md, Addendum 2.
export const vehicleClasses = pgTable(
  "vehicle_classes",
  {
    code: text("code").primaryKey(),
    names: jsonb("names").$type<{ en: string; fr: string; ar: string }>().notNull(),
    // = rider_profiles.vehicle_type of the riders who can take it.
    baseVehicle: text("base_vehicle").$type<"bicycle" | "motorcycle">().notNull(),
    services: text("services").array().$type<("ride" | "courier" | "store")[]>().notNull(),
    exclusive: boolean("exclusive").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  () => [
    check("vehicle_classes_code", sql`code ~ '^[a-z][a-z0-9_]{1,23}$'`),
    check("vehicle_classes_base", sql`base_vehicle in ('bicycle', 'motorcycle')`),
    check("vehicle_classes_services", sql`services <@ array['ride', 'courier', 'store']::text[]`),
  ]
).enableRLS();

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
    // Zone pricing: a drawn zone, or a tier (a zone implies its wilaya + tier).
    zoneId: uuid("zone_id").references(() => pricingZones.id),
    tier: text("tier").references(() => pricingTiers.code),
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
    check("pricing_overrides_zone_scope", sql`zone_id is null or (tier is null and wilaya_code is null)`),
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
    // Zone / tier writes: key = 'pricing_zone' | 'pricing_tier'.
    zoneId: uuid("zone_id"),
    tier: text("tier"),
    // Vehicle class writes: key = 'vehicle_class'.
    vehicleClass: text("vehicle_class"),
    action: text("action")
      .$type<
        | "update_default"
        | "create_override"
        | "update_override"
        | "archive_override"
        | "create_zone"
        | "update_zone"
        | "archive_zone"
        | "create_tier"
        | "update_tier"
        | "archive_tier"
        | "create_vehicle_class"
        | "update_vehicle_class"
        | "archive_vehicle_class"
      >()
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
