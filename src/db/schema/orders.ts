import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { CourierDetails } from "../../lib/courier";
import type { RideDetails } from "../../lib/ride";
import { orderStatus, orderType } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

/** What one pack contains, snapshotted on a pack line when the order was placed. */
export interface OrderPackItem {
  name: string;
  quantity: number;
  /** Free units given on top (buy-X-get-Y). */
  free_qty: number;
}

export interface OrderItem {
  name: string;
  quantity: number;
  unit_price: number;
  /** A pack line: the store_packs id (quantity = number of packs, unit_price = pack price). */
  pack_id?: string;
  /** Server-written on pack lines (src/lib/pack-pricing.ts priceStoreOrder). */
  pack_items?: OrderPackItem[];
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
    // Marketplace store + applied coupon (00032_marketplace.sql). Plain uuids
    // here to avoid an import cycle with marketplace.ts / promotions.ts; the
    // FKs live in the migration.
    storeId: uuid("store_id"),
    couponId: uuid("coupon_id"),
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
    // Courier requests + tracking maps (00034_courier_orders.sql).
    vehicleType: text("vehicle_type"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "string" }),
    pickupLat: doublePrecision("pickup_lat"),
    pickupLng: doublePrecision("pickup_lng"),
    destinationLat: doublePrecision("destination_lat"),
    destinationLng: doublePrecision("destination_lng"),
    // Customer's rating of the store after delivery (00035_merchant.sql);
    // rolls up into stores.rating / review_count.
    // Merchant's handling of a store order, independent of the delivery
    // `status` the rider flow drives: pending → accepted → ready | rejected.
    merchantStatus: text("merchant_status").$type<"pending" | "accepted" | "ready" | "rejected">(),
    storeRating: smallint("store_rating"),
    storeReview: text("store_review"),
    // Merchant flow (00036_merchant_flows.sql). store_driver_id is a plain
    // uuid here (FK in the migration) to avoid an import cycle with merchant.ts.
    merchantRejectReason: text("merchant_reject_reason").$type<
      "too_busy" | "out_of_stock" | "closing_soon" | "cannot_fulfil"
    >(),
    deliveryMode: text("delivery_mode").$type<"blink" | "own">(),
    storeDriverId: uuid("store_driver_id"),
    // `rider`: a ride the passenger never showed up for (20261009230404_ride_details.sql).
    canceledBy: text("canceled_by").$type<"customer" | "merchant" | "system" | "rider">(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    preparedAt: timestamp("prepared_at", { withTimezone: true, mode: "string" }),
    riderAssignedAt: timestamp("rider_assigned_at", { withTimezone: true, mode: "string" }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true, mode: "string" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "string" }),
    storeReviewReply: text("store_review_reply"),
    storeReviewRepliedAt: timestamp("store_review_replied_at", { withTimezone: true, mode: "string" }),
    // Client-generated id shared by the per-store orders of one multi-store
    // checkout (20261006220240_order_checkout_group.sql); null for single orders.
    checkoutId: uuid("checkout_id"),
    // Rider offer handshake (20261007180407_order_rider_offer.sql): a store's
    // pending request to one rider. The order stays `searching` until the
    // rider accepts; rules in src/lib/rider-offer.ts. offered_driver_id is a
    // plain uuid here (FK in the migration), like store_driver_id.
    offeredRiderId: uuid("offered_rider_id").references(() => users.id, { onDelete: "set null" }),
    offeredDriverId: uuid("offered_driver_id"),
    offeredMode: text("offered_mode").$type<"own" | "blink">(),
    offeredAt: timestamp("offered_at", { withTimezone: true, mode: "string" }),
    offerDeclinedAt: timestamp("offer_declined_at", { withTimezone: true, mode: "string" }),
    // Courier requests (20261009230346_courier_details.sql). `courier` holds
    // the parcel, contacts and every drop-off (shape: CourierDetails in
    // src/lib/courier.ts); the flat pickup_* / destination_* columns keep the
    // pickup and the LAST drop-off. One order per route, grouped per request.
    courier: jsonb("courier").$type<CourierDetails>(),
    courierGroupId: uuid("courier_group_id"),
    // Why it was canceled (customer reason key, `no_rider` or
    // `passenger_no_show`) + free text.
    cancelReason: text("cancel_reason"),
    cancelNote: text("cancel_note"),
    // The customer's rating of the rider after delivery.
    riderRating: smallint("rider_rating"),
    riderReview: text("rider_review"),
    riderTags: text("rider_tags").array(),
    // Rides (20261009230404_ride_details.sql): pickup + note, destination,
    // the passenger when it isn't the customer, the estimate, the female-rider
    // wish and when the rider arrived (shape: RideDetails in src/lib/ride.ts).
    // The flat pickup_* / destination_* columns mirror the two points.
    ride: jsonb("ride").$type<RideDetails>(),
    // Road driven while carrying the order: [lat, lng] pairs, oldest first,
    // appended from rider location pings (20261011103926_route_path.sql).
    // Null until picked up.
    routePath: jsonb("route_path").$type<[number, number][]>(),
    // Rates in force when a store order was created (20261018120000_pricing_config.sql):
    // dues = Σ(sale × this order's rate), so editing a rate never rewrites the
    // past. pricing_applied = { [pricing key]: override id | null } for every
    // key used to price the order.
    merchantCommissionRate: numeric("merchant_commission_rate", { precision: 6, scale: 4 }).$type<number>(),
    stampDutyRate: numeric("stamp_duty_rate", { precision: 6, scale: 4 }).$type<number>(),
    pricingApplied: jsonb("pricing_applied").$type<Record<string, string | null>>(),
    ...timestamps,
  },
  (t) => [
    index("idx_orders_customer").on(t.customerId),
    index("idx_orders_customer_checkout").on(t.customerId, t.checkoutId),
    // 20261007130816_orders_checkout_index.sql
    index("idx_orders_checkout").on(t.checkoutId).where(sql`checkout_id is not null`),
    // 20261007180407_order_rider_offer.sql
    index("idx_orders_offered_rider").on(t.offeredRiderId).where(sql`offered_rider_id is not null`),
    // 20261009230346_courier_details.sql
    index("idx_orders_courier_group").on(t.courierGroupId).where(sql`courier_group_id is not null`),
    index("idx_orders_courier_searching")
      .on(t.createdAt)
      .where(sql`type = 'courier' and status = 'searching' and rider_id is null`),
    // 20261009230404_ride_details.sql
    index("idx_orders_ride_searching")
      .on(t.createdAt)
      .where(sql`type = 'ride' and status = 'searching' and rider_id is null`),
    index("idx_orders_rider").on(t.riderId),
    index("idx_orders_status").on(t.status),
    pgPolicy("orders_select_own", {
      for: "select",
      using: sql`auth.uid() = customer_id OR auth.uid() = rider_id`,
    }),
  ]
);
