// Courier (parcel) pricing, kept pure so it's unit-testable without a database
// (see courier-pricing.test.ts). The fare is ALWAYS computed here: the app
// shows the quote from POST /courier/quote and POST /courier/requests prices
// the same route again, so a client can never pick its own delivery fee.

export type CourierVehicle = "bicycle" | "motorcycle";

export const COURIER_VEHICLES: CourierVehicle[] = ["bicycle", "motorcycle"];

export interface CourierRate {
  /** Flat fare covering the first `includedKm`. */
  base: number;
  includedKm: number;
  /** Per road km beyond `includedKm`. */
  perKm: number;
  /** Average urban speed, for ETAs. */
  speedKmh: number;
  /** Longest route (road km) this vehicle takes. */
  maxKm: number;
}

/** DZD. The bases are the fares the app used to show for a short trip. */
export const COURIER_RATES: Record<CourierVehicle, CourierRate> = {
  bicycle: { base: 140, includedKm: 2, perKm: 35, speedKmh: 14, maxKm: 10 },
  motorcycle: { base: 250, includedKm: 3, perKm: 40, speedKmh: 28, maxKm: 40 },
};

/** Each drop-off after the first. */
export const EXTRA_STOP_FEE = 60;
/** Max drop-offs on one courier request. */
export const MAX_DROP_OFFS = 5;
/** Great-circle → road distance. */
export const ROAD_FACTOR = 1.3;
/** Rider's time at each stop (handover, parking). */
const STOP_MINUTES = 3;
/** Fares are rounded up to this. */
const FARE_STEP = 10;

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

/** Fare for one vehicle on a route of `km` with `stops` drop-offs. */
export function courierFare(vehicle: CourierVehicle, km: number, stops: number) {
  const r = COURIER_RATES[vehicle];
  const extraKm = Math.max(0, km - r.includedKm);
  const raw = r.base + extraKm * r.perKm + Math.max(0, stops - 1) * EXTRA_STOP_FEE;
  return Math.ceil(raw / FARE_STEP) * FARE_STEP;
}

export function courierDuration(vehicle: CourierVehicle, km: number, stops: number) {
  const r = COURIER_RATES[vehicle];
  return Math.max(1, Math.round((km / r.speedKmh) * 60 + stops * STOP_MINUTES));
}

/** Every vehicle's quote for one route. */
export function quoteRoute(pickup: LatLng, dropOffs: LatLng[]) {
  const km = routeKm(pickup, dropOffs);
  const options: CourierQuoteOption[] = COURIER_VEHICLES.map((vehicle) => ({
    vehicle_type: vehicle,
    fare: courierFare(vehicle, km, dropOffs.length),
    duration_minutes: courierDuration(vehicle, km, dropOffs.length),
    available: km <= COURIER_RATES[vehicle].maxKm,
  }));
  return { distance_km: km, options };
}

/** Minutes for the nearest free rider to reach the pickup (null: none known). */
export function pickupEtaMinutes(vehicle: CourierVehicle, riderKm: number | null) {
  if (riderKm == null) return null;
  const km = riderKm * ROAD_FACTOR;
  return Math.max(2, Math.round((km / COURIER_RATES[vehicle].speedKmh) * 60) + 1);
}
