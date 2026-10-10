import { z } from "@hono/zod-openapi";
import { CourierDetailsSchema } from "./orders";

// ─── Rider dispatch (/riders/jobs/*) ─────────────────────────────────
// A "job" is an order seen from the rider's side: where to pick up, where to
// drop off, who the customer is and what the rider earns. Offers and the
// active job share this shape.

const JobPointSchema = z
  .object({
    label: z.string(),
    address: z.string(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  })
  .openapi("RiderJobPoint");

const JobCustomerSchema = z
  .object({
    name: z.string(),
    phone: z.string().nullable(),
    avatar: z.string().nullable(),
    /** Average of riders' ratings of this customer; null when unrated. */
    rating: z.number().nullable(),
    /** Delivered orders for this customer. */
    total_trips: z.number().int(),
  })
  .openapi("RiderJobCustomer");

const JobConflictSchema = z
  .object({
    id: z.string(),
    display_id: z.string(),
    scheduled_at: z.string(),
    pickup_address: z.string(),
  })
  .openapi("RiderJobConflict");

/** One store of a multi-store checkout job (see src/lib/bundle.ts). */
const JobStopSchema = z
  .object({
    order_id: z.string(),
    display_id: z.string(),
    store_name: z.string(),
    /** shopper: the store was too busy / didn't answer — the rider buys the items. */
    type: z.enum(["merchant", "shopper"]),
    pickup: JobPointSchema,
    /** Store phone for "Call store"; null when unknown. */
    phone: z.string().nullable(),
    item_count: z.number().int(),
    merchant_status: z.string().nullable(),
    /** This store's order status (heading_to_store → pickup → on_the_way → delivered). */
    status: z.string(),
    picked_up: z.boolean(),
  })
  .openapi("RiderJobStop");

export const RiderJobSchema = z
  .object({
    id: z.string(),
    display_id: z.string(),
    type: z.enum(["merchant", "shopper", "courier", "ride"]),
    status: z.string(),
    store_name: z.string(),
    customer: JobCustomerSchema,
    pickup: JobPointSchema,
    destination: JobPointSchema,
    /** Delivery fee — what the trip pays before Blink's commission. */
    fare: z.number(),
    discount: z.number(),
    /** Order total the customer pays (cash on delivery). */
    order_total: z.number(),
    commission_rate: z.number(),
    /** Pickup → destination. */
    distance_km: z.number(),
    duration_minutes: z.number().int(),
    /** Rider's last known position → pickup; null when unknown. */
    pickup_distance_km: z.number().nullable(),
    vehicle_type: z.string().nullable(),
    scheduled_at: z.string().nullable(),
    /** Available riders around the pickup (offer screen). */
    nearby_riders: z.number().int(),
    /** Trip record once accepted. */
    trip_id: z.string().nullable(),
    /** Another booked job within an hour of this scheduled one. */
    conflict_with: JobConflictSchema.nullable(),
    /**
     * Multi-store checkout: ONE job for every store, `id` = the lead order.
     * null for a single order.
     */
    checkout_id: z.string().nullable(),
    /** Pickups in route order; empty for a single order. */
    stops: z.array(JobStopSchema),
    /**
     * A store asked THIS rider for the job (merchant "assign a rider"):
     * own = as the store's own driver (no Blink trip / commission), blink = as
     * a Blink rider. Nothing is assigned until the rider accepts. null for an
     * ordinary job, and once the request is answered or expired.
     */
    request_kind: z.enum(["own", "blink"]).nullable(),
    /** The store request's answer deadline (ISO); null when request_kind is. */
    request_expires_at: z.string().nullable(),
    /**
     * How an assigned store order is delivered: own = by the store's own
     * driver (no Blink trip, fee or commission), blink = a Blink delivery.
     * null until a rider is assigned, and for shopper / courier jobs.
     */
    delivery_mode: z.enum(["own", "blink"]).nullable(),
    /**
     * Courier (parcel) job: the parcel, who pays, the pickup contact and every
     * drop-off with its recipient. `destination` is the drop-off at
     * `current_drop_off`; `advance delivered` completes it, and the job is done
     * after the last one. null for store orders.
     */
    courier: z
      .object({
        parcel: CourierDetailsSchema.shape.parcel,
        paid_by: CourierDetailsSchema.shape.paid_by,
        pickup: CourierDetailsSchema.shape.pickup,
        drop_offs: CourierDetailsSchema.shape.drop_offs,
        /** Index in drop_offs of the next drop-off; null once all are delivered. */
        current_drop_off: z.number().int().nullable(),
      })
      .nullable(),
    /**
     * Ride (passenger moto-taxi) job: who to pick up and how to reach them.
     * `pickup` / `destination` are the ride's two points; `fare` is collected
     * in cash at the end. null for every other job.
     */
    ride: z
      .object({
        /** The passenger the customer named, else the customer. */
        passenger_name: z.string(),
        /** "Call the passenger"; null when unknown. */
        passenger_phone: z.string().nullable(),
        /** The customer booked it for someone else. */
        for_someone_else: z.boolean(),
        /** Where exactly to wait ("Gate B"…). */
        pickup_note: z.string().nullable(),
        /** Set by `advance arrived` (status `pickup`); "waiting since". */
        arrived_at: z.string().nullable(),
        /** The customer asked for a female rider. */
        female_rider_only: z.boolean(),
      })
      .nullable(),
  })
  .openapi("RiderJob");

// `job` is omitted (not null) when there is none: OpenAPI 3.0 can't express
// `nullable` next to a $ref, and would mark RiderJob itself nullable.
export const RiderJobOptionalResponse = z
  .object({ job: RiderJobSchema.optional() })
  .openapi("RiderJobOptionalResponse");

export const RiderJobResponse = z.object({ job: RiderJobSchema }).openapi("RiderJobResponse");

export const RiderJobListResponse = z
  .object({ jobs: z.array(RiderJobSchema) })
  .openapi("RiderJobListResponse");

/**
 * Which job the rider was shown — the job's request_expires_at:
 * - a string: answering THAT store request (not one the store withdrew,
 *   re-sent or let lapse meanwhile — those answer 409);
 * - null: an ordinary pool job (if the order became a store request to this
 *   rider meanwhile, accept answers 409 rather than taking it on the
 *   request's terms);
 * - omitted: older apps (the request open to the rider, if any, applies).
 */
const requestToken = z.string().max(64).nullable().optional();

export const acceptJobSchema = z
  .object({ request_expires_at: requestToken })
  .openapi("AcceptRiderJobBody");

export const declineJobSchema = z
  .object({ reason: z.string().max(500).optional(), request_expires_at: requestToken })
  .openapi("DeclineRiderJobBody");

export const cancelJobSchema = z
  .object({
    /**
     * Reason key or text. On a ride the rider has arrived at (`pickup`),
     * `passenger_no_show` ENDS the ride (canceled, no penalty) instead of
     * handing it back to the pool — once the rider has waited 5 minutes
     * since arriving (else 400 `no_show_too_early`, CancelRiderJobError).
     */
    reason: z.string().min(1).max(500),
  })
  .openapi("CancelRiderJobBody");

/**
 * 400 of POST /riders/jobs/{id}/cancel. `code: no_show_too_early`: a ride's
 * `passenger_no_show` before the rider has waited 5 minutes at the pickup
 * (since `ride.arrived_at`, server clock); `seconds_remaining` = how long is
 * left. Other 400s carry only `error`.
 */
export const CancelRiderJobError = z
  .object({
    error: z.string(),
    code: z.enum(["no_show_too_early"]).optional(),
    seconds_remaining: z.number().int().nonnegative().optional(),
  })
  .openapi("CancelRiderJobError");

export const advanceJobSchema = z
  .object({
    /**
     * arrived: at pickup · picked_up: parcel (or passenger) on board — a
     * ride only from `pickup`, i.e. after `arrived` (409 otherwise) ·
     * delivered: done — for a courier job with several drop-offs, done at the
     * CURRENT drop-off (the order is delivered after the last one).
     */
    step: z.enum(["arrived", "picked_up", "delivered"]),
    /** Multi-store checkout: the store's order for `arrived` / `picked_up`. */
    order_id: z.string().uuid().optional(),
  })
  .openapi("AdvanceRiderJobBody");

export const TripSummarySchema = z
  .object({
    trip_id: z.string(),
    display_id: z.string(),
    pickup_address: z.string(),
    destination_address: z.string(),
    total_fare: z.number(),
    commission: z.number(),
    net_payout: z.number(),
    distance_km: z.number(),
    duration_minutes: z.number().int(),
  })
  .openapi("RiderTripSummary");

export const AdvanceJobResponse = z
  // Omitted unless the step was `delivered` (see RiderJobOptionalResponse).
  .object({ job: RiderJobSchema, summary: TripSummarySchema.optional() })
  .openapi("AdvanceRiderJobResponse");

export const rateCustomerSchema = z
  .object({ rating: z.number().int().min(1).max(5) })
  .openapi("RateRiderCustomerBody");

export const availabilitySchema = z
  .object({ is_available: z.boolean() })
  .openapi("RiderAvailabilityBody");

export const AvailabilityResponse = z
  .object({ is_available: z.boolean() })
  .openapi("RiderAvailabilityResponse");

export const RiderShiftResponse = z
  .object({
    is_available: z.boolean(),
    /** Accepted / (accepted + declined offers), last 100 — 0-100. */
    acceptance_rate: z.number(),
    /** Canceled after accepting / accepted, last 100 — 0-100. */
    cancellation_rate: z.number(),
  })
  .openapi("RiderShiftResponse");

export const RiderWalletResponse = z
  .object({
    wallet: z.object({
      /** Completed deposits − completed withdrawals − trip commissions − penalties + challenge rewards. */
      total: z.number(),
      /** total − pending withdrawals (what can still be withdrawn). */
      available: z.number(),
      /** Withdrawals awaiting an agent. */
      pending: z.number(),
      currency: z.string(),
    }),
  })
  .openapi("RiderWalletResponse");
