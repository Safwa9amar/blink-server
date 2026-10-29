// Ride (passenger moto-taxi) rules, kept pure so they're unit-testable without
// a database (see ride.test.ts). A ride is ONE order for ONE rider: a pickup,
// then a destination. The order's `ride` jsonb holds the details below; the
// flat pickup_* / destination_* columns mirror the two points.
// Spec: blink/docs/superpowers/specs/2026-10-09-ride-requests-design.md
import { courierLiveAt } from "./courier";
import { canTake, VEHICLE_CLASS_SEEDS, type VehicleClass } from "./pricing/vehicle-classes";

type VehicleClassLike = Pick<VehicleClass, "code" | "base_vehicle" | "exclusive">;

/** `store_name` of a ride order — there is no store behind a ride. */
export const RIDE_STORE_NAME = "Ride";
/**
 * An unclaimed ride is canceled this long after it went live (created, its
 * scheduled time, or a rider dropping it back). Shorter than a courier's
 * window: a passenger is standing at the curb.
 */
export const RIDE_SEARCH_TIMEOUT_MS = 10 * 60 * 1000;
/** Rides are motorcycle only ("Blink Moto"). */
export const RIDE_VEHICLE = "motorcycle";

/**
 * cancel_reason keys of a ride. The column is free-form text; these are the
 * keys the apps send and show:
 * - customer (PATCH /orders/{id}/status): rider_asked … other — anything else
 *   from a customer is refused (400);
 * - rider (POST /riders/jobs/{id}/cancel at the pickup): passenger_no_show;
 * - system (search window ran out): no_rider.
 */
export const RIDE_CUSTOMER_CANCEL_REASONS = [
  "rider_asked",
  "changed_mind",
  "accidental",
  "waiting_too_long",
  "other",
] as const;
/** The rider waited at the pickup and the passenger never came: the ride ends here. */
export const PASSENGER_NO_SHOW_REASON = "passenger_no_show";
/**
 * How long the rider must wait at the pickup (since `ride.arrived_at`) before
 * reporting a no-show. Earlier, POST /riders/jobs/{id}/cancel answers 400
 * `no_show_too_early` with the seconds left.
 */
export const RIDE_NO_SHOW_WAIT_MS = 5 * 60 * 1000;
/** `code` of the 400 a no-show reported before RIDE_NO_SHOW_WAIT_MS gets. */
export const NO_SHOW_TOO_EARLY = "no_show_too_early";

/** A cancel reason the customer may send for a ride (never a system / rider key). */
export const isRideCustomerCancelReason = (reason: string) =>
  (RIDE_CUSTOMER_CANCEL_REASONS as readonly string[]).includes(reason);

/**
 * Statuses in which the customer may cancel a ride: searching, the rider on
 * the way (heading_to_store) or waiting at the pickup (pickup). Never once the
 * passenger is on board.
 */
export const RIDE_CUSTOMER_CANCELABLE = ["searching", "heading_to_store", "pickup"] as const;

export interface RidePoint {
  label: string;
  address: string;
  lat: number;
  lng: number;
}

export interface RidePickup extends RidePoint {
  /** For the rider: "Gate B", "in front of the pharmacy"… */
  note: string | null;
}

export interface RidePassenger {
  name: string;
  phone: string;
}

export interface RideDetails {
  pickup: RidePickup;
  destination: RidePoint;
  /** Someone else rides (the rider calls them); null = the customer rides. */
  passenger: RidePassenger | null;
  /** Estimated road km (pricing). */
  distance_km: number;
  /** Pickup → destination, priced estimate. */
  duration_minutes: number;
  /** Only a female rider may take it (users.gender = 'female'). */
  female_rider_only: boolean;
  /** Set by the rider's "I've arrived" (advance `arrived`). */
  arrived_at: string | null;
}

type Row = Record<string, any>;

/** Validated request input (src/validators/ride.ts). */
export interface RideRequestInput {
  pickup: RidePoint & { note?: string | null };
  destination: RidePoint;
  passenger?: { name: string; phone: string } | null;
  female_rider_only?: boolean;
}

const clean = (s: string | null | undefined) => {
  const v = typeof s === "string" ? s.trim() : "";
  return v ? v : null;
};

const point = (p: RidePoint): RidePoint => ({
  label: p.label.trim() || p.address.trim(),
  address: p.address.trim() || p.label.trim(),
  lat: p.lat,
  lng: p.lng,
});

/** Request input → the `ride` jsonb stored on the order. */
export function buildRideDetails(
  input: RideRequestInput,
  estimate: { distanceKm: number; durationMinutes: number }
): RideDetails {
  const name = clean(input.passenger?.name);
  const phone = clean(input.passenger?.phone);
  return {
    pickup: { ...point(input.pickup), note: clean(input.pickup.note) },
    destination: point(input.destination),
    // Someone else needs both, so the rider can find and call them.
    passenger: name && phone ? { name, phone } : null,
    distance_km: estimate.distanceKm,
    duration_minutes: estimate.durationMinutes,
    female_rider_only: input.female_rider_only === true,
    arrived_at: null,
  };
}

