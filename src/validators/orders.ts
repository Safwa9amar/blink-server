import { z } from "@hono/zod-openapi";
import { orders } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";
import { COURIER_PAYERS, PARCEL_SIZES, PARCEL_TYPES } from "../lib/courier";
import { OrderStoreInfoSchema, RiderCardSchema } from "./rider-card";

const orderStatus = z.enum([
  "searching",
  "heading_to_store",
  "preparation",
  "pickup",
  "on_the_way",
  "delivered",
  "canceled",
  "merchant_rejected",
  "processing",
]);

const orderItemFields = {
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  pack_id: z.string().uuid().optional().openapi({
    description:
      "A pack line (merchant orders): the pack's id from GET /marketplace/stores/{id}/packs, with quantity = number of packs and unit_price = the pack's price. The server re-prices it (409 pack_changed when the pack is gone or its price differs) and stores the pack name as `name`.",
  }),
};

const orderItemSchema = z.object(orderItemFields).openapi("OrderItem");

/** What one pack contains, snapshotted on the order line when it was placed. */
const OrderPackItemSchema = z
  .object({
    name: z.string(),
    quantity: z.number().int(),
    /** Free units given on top (buy-X-get-Y). */
    free_qty: z.number().int(),
  })
  .openapi("OrderPackItem");

/** An order's stored line: the request line plus, for a pack, its contents. */
const OrderLineSchema = z
  .object({
    ...orderItemFields,
    pack_items: z.array(OrderPackItemSchema).optional().openapi({
      description: "Server-written on pack lines: the pack's contents when the order was placed, for the store to prepare",
    }),
  })
  .openapi("OrderLine");

/**
 * 409 of POST /orders: `code: pack_changed` — a pack line's pack (`pack_id`)
 * is no longer sold (deactivated, deleted, a product unavailable) or its
 * price changed. Refetch the store's packs, fix the cart and retry.
 */
export const PackChangedError = z
  .object({
    error: z.string(),
    code: z.enum(["pack_changed"]),
    pack_id: z.string(),
  })
  .openapi("PackChangedError");

export const createOrderSchema = z
  .object({
    store_name: z.string().min(1),
    store_logo: z.string().url().optional(),
    /** No `ride`: rides are created priced, only through POST /ride/requests. */
    type: z.enum(["merchant", "shopper", "courier"]),
    items: z.array(orderItemSchema).min(1),
    subtotal: z.number().nonnegative(),
    delivery_fee: z.number().nonnegative(),
    service_fee: z.number().nonnegative(),
    discount: z.number().nonnegative().default(0),
    /** Marketplace store the order is placed with. Required for `merchant` orders. */
    store_id: z.string().uuid().optional(),
    /**
     * Client-generated id shared by every per-store order of one multi-store
     * checkout; list the siblings with `GET /orders?checkout_id=…`.
     */
    checkout_id: z.string().uuid().optional(),
    /** Customer coupon code — priced server-side; overrides `discount`. */
    coupon_code: z.string().trim().min(1).optional(),
    pickup_address: z.string().optional(),
    destination_address: z.string().optional(),
    pickup_lat: z.number().optional(),
    pickup_lng: z.number().optional(),
    destination_lat: z.number().optional(),
    destination_lng: z.number().optional(),
    /** Courier: requested vehicle (e.g. "bike", "car"). */
    vehicle_type: z.string().optional(),
    /** Courier: scheduled pickup time; omit for "now". */
    scheduled_at: z.string().datetime({ offset: true }).optional(),
  })
  .openapi("CreateOrderBody");

export const updateOrderStatusSchema = z
  .object({
    status: orderStatus,
    estimated_time: z.string().optional(),
    /**
     * Always refused (400, staff included): a rider is assigned only by
     * accepting the job (POST /riders/jobs/{id}/accept). Kept so an old
     * client gets an error instead of a status change with the rider dropped.
     */
    rider_id: z.string().uuid().optional(),
    /**
     * Customer cancel: reason key picked in the app (e.g. "changed_mind"; rides:
     * rider_asked | changed_mind | accidental | waiting_too_long | other).
     */
    cancel_reason: z.string().trim().min(1).max(64).optional(),
    /** Customer cancel: free-text details. */
    cancel_note: z.string().trim().max(500).optional(),
  })
  .openapi("UpdateOrderStatusBody");

