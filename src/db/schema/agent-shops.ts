import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  numeric,
  pgPolicy,
  pgTable,
  text,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentShopStatus } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

export const agentShops = pgTable(
  "agent_shops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopName: text("shop_name").notNull(),
    phoneNumber: text("phone_number"),
    shopImageUrl: text("shop_image_url"),
    openTime: time("open_time").notNull().default("08:00"),
    closeTime: time("close_time").notNull().default("20:00"),
    status: agentShopStatus("status").notNull().default("closed"),
    latitude: doublePrecision("latitude").notNull().default(0),
    longitude: doublePrecision("longitude").notNull().default(0),
    address: text("address"),
    rating: numeric("rating", { precision: 2, scale: 1 }).$type<number>().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("agent_shops_user_id_key").on(t.userId),
    index("idx_agent_shops_user").on(t.userId),
    index("idx_agent_shops_status").on(t.status),
    index("idx_agent_shops_location").on(t.latitude, t.longitude),
    pgPolicy("agent_shops_select_all", { for: "select", using: sql`true` }),
    pgPolicy("agent_shops_update_own", { for: "update", using: sql`auth.uid() = user_id` }),
  ]
);
