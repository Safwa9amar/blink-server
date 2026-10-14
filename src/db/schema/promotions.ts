import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { stores } from "./marketplace";
import { users } from "./users";

// Promotions power two customer surfaces: the Promos tab (kind = promo) and
// Top Deals (kind = deal). Activating / claiming one — or redeeming its code —
// issues a per-customer coupon that checkout applies server-side
// (POST /orders `coupon_code`). 00032_marketplace.sql.

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const promotionKind = pgEnum("promotion_kind", ["promo", "deal"]);
// activate/claim → issues a coupon; copy → shows `code`; view → opens the store.
export const promotionAction = pgEnum("promotion_action", ["activate", "copy", "claim", "view"]);
export const discountType = pgEnum("discount_type", ["percent", "fixed", "free_delivery"]);

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: promotionKind("kind").notNull().default("promo"),
    // Promos tab chip: RIDES | FOOD | SUPERMARKET | MARKET | COSMETICS | PARCELS.
    category: text("category").notNull().default("MARKET"),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull().default(""),
    imageUrl: text("image_url").notNull().default(""),
    code: text("code"),
    action: promotionAction("action").notNull().default("activate"),
    // Deal-card presentation.
    badgeText: text("badge_text"),
    badgeColor: text("badge_color"),
    valueText: text("value_text"),
    infoText: text("info_text"),
    infoIcon: text("info_icon"),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    // What the issued coupon is worth.
    discountType: discountType("discount_type").notNull().default("percent"),
    discountValue: money("discount_value").notNull().default(0),
    minOrder: money("min_order").notNull().default(0),
    maxDiscount: money("max_discount"),
    // Coupon validity in days from issue (falls back to ends_at).
    validDays: integer("valid_days").notNull().default(30),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    // Spend caps: stop issuing after N coupons / once this many DZD were
    // given (null = unlimited). Archived promotions are hidden everywhere.
    maxCoupons: integer("max_coupons"),
    discountBudget: money("discount_budget"),
    archivedAt: ts("archived_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    check("promotions_max_coupons_positive", sql`${t.maxCoupons} is null or ${t.maxCoupons} > 0`),
    check("promotions_discount_budget_positive", sql`${t.discountBudget} is null or ${t.discountBudget} > 0`),
    index("idx_promotions_kind").on(t.kind),
    index("idx_promotions_code").on(t.code),
    pgPolicy("promotions_select_all", {
      for: "select",
      using: sql`auth.role() = 'authenticated'`,
    }),
  ]
);

export const customerCoupons = pgTable(
  "customer_coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    promotionId: uuid("promotion_id").references(() => promotions.id, { onDelete: "set null" }),
    code: text("code").notNull(),
    // CouponCard art: market | food | cosmetics | parcels | rides | others.
    type: text("type").notNull().default("others"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    discountType: discountType("discount_type").notNull(),
    discountValue: money("discount_value").notNull().default(0),
    minOrder: money("min_order").notNull().default(0),
    maxDiscount: money("max_discount"),
    imageUrl: text("image_url"),
    expiresAt: ts("expires_at"),
    usedAt: ts("used_at"),
    orderId: uuid("order_id"),
    // Staff revoked it: checkout refuses it.
    revokedAt: ts("revoked_at"),
    // promotion | referral | staff.
    source: text("source").notNull().default("promotion"),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    check("customer_coupons_source_check", sql`${t.source} in ('promotion', 'referral', 'staff')`),
    unique("customer_coupons_user_promotion_key").on(t.userId, t.promotionId),
    index("idx_customer_coupons_user").on(t.userId),
    pgPolicy("customer_coupons_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
  ]
);

// App views/taps on promotions (POST /promotions/events). RLS on with no
// client policies: only the server writes, the dashboard reads (service role).
export const promotionEvents = pgTable(
  "promotion_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => promotions.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    event: text("event").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("promotion_events_event_check", sql`${t.event} in ('view', 'tap')`),
    index("idx_promotion_events_promo_event_created").on(t.promotionId, t.event, t.createdAt),
  ]
).enableRLS();
