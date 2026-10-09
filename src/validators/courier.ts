import { z } from "@hono/zod-openapi";
import { COURIER_PAYERS, MAX_COURIER_ROUTES, PARCEL_SIZES, PARCEL_TYPES } from "../lib/courier";
import { COURIER_VEHICLES, MAX_DROP_OFFS } from "../lib/courier-pricing";
import { OrderSchema } from "./orders";

// ─── Courier requests (/courier/*) ───────────────────────────────────
// A request is 1..3 routes; each route = one order for one rider: a pickup,
// then 1..5 drop-offs in order. Rules: src/lib/courier.ts, pricing:
// src/lib/courier-pricing.ts. Spec: blink/docs/superpowers/specs/
// 2026-10-09-courier-requests-design.md

const vehicle = z.enum(COURIER_VEHICLES as [string, ...string[]]);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
/** Digits, spaces, dashes, parentheses, optional leading +. */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, "Invalid phone number");
const note = z.string().trim().max(300).nullable().optional();

const LatLngSchema = z.object({ lat, lng }).openapi("CourierLatLng");

const PointInput = {
  /** Place name ("Grande Poste"); the address is used when empty. */
  label: z.string().trim().max(200).default(""),
  address: z.string().trim().min(1).max(300),
  lat,
  lng,
};

const PickupInputSchema = z
  .object({
    ...PointInput,
    /** Who hands the parcel over, when it isn't the customer. */
    contact_name: z.string().trim().max(100).nullable().optional(),
    contact_phone: phone.nullable().optional(),
    note,
  })
  .openapi("CourierPickupInput");

const DropOffInputSchema = z
  .object({
    ...PointInput,
    recipient_name: z.string().trim().min(1).max(100),
    recipient_phone: phone,
    note,
  })
  .openapi("CourierDropOffInput");

const ParcelSchema = z
  .object({
    type: z.enum(PARCEL_TYPES),
    size: z.enum(PARCEL_SIZES),
    /** What's inside / handling instructions. */
    note: z.string().trim().max(300).nullable().optional(),
  })
  .openapi("CourierParcelInput");

const RouteInputSchema = z
  .object({
    pickup: PickupInputSchema,
    drop_offs: z.array(DropOffInputSchema).min(1).max(MAX_DROP_OFFS),
    parcel: ParcelSchema,
  })
  .openapi("CourierRouteInput");

const couponCode = z.string().trim().min(1).max(64).optional();

export const courierQuoteSchema = z
  .object({
    routes: z
      .array(
        z
          .object({ pickup: LatLngSchema, drop_offs: z.array(LatLngSchema).min(1).max(MAX_DROP_OFFS) })
          .openapi("CourierQuoteRoute")
      )
      .min(1)
      .max(MAX_COURIER_ROUTES),
    /** Priced against the fare (first route only); reported in `coupon`. */
    coupon_code: couponCode,
  })
  .openapi("CourierQuoteBody");

export const createCourierRequestSchema = z
  .object({
    routes: z.array(RouteInputSchema).min(1).max(MAX_COURIER_ROUTES),
    vehicle_type: vehicle,
    /** Pickup time for a scheduled request (10 min – 7 days ahead); omit for "now". */
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    /** Applied to the first route's fare. */
    coupon_code: couponCode,
    /** Who pays the rider in cash: sender at pickup, or recipient at the last drop-off. */
    paid_by: z.enum(COURIER_PAYERS).default("sender"),
  })
  .openapi("CreateCourierRequestBody");

// ─── Responses ───────────────────────────────────────────────────────

export const CourierQuoteOptionSchema = z
  .object({
    vehicle_type: vehicle,
    /** Delivery fees of every route, before the coupon. */
    fare: z.number(),
    discount: z.number(),
    /** fare − discount: what the customer pays. */
    total: z.number(),
    /** Longest route: pickup → last drop-off, stops included. */
    duration_minutes: z.number().int(),
    /** false when a route is longer than this vehicle takes. */
    available: z.boolean(),
    /** Nearest free rider with this vehicle → first pickup; null when none is known. */
    pickup_eta_minutes: z.number().int().nullable(),
    /** Free riders with this vehicle near the first pickup. */
    nearby_riders: z.number().int(),
  })
  .openapi("CourierQuoteOption");

export const CourierQuoteResponse = z
  .object({
    /** Per route, in request order. */
    routes: z.array(z.object({ distance_km: z.number() }).openapi("CourierQuoteRouteResult")),
    options: z.array(CourierQuoteOptionSchema),
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
  .openapi("CourierQuoteResponse");

export const CourierRequestResponse = z
  .object({ orders: z.array(OrderSchema) })
  .openapi("CourierRequestResponse");
