import { z } from "@hono/zod-openapi";

/** The assigned rider as the customer sees them (src/lib/rider-card.ts). */
export const RiderCardSchema = z
  .object({
    id: z.string(),
    /** Human-readable rider id, e.g. "BK-RR-100001". */
    display_id: z.string().nullable(),
    name: z.string().nullable(),
    avatar: z.string().nullable(),
    /** bicycle | motorcycle */
    vehicle_type: z.string().nullable(),
    vehicle_color: z.string().nullable(),
    plate: z.string().nullable(),
    /** Orders this rider delivered. */
    deliveries: z.number().int(),
    /** Average of customers' ratings (1-5); null when unrated. */
    rating: z.number().nullable(),
    /** Only while the delivery is under way. */
    phone: z.string().nullable(),
    /** Last known position, only while the rider is driving this delivery. */
    location: z
      .object({ lat: z.number(), lng: z.number(), updated_at: z.string().nullable() })
      .nullable(),
  })
  .openapi("RiderCard");

/** A trip's fare split, from the order it was made for. */
export const TripCostsSchema = z
  .object({
    delivery_fee: z.number(),
    service_fee: z.number(),
    discount: z.number(),
    total: z.number(),
  })
  .openapi("TripCosts");

/** The store card on a customer's order. */
export const OrderStoreInfoSchema = z
  .object({ description: z.string().nullable(), rating: z.number().nullable() })
  .openapi("OrderStoreInfo");
