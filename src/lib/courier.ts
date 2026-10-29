// Courier (parcel) request rules, kept pure so they're unit-testable without a
// database (see courier.test.ts). A courier request is 1..3 routes; each route
// is ONE order for ONE rider: a pickup, then drop-offs delivered in order.
// The order's `courier` jsonb holds the details below; the flat pickup_* /
// destination_* columns mirror the pickup and the LAST drop-off.
import { canTake, VEHICLE_CLASS_SEEDS, type VehicleClass } from "./pricing/vehicle-classes";

export const PARCEL_TYPES = ["documents", "food", "clothes", "electronics", "fragile", "other"] as const;
export const PARCEL_SIZES = ["small", "medium", "large"] as const;
export const COURIER_PAYERS = ["sender", "recipient"] as const;

export type ParcelType = (typeof PARCEL_TYPES)[number];
export type ParcelSize = (typeof PARCEL_SIZES)[number];
export type CourierPayer = (typeof COURIER_PAYERS)[number];

/** Routes per request ("Courier 1", "Courier 2", …). */
export const MAX_COURIER_ROUTES = 3;
/** `store_name` of a courier order — there is no store behind a parcel. */
export const COURIER_STORE_NAME = "Courier";
/**
 * An unclaimed request is canceled this long after it went live (created, or
 * its scheduled time). Matches dispatch's OFFER_MAX_AGE_MS: past it no rider
 * is offered the job anymore, so the customer would search forever.
 */
export const COURIER_SEARCH_TIMEOUT_MS = 20 * 60 * 1000;
/** A scheduled request must be at least this far ahead… */
export const MIN_SCHEDULE_LEAD_MS = 10 * 60 * 1000;
/** …and at most this far. */
export const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** cancel_reason of a request no rider took. */
export const NO_RIDER_REASON = "no_rider";

export interface CourierPoint {
  label: string;
  address: string;
  lat: number;
  lng: number;
}

export interface CourierPickup extends CourierPoint {
  /** Who hands the parcel over; null = the customer themself. */
  contact_name: string | null;
  contact_phone: string | null;
  note: string | null;
}

export interface CourierDropOff extends CourierPoint {
  recipient_name: string;
  recipient_phone: string;
  note: string | null;
  /** Set by the rider's "Confirm delivery" for this drop-off. */
  delivered_at: string | null;
}

export interface CourierDetails {
  pickup: CourierPickup;
  drop_offs: CourierDropOff[];
  parcel: { type: ParcelType; size: ParcelSize; note: string | null };
  /** Who pays the rider in cash: at pickup (sender) or at the last drop-off (recipient). */
  paid_by: CourierPayer;
  /** Estimated road km of the whole route (pricing). */
  distance_km: number;
}

type Row = Record<string, any>;

/** Validated request input for one route (src/validators/courier.ts). */
export interface CourierRouteInput {
  pickup: CourierPoint & { contact_name?: string | null; contact_phone?: string | null; note?: string | null };
  drop_offs: (CourierPoint & { recipient_name: string; recipient_phone: string; note?: string | null })[];
  parcel: { type: ParcelType; size: ParcelSize; note?: string | null };
}

const clean = (s: string | null | undefined) => {
  const v = typeof s === "string" ? s.trim() : "";
  return v ? v : null;
};

/** Request input → the `courier` jsonb stored on the order. */
export function buildCourierDetails(route: CourierRouteInput, paidBy: CourierPayer, distanceKm: number): CourierDetails {
  const point = (p: CourierPoint): CourierPoint => ({
    label: p.label.trim() || p.address.trim(),
    address: p.address.trim() || p.label.trim(),
    lat: p.lat,
    lng: p.lng,
  });
  return {
    pickup: {
      ...point(route.pickup),
      contact_name: clean(route.pickup.contact_name),
      contact_phone: clean(route.pickup.contact_phone),
      note: clean(route.pickup.note),
    },
    drop_offs: route.drop_offs.map((d) => ({
      ...point(d),
      recipient_name: d.recipient_name.trim(),
      recipient_phone: d.recipient_phone.trim(),
      note: clean(d.note),
      delivered_at: null,
    })),
    parcel: { type: route.parcel.type, size: route.parcel.size, note: clean(route.parcel.note) },
    paid_by: paidBy,
    distance_km: distanceKm,
  };
}

