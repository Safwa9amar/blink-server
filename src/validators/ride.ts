import { z } from "@hono/zod-openapi";
import { NO_RIDER_REASON } from "../lib/courier";
import { PASSENGER_NO_SHOW_REASON, RIDE_CUSTOMER_CANCEL_REASONS } from "../lib/ride";
import { RIDE_VEHICLES } from "../lib/ride-pricing";
import { couponCode, lat, lng, nearbyRidersMap, phone } from "./courier";
import { OrderSchema } from "./orders";

// ─── Ride requests (/ride/*) ─────────────────────────────────────────
// A ride = one order for one rider: a pickup, then a destination, motorcycle
// only. Rules: src/lib/ride.ts, pricing: src/lib/ride-pricing.ts. Spec:
// blink/docs/superpowers/specs/2026-10-09-ride-requests-design.md
//
// Cancel reasons (orders.cancel_reason, free-form text; the known keys):
// - customer, PATCH /orders/{id}/status: rider_asked | changed_mind |
//   accidental | waiting_too_long | other (+ cancel_note);
// - rider at the pickup, POST /riders/jobs/{id}/cancel: passenger_no_show;
// - system, search window ran out: no_rider.
export const RIDE_CANCEL_REASONS = [
  ...RIDE_CUSTOMER_CANCEL_REASONS,
  PASSENGER_NO_SHOW_REASON,
  NO_RIDER_REASON,
] as const;

const vehicle = z.enum(RIDE_VEHICLES as [string, ...string[]]);

const RideLatLngSchema = z.object({ lat, lng }).openapi("RideLatLng");

const PointInput = {
  /** Place name ("Grande Poste"); the address is used when empty. */
  label: z.string().trim().max(200).default(""),
  address: z.string().trim().min(1).max(300),
  lat,
  lng,
};

const RidePickupInputSchema = z
  .object({
    ...PointInput,
    /** For the rider: where exactly to wait. */
    note: z.string().trim().max(300).nullable().optional(),
  })
  .openapi("RidePickupInput");

const RideDestinationInputSchema = z.object(PointInput).openapi("RideDestinationInput");

/** Only a female rider (users.gender = 'female') may take it. Free, subject to availability. */
const femaleRiderOnly = z.boolean().default(false);

export const rideQuoteSchema = z
  .object({
    pickup: RideLatLngSchema,
    destination: RideLatLngSchema,
    /** Priced against the fare; reported in `coupon`. */
    coupon_code: couponCode,
    /** Count (nearby_riders, ETA, availability) female riders only. */
    female_rider_only: femaleRiderOnly,
  })
  .openapi("RideQuoteBody");

export const createRideRequestSchema = z
  .object({
    pickup: RidePickupInputSchema,
    destination: RideDestinationInputSchema,
    /**
     * Someone else rides: the rider calls them. Omit / null = the customer
     * rides. Inline (no $ref) so `nullable` survives OpenAPI 3.0.
     */
    passenger: z
      .object({ name: z.string().trim().min(1).max(100), phone })
      .nullable()
      .optional(),
    vehicle_type: vehicle.default("motorcycle"),
    /** Pickup time for a scheduled ride (10 min – 7 days ahead); omit for "now". */
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    /** Applied to the fare. */
    coupon_code: couponCode,
    female_rider_only: femaleRiderOnly,
  })
  .openapi("CreateRideRequestBody");

// ─── Responses ───────────────────────────────────────────────────────

export const RideQuoteOptionSchema = z
  .object({
    vehicle_type: vehicle,
    /** Fare before the coupon. */
    fare: z.number(),
    discount: z.number(),
    /** fare − discount: what the passenger pays the rider in cash. */
    total: z.number(),
    /** Pickup → destination. */
    duration_minutes: z.number().int(),
    /**
     * false when the trip is too short / too long, or (female_rider_only) no
     * female rider is near the pickup — see unavailable_reason.
     */
    available: z.boolean(),
    unavailable_reason: z.enum(["too_close", "too_far", "no_female_rider"]).nullable(),
    /** Nearest free rider who can take it → pickup; null when none is known. */
    pickup_eta_minutes: z.number().int().nullable(),
    /** Free riders near the pickup who can take it. */
    nearby_riders: z.number().int(),
  })
  .openapi("RideQuoteOption");

export const RideQuoteResponse = z
  .object({
    /** Estimated road km, pickup → destination. */
    distance_km: z.number(),
    options: z.array(RideQuoteOptionSchema),
    /**
     * Free riders near the pickup who can take this ride (motorcycle; female
     * only when female_rider_only), for the map.
     */
    nearby_riders_map: nearbyRidersMap,
    /** The coupon_code sent, priced; omitted without one. */
    coupon: z
      .object({
        code: z.string(),
        valid: z.boolean(),
        /** not_found | used | expired | min_order, when invalid. */
        reason: z.string().nullable(),
      })
      .optional(),
  })
  .openapi("RideQuoteResponse");

export const RideRequestResponse = z.object({ order: OrderSchema }).openapi("RideRequestResponse");
