import { sql } from "drizzle-orm";
import { index, jsonb, numeric, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { orderStatus, orderType } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

export interface OrderItem {
  name: string;
  quantity: number;
  unit_price: number;
}

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => users.id),
    riderId: uuid("rider_id").references(() => users.id),
    storeName: text("store_name").notNull(),
    storeLogo: text("store_logo"),
    type: orderType("type").notNull(),
    status: orderStatus("status").notNull().default("processing"),
    estimatedTime: text("estimated_time"),
    subtotal: money("subtotal").notNull().default(0),
    deliveryFee: money("delivery_fee").notNull().default(0),
    serviceFee: money("service_fee").notNull().default(0),
    discount: money("discount").notNull().default(0),
    total: money("total").notNull().default(0),
    items: jsonb("items").$type<OrderItem[]>().notNull().default([]),
    pickupAddress: text("pickup_address"),
    destinationAddress: text("destination_address"),
    ...timestamps,
  },
  (t) => [
    index("idx_orders_customer").on(t.customerId),
    index("idx_orders_rider").on(t.riderId),
    index("idx_orders_status").on(t.status),
    pgPolicy("orders_select_own", {
      for: "select",
      using: sql`auth.uid() = customer_id OR auth.uid() = rider_id`,
    }),
  ]
);
