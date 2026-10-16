import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { transactionStatus } from "./enums";
import { timestamps } from "./_shared";
import { stores } from "./marketplace";
import { users } from "./users";

// Merchant-side tables: product packs (bundles) and Blink Cash dues payments.
// Mirrors the app's Bundle (blink/store/merchant/packs-store.ts) and
// DuesTransaction (blink-cash-store.ts). Writes go through blink-server with
// the service role — 00035_merchant.sql.

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

export const packStatus = pgEnum("pack_status", ["active", "under_review", "inactive", "archived"]);

export interface PackItem {
  product_id: string;
  quantity: number;
  qty_promo_enabled: boolean;
  buy_qty: number;
  get_qty: number;
}

export const storePacks = pgTable(
  "store_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    image: text("image"),
    items: jsonb("items").$type<PackItem[]>().notNull().default([]),
    discountEnabled: boolean("discount_enabled").notNull().default(false),
    discountPercent: integer("discount_percent").notNull().default(0),
    freeDelivery: boolean("free_delivery").notNull().default(false),
    status: packStatus("status").notNull().default("active"),
    // Staff review of free-delivery packs (20261010130645_merchant_catalog_review.sql):
    // a free-delivery pack may only be live while `reviewed_at` is set; a
    // material edit clears it (src/lib/pack-review.ts). `review_note` = why
    // staff rejected / deactivated it.
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  (t) => [
    index("idx_store_packs_store").on(t.storeId),
    pgPolicy("store_packs_select_all", {
      for: "select",
      using: sql`auth.role() = 'authenticated'`,
    }),
  ]
);

// A merchant settling the commission ("dues") Blink takes on a store's sales.
// Outstanding dues = commission on delivered orders − completed payments.
export const merchantDuesPayments = pgTable(
  "merchant_dues_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    amount: money("amount").notNull(),
    fees: money("fees").notNull().default(0),
    method: text("method").notNull(),
    status: transactionStatus("status").notNull().default("completed"),
    // Staff trail (20261016120000_blink_cash_full.sql).
    reference: text("reference"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    rejectedReason: text("rejected_reason"),
    ...timestamps,
  },
  (t) => [
    index("idx_merchant_dues_merchant").on(t.merchantId),
    index("idx_merchant_dues_store").on(t.storeId),
    pgPolicy("merchant_dues_select_own", {
      for: "select",
      using: sql`auth.uid() = merchant_id`,
    }),
  ]
);

// ─── Store drivers (00036_merchant_flows.sql) ────────────────────────
// A merchant's own riders: invited Blink riders (kind=blink, active once the
// rider accepts) and external drivers managed off-platform (kind=external).
export const storeDrivers = pgTable(
  "store_drivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"blink" | "external">(),
    riderUserId: uuid("rider_user_id").references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    vehicleType: text("vehicle_type"),
    plateNumber: text("plate_number"),
    notes: text("notes"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"invited" | "active" | "inactive" | "declined">(),
    ...timestamps,
  },
  (t) => [
    index("idx_store_drivers_store").on(t.storeId),
    index("idx_store_drivers_rider").on(t.riderUserId),
    pgPolicy("store_drivers_select_rider", {
      for: "select",
      using: sql`auth.uid() = rider_user_id`,
    }),
  ]
);

// ─── Strategy: saved suggestions + Blink AI chat ─────────────────────
export const merchantSuggestions = pgTable(
  "merchant_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("chat").$type<"chat" | "system">(),
    kind: text("kind").notNull().default("general"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("new").$type<"new" | "applied" | "dismissed">(),
    ...timestamps,
  },
  (t) => [
    index("idx_merchant_suggestions_merchant").on(t.merchantId),
    pgPolicy("merchant_suggestions_select_own", {
      for: "select",
      using: sql`auth.uid() = merchant_id`,
    }),
  ]
);

export const merchantAiMessages = pgTable(
  "merchant_ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<"user" | "assistant">(),
    content: text("content").notNull(),
    suggestionId: uuid("suggestion_id").references(() => merchantSuggestions.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("idx_merchant_ai_messages_merchant").on(t.merchantId, t.createdAt),
    pgPolicy("merchant_ai_messages_select_own", {
      for: "select",
      using: sql`auth.uid() = merchant_id`,
    }),
  ]
);
