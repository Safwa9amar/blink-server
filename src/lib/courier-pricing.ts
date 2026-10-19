// Courier (parcel) pricing, kept pure so it's unit-testable without a database
// (see courier-pricing.test.ts). The fare is ALWAYS computed here: the app
// shows the quote from POST /courier/quote and POST /courier/requests prices
// the same route again, so a client can never pick its own delivery fee.

import { legFare } from "./pricing/fare";
import type { PricingValue } from "./pricing/catalog";

export type CourierVehicle = "bicycle" | "motorcycle";

export const COURIER_VEHICLES: CourierVehicle[] = ["bicycle", "motorcycle"];

/** Configured rates (`courier_fare` in the pricing config): per-vehicle fare leg + the extra-stop fee. */
export type CourierFareConfig = PricingValue<"courier_fare">;

/** Average urban speed per vehicle, for ETAs (not a price). */
const SPEED_KMH: Record<CourierVehicle, number> = { bicycle: 14, motorcycle: 28 };

/** Max drop-offs on one courier request. */
export const MAX_DROP_OFFS = 5;
/** Great-circle → road distance. */
export const ROAD_FACTOR = 1.3;
/** Rider's time at each stop (handover, parking). */
const STOP_MINUTES = 3;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Estimated road km of pickup → drop-off 1 → … → drop-off N. */
export function routeKm(pickup: LatLng, dropOffs: LatLng[]) {
  let km = 0;
  let from = pickup;
  for (const to of dropOffs) {
    km += haversineKm(from, to);
    from = to;
  }
  return round1(km * ROAD_FACTOR);
}

export interface CourierQuoteOption {
  vehicle_type: CourierVehicle;
  /** Delivery fee in DZD (before any coupon). */
  fare: number;
  /** Pickup → last drop-off, stops included. */
  duration_minutes: number;
  /** false when the route is longer than this vehicle takes. */
  available: boolean;
}

/** Longest route (road km) a vehicle takes. */
export const courierMaxKm = (vehicle: CourierVehicle, rates: CourierFareConfig) => rates[vehicle].max_km;

/** Fare for one vehicle on a route of `km` with `stops` drop-offs (multiplier applied before rounding up to 10 DA). */
export function courierFare(vehicle: CourierVehicle, km: number, stops: number, rates: CourierFareConfig, multiplier = 1) {
  return legFare(rates[vehicle], km, { stops, extraStopFee: rates.extra_stop_fee, multiplier });
}

export function courierDuration(vehicle: CourierVehicle, km: number, stops: number) {
  return Math.max(1, Math.round((km / SPEED_KMH[vehicle]) * 60 + stops * STOP_MINUTES));
}

/** Every vehicle's quote for one route. */
export function quoteRoute(pickup: LatLng, dropOffs: LatLng[], rates: CourierFareConfig, multiplier = 1) {
  const km = routeKm(pickup, dropOffs);
  const options: CourierQuoteOption[] = COURIER_VEHICLES.map((vehicle) => ({
    vehicle_type: vehicle,
    fare: courierFare(vehicle, km, dropOffs.length, rates, multiplier),
    duration_minutes: courierDuration(vehicle, km, dropOffs.length),
    available: km <= courierMaxKm(vehicle, rates),
  }));
  return { distance_km: km, options };
}

/** Minutes for the nearest free rider to reach the pickup (null: none known). */
export function pickupEtaMinutes(vehicle: CourierVehicle, riderKm: number | null) {
  if (riderKm == null) return null;
  const km = riderKm * ROAD_FACTOR;
  return Math.max(2, Math.round((km / SPEED_KMH[vehicle]) * 60) + 1);
}