/** The `ride` jsonb of an order row, or null (not a ride / older order). */
export function rideOf(o: Row): RideDetails | null {
  const r = o?.ride;
  return r && typeof r === "object" && r.pickup && r.destination ? (r as RideDetails) : null;
}

/** The rider reached the pickup. The first arrival stands (a retry keeps it). */
export const markRideArrived = (r: RideDetails, nowIso: string): RideDetails => ({
  ...r,
  arrived_at: r.arrived_at ?? nowIso,
});

/**
 * Who the rider picks up: the passenger the customer named, else the customer
 * themself (`customer` = their name / phone, from users).
 */
export function ridePassenger(r: RideDetails | null, customer: { name: string | null; phone: string | null }) {
  const p = r?.passenger;
  return p
    ? { name: p.name, phone: p.phone, for_someone_else: true }
    : { name: customer.name ?? "Customer", phone: customer.phone ?? null, for_someone_else: false };
}

/**
 * When the ride went live: created, its scheduled time once that is later, or
 * `accepted_at` — when a rider dropped it back into the pool. Same rule as a
 * courier request.
 */
export const rideLiveAt = (o: Row) => courierLiveAt(o);

/** An unclaimed ride no rider took in time (→ canceled, no_rider). */
export function isRideSearchExpired(o: Row, now = Date.now()) {
  return (
    o.type === "ride" &&
    o.status === "searching" &&
    !o.rider_id &&
    now - rideLiveAt(o) > RIDE_SEARCH_TIMEOUT_MS
  );
}

/**
 * A ride's passenger boards (advance `picked_up`) only once the rider has
 * reported arriving (`pickup`): `ride.arrived_at`, the customer's "rider
 * arrived" and the no-show wait all hang on that step.
 */
export const rideCanPickUp = (status: string) => status === "pickup";

/** Whether the customer may still cancel a ride in this status. */
export const rideCustomerCancelable = (status: string) =>
  (RIDE_CUSTOMER_CANCELABLE as readonly string[]).includes(status);

/**
 * A rider's cancel that ENDS the ride (the passenger didn't show up at the
 * pickup) instead of handing it back to the pool. Only once the rider has
 * arrived (`pickup`).
 */
export const isPassengerNoShow = (o: Row, reason: string) =>
  o.type === "ride" && o.status === "pickup" && reason === PASSENGER_NO_SHOW_REASON;

/**
 * Milliseconds the rider still has to wait at the pickup before a no-show may
 * be reported (0 = now). Counted from `ride.arrived_at`; without a readable
 * arrival time the wait can't be proven, so the whole wait is left.
 */
export function noShowWaitLeftMs(r: Pick<RideDetails, "arrived_at"> | null, now = Date.now()) {
  const at = r?.arrived_at ? new Date(r.arrived_at).getTime() : NaN;
  if (!Number.isFinite(at)) return RIDE_NO_SHOW_WAIT_MS;
  return Math.max(0, Math.min(RIDE_NO_SHOW_WAIT_MS, at + RIDE_NO_SHOW_WAIT_MS - now));
}

/**
 * A no-show reported for a ride at the pickup that has no readable arrival
 * time (the "I've arrived" write never stamped it): the wait can't be proven,
 * and nothing would ever start it, so every report would be refused forever.
 * Returns the ride with its waiting clock starting now — to store, then refuse
 * this report with the whole wait left — or null when the clock already runs.
 */
export function startNoShowClock(r: RideDetails | null, nowIso: string): RideDetails | null {
  if (!r) return null;
  const at = r.arrived_at ? new Date(r.arrived_at).getTime() : NaN;
  return Number.isFinite(at) ? null : { ...r, arrived_at: nowIso };
}

/**
 * Why a rider can't take this ride, or null when they can: rides need a
 * motorcycle (an unknown vehicle is refused too), and a woman when the
 * customer asked for a female rider.
 */
export function rideRiderProblem(
  o: Row,
  rider: { vehicleType: string | null | undefined; vehicleClass?: string | null; gender: string | null | undefined },
  classes: readonly VehicleClassLike[] = VEHICLE_CLASS_SEEDS
): "vehicle" | "gender" | null {
  // The ride's class is `orders.vehicle_type`; an exclusive class (Comfort) is
  // only for riders of that class, every other needs a motorcycle.
  if (!canTake(o?.vehicle_type ?? RIDE_VEHICLE, rider, classes, { strict: true })) return "vehicle";
  if (o?.ride?.female_rider_only === true && rider.gender !== "female") return "gender";
  return null;
}

/** Can this rider be offered / accept this ride? See rideRiderProblem. */
export const riderCanTakeRide = (
  o: Row,
  rider: { vehicleType: string | null | undefined; vehicleClass?: string | null; gender: string | null | undefined },
  classes: readonly VehicleClassLike[] = VEHICLE_CLASS_SEEDS
) => rideRiderProblem(o, rider, classes) == null;

/** Order items of a ride: one line, the destination (shown as "1 item"). */
export const rideItems = (r: RideDetails) => [
  { name: r.destination.label || r.destination.address, quantity: 1, unit_price: 0 },
];
