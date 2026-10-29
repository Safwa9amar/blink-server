import { z } from "@hono/zod-openapi";
import { COURIER_PAYERS, MAX_COURIER_ROUTES, PARCEL_SIZES, PARCEL_TYPES } from "../lib/courier";
import { COURIER_VEHICLES, MAX_DROP_OFFS } from "../lib/courier-pricing";
import { CLASS_CODE_RE } from "../lib/pricing/catalog";
import { OrderSchema } from "./orders";

// ─── Courier requests (/courier/*) ───────────────────────────────────
// A request is 1..3 routes; each route = one order for one rider: a pickup,
// then 1..5 drop-offs in order. Rules: src/lib/courier.ts, pricing:
// src/lib/courier-pricing.ts. Spec: blink/docs/superpowers/specs/
// 2026-10-09-courier-requests-design.md

/** bicycle | motorcycle: a rider's base vehicle (map markers, `base_vehicle`). */
const vehicle = z.enum(COURIER_VEHICLES as [string, ...string[]]);
/** A vehicle class code (`bicycle` / `motorcycle` or any enabled courier class); the quote lists the live ones. */
const vehicleClass = z.string().regex(CLASS_CODE_RE);
/** Display name of a vehicle class. */
export const VehicleNameSchema = z
  .object({ en: z.string(), fr: z.string(), ar: z.string() })
  .openapi("VehicleClassName");
// lat / lng / phone / couponCode are shared with rides (src/validators/ride.ts).
export const lat = z.number().min(-90).max(90);
export const lng = z.number().min(-180).max(180);
/** Digits, spaces, dashes, parentheses, optional leading +. */
export const phone = z
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

export const couponCode = z.string().trim().min(1).max(64).optional();

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
    /** An enabled courier class from the quote (`bicycle` / `motorcycle` from older apps). */
    vehicle_type: vehicleClass,
    /** Pickup time for a scheduled request (10 min – 7 days ahead); omit for "now". */
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    /** Applied to the first route's fare. */
    coupon_code: couponCode,
    /** Who pays the rider in cash: sender at pickup, or recipient at the last drop-off. */
    paid_by: z.enum(COURIER_PAYERS).default("sender"),
  })
  .openapi("CreateCourierRequestBody");

// ─── Responses ───────────────────────────────────────────────────────

/**
 * A free rider drawn on the request map (ride + courier quotes). Never the
 * rider's id, name or exact position: src/lib/nearby-riders-map.ts.
 */
export const NearbyRiderMarkerSchema = z
  .object({
    /** Opaque token, stable for the day (key markers on it); not a user id. */
    id: z.string(),
    /** Rounded to ~100 m plus a small per-rider offset. */
    lat: z.number(),
    lng: z.number(),
    vehicle_type: vehicle.nullable(),
    /** Degrees clockwise from north; null when unknown (always, for now). */
    heading: z.number().nullable(),
  })
  .openapi("NearbyRiderMarker");

/**
 * Up to 12 free riders near the pickup, nearest first, with a position from
 * the last 10 minutes — drawn on the map; counted in options[].nearby_riders.
 */
export const nearbyRidersMap = z.array(NearbyRiderMarkerSchema);

export const CourierQuoteOptionSchema = z
  .object({
    /** The vehicle class code (send it back as the request's vehicle_type). */
    vehicle_type: vehicleClass,
    vehicle_name: VehicleNameSchema,
    /** bicycle | motorcycle: pick the icon from it. */
    base_vehicle: vehicle,
    /** Delivery fees of every route, before the coupon. */
    fare: z.number(),
    discount: z.number(),
    /** fare − discount: what the customer pays. */
    total: z.number(),
    /** Longest route: pickup → last drop-off, stops included. */
    duration_minutes: z.number().int(),
    /** false when a route is longer than this vehicle takes, or a pickup is outside the service area. */
    available: z.boolean(),
    unavailable_reason: z.enum(["too_far", "out_of_service_area"]).nullable(),
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
    /** Free couriers (any vehicle) near the first pickup, for the map. */
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
  .openapi("CourierQuoteResponse");

export const CourierRequestResponse = z
  .object({ orders: z.array(OrderSchema) })
  .openapi("CourierRequestResponse");
