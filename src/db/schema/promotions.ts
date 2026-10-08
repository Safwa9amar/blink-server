import { sql } from "drizzle-orm";
import {
  boolean,
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
    ...timestamps,
  },
  (t) => [
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
    ...timestamps,
  },
  (t) => [
    unique("customer_coupons_user_promotion_key").on(t.userId, t.promotionId),
    index("idx_customer_coupons_user").on(t.userId),
    pgPolicy("customer_coupons_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
  ]
);
