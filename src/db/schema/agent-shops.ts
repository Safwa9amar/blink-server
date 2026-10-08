import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentShopStatus } from "./enums";
import { timestamps } from "./_shared";
import type { StoreDocuments, StoreWeekHours } from "./marketplace";
import { users } from "./users";

// An agent's cash-in/cash-out kiosks. An agent can run several shops
// (20261006230006_agent_backend.sql dropped the one-shop-per-agent constraint); exactly
// one is `is_primary` — the shop the legacy /agents/shop endpoints and
// /auth/profile resolve to. `status` is the open/closed toggle riders see in
// /agents/nearby; `review_status` is staff verification of a new shop.
export const agentShops = pgTable(
  "agent_shops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopName: text("shop_name").notNull(),
    phoneNumber: text("phone_number"),
    email: text("email"),
    description: text("description"),
    shopImageUrl: text("shop_image_url"),
    openTime: time("open_time").notNull().default("08:00"),
    closeTime: time("close_time").notNull().default("20:00"),
    status: agentShopStatus("status").notNull().default("closed"),
    latitude: doublePrecision("latitude").notNull().default(0),
    longitude: doublePrecision("longitude").notNull().default(0),
    address: text("address"),
    rating: numeric("rating", { precision: 2, scale: 1 }).$type<number>().notNull().default(0),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Weekly opening hours keyed by day (sat..fri) — same shape as stores.hours. */
    hours: jsonb("hours").$type<StoreWeekHours>(),
    /** Verification documents — same shape as stores.documents. */
    documents: jsonb("documents").$type<StoreDocuments>().notNull().default({}),
    /** Agent forced open/closed outside the weekly schedule. */
    manualOverride: boolean("manual_override").notNull().default(false),
    reviewStatus: text("review_status")
      .$type<"under_review" | "active" | "rejected">()
      .notNull()
      .default("under_review"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("agent_shops_one_primary")
      .on(t.userId)
      .where(sql`is_primary`),
    index("idx_agent_shops_user").on(t.userId),
    index("idx_agent_shops_status").on(t.status),
    index("idx_agent_shops_location").on(t.latitude, t.longitude),
    pgPolicy("agent_shops_select_all", { for: "select", using: sql`true` }),
    pgPolicy("agent_shops_update_own", { for: "update", using: sql`auth.uid() = user_id` }),
  ]
);