/** The `courier` jsonb of an order row, or null (not a courier / older order). */
export function courierOf(o: Row): CourierDetails | null {
  const c = o?.courier;
  return c && typeof c === "object" && Array.isArray(c.drop_offs) && c.pickup ? (c as CourierDetails) : null;
}

/** Index of the drop-off the rider is heading to; null once all are delivered. */
export function currentDropOffIndex(c: CourierDetails | null): number | null {
  if (!c) return null;
  const i = c.drop_offs.findIndex((d) => !d.delivered_at);
  return i === -1 ? null : i;
}

/** Drop-offs still to deliver. */
export const remainingDropOffs = (c: CourierDetails | null) =>
  c ? c.drop_offs.filter((d) => !d.delivered_at).length : 0;

/**
 * The rider confirmed delivery at the current drop-off. `last`: it was the
 * final one, so the order is delivered. Null when nothing is left to deliver.
 */
export function deliverCurrentDropOff(c: CourierDetails, nowIso: string) {
  const index = currentDropOffIndex(c);
  if (index == null) return null;
  const courier: CourierDetails = {
    ...c,
    drop_offs: c.drop_offs.map((d, i) => (i === index ? { ...d, delivered_at: nowIso } : d)),
  };
  return { courier, index, last: currentDropOffIndex(courier) == null };
}

/**
 * When the request went live: created, its scheduled time once that is later,
 * or `accepted_at` — for a courier, when a rider dropped it back into the pool.
 */
export function courierLiveAt(o: Row) {
  const at = (v: unknown) => (typeof v === "string" ? new Date(v).getTime() || 0 : 0);
  return Math.max(at(o.created_at), at(o.scheduled_at), at(o.accepted_at));
}

/** An unclaimed courier request no rider took in time (→ canceled, no_rider). */
export function isCourierSearchExpired(o: Row, now = Date.now()) {
  return (
    o.type === "courier" &&
    o.status === "searching" &&
    !o.rider_id &&
    now - courierLiveAt(o) > COURIER_SEARCH_TIMEOUT_MS
  );
}

/** Why a scheduled time is refused, or null when it's fine. */
export function scheduleError(scheduledAt: string | null | undefined, now = Date.now()) {
  if (!scheduledAt) return null;
  const at = new Date(scheduledAt).getTime();
  if (!Number.isFinite(at)) return "Scheduled time is invalid";
  if (at - now < MIN_SCHEDULE_LEAD_MS) return "Schedule at least 10 minutes ahead";
  if (at - now > MAX_SCHEDULE_AHEAD_MS) return "Schedule within the next 7 days";
  return null;
}

/** Order items of a courier route: one line per drop-off (shown as "N items"). */
export const courierItems = (c: CourierDetails) =>
  c.drop_offs.map((d) => ({ name: d.label || d.address, quantity: 1, unit_price: 0 }));

/** "Grande Poste", or "Grande Poste +2" for a multi-stop route. */
export function dropOffSummary(c: CourierDetails) {
  const last = c.drop_offs[c.drop_offs.length - 1];
  const name = last?.label || last?.address || "";
  return c.drop_offs.length > 1 ? `${name} +${c.drop_offs.length - 1}` : name;
}

/**
 * Can this rider take a courier request (or a distance-mode store delivery)
 * for class `jobVehicle`? Delegates to canTake (vehicle-classes.ts): an
 * exclusive class needs a rider of that class, a motorcycle-based class never
 * goes to a bicycle, a bicycle-based one goes to anyone, and an unknown
 * vehicle on either side is allowed. `bicycle` / `motorcycle` / null behave as
 * they always did. `rider` is the legacy bare vehicle string, or the rider's
 * vehicle + assigned class; `classes` defaults to the seed classes.
 */
export function riderCanTake(
  jobVehicle: string | null | undefined,
  rider: string | null | undefined | { vehicleType?: string | null; vehicleClass?: string | null },
  classes: readonly Pick<VehicleClass, "code" | "base_vehicle" | "exclusive">[] = VEHICLE_CLASS_SEEDS
) {
  const r = rider && typeof rider === "object" ? rider : { vehicleType: rider };
  return canTake(jobVehicle, r, classes);
}