export const listOrdersSchema = z.object({
  status: orderStatus.optional(),
  /** Only the caller's orders created by this multi-store checkout. */
  checkout_id: z.string().uuid().optional(),
  /** Only the caller's orders created by this courier request (one per route). */
  courier_group_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export const rateRiderSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    review: z.string().trim().max(1000).optional(),
    /** Compliment keys picked on the rating screen (e.g. "fast", "polite"). */
    tags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  })
  .openapi("RateRiderBody");

// ─── Response schemas ────────────────────────────────────────────────

const courierPoint = { label: z.string(), address: z.string(), lat: z.number(), lng: z.number() };

/** `orders.courier` (src/lib/courier.ts CourierDetails). */
export const CourierDetailsSchema = z.object({
  pickup: z
    .object({
      ...courierPoint,
      contact_name: z.string().nullable(),
      contact_phone: z.string().nullable(),
      note: z.string().nullable(),
    })
    .openapi("CourierPickup"),
  drop_offs: z.array(
    z
      .object({
        ...courierPoint,
        recipient_name: z.string(),
        recipient_phone: z.string(),
        note: z.string().nullable(),
        /** Set when the rider confirmed delivery at this drop-off. */
        delivered_at: z.string().nullable(),
      })
      .openapi("CourierDropOff")
  ),
  parcel: z
    .object({
      type: z.enum(PARCEL_TYPES),
      size: z.enum(PARCEL_SIZES),
      note: z.string().nullable(),
    })
    .openapi("CourierParcel"),
  paid_by: z.enum(COURIER_PAYERS),
  distance_km: z.number(),
});

const ridePoint = { label: z.string(), address: z.string(), lat: z.number(), lng: z.number() };

/** `orders.ride` (src/lib/ride.ts RideDetails). */
export const RideDetailsSchema = z.object({
  pickup: z
    .object({
      ...ridePoint,
      /** For the rider: where exactly to wait. */
      note: z.string().nullable(),
    })
    .openapi("RidePickup"),
  destination: z.object(ridePoint).openapi("RideDestination"),
  /** Someone else rides (the rider calls them); null = the customer rides. Inline: see OrderSchema. */
  passenger: z.object({ name: z.string(), phone: z.string() }).nullable(),
  /** Estimated road km. */
  distance_km: z.number(),
  /** Pickup → destination estimate. */
  duration_minutes: z.number().int(),
  /** Only a female rider may take it. */
  female_rider_only: z.boolean(),
  /** When the rider reached the pickup (status `pickup`); null before. */
  arrived_at: z.string().nullable(),
});

export const OrderSchema = rowSchema(orders, "OrderRow", {
  // Inline + nullable: OpenAPI 3.0 drops `nullable` beside a $ref.
  courier: CourierDetailsSchema.nullable(),
  ride: RideDetailsSchema.nullable(),
  rider_tags: z.array(z.string()).nullable(),
  route_path: z
    .array(z.tuple([z.number(), z.number()]))
    .nullable()
    .openapi({
      description:
        "Road driven while carrying the order: [lat, lng] pairs, oldest first. Null until picked up.",
    }),
})
  .extend({
    items: z.array(OrderLineSchema),
    // For the order's customer only (omitted otherwise).
    rider: RiderCardSchema.optional(),
    store_info: OrderStoreInfoSchema.optional(),
  })
  .openapi("Order");

export const OrderResponse = z.object({ order: OrderSchema }).openapi("OrderResponse");
export const OrderListResponse = z
  .object({ orders: z.array(OrderSchema), pagination: PaginationSchema })
  .openapi("OrderListResponse");
