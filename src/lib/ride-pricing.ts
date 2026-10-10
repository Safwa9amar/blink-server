// Ride (passenger moto-taxi) pricing, kept pure so it's unit-testable without
// a database (see ride-pricing.test.ts). The fare is ALWAYS computed here: the
// app shows the quote from POST /ride/quote and POST /ride/requests prices the
// same trip again, so a client can never pick its own fare.
import { haversineKm, ROAD_FACTOR, type LatLng } from "./courier-pricing";

export type RideVehicle = "motorcycle";

/** One product today ("Blink Moto"); the quote is a list so more can follow. */
export const RIDE_VEHICLES: RideVehicle[] = ["motorcycle"];

export interface RideRate {
  /** Flat fare covering the first `includedKm`. */
  base: number;
  includedKm: number;
  /** Per road km beyond `includedKm`. */
  perKm: number;
  /** Average urban speed, for ETAs. */
  speedKmh: number;
  /** Longest ride (road km). */
  maxKm: number;
}

/** DZD. */
export const RIDE_RATES: Record<RideVehicle, RideRate> = {
  motorcycle: { base: 200, includedKm: 3, perKm: 40, speedKmh: 28, maxKm: 40 },
};

/** Pickup and destination closer than this (straight line, km) aren't a ride. */
export const MIN_RIDE_KM = 0.3;
/** Passenger getting on / off. */
const BOARDING_MINUTES = 2;
/** Fares are rounded up to this. */
const FARE_STEP = 10;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Estimated road km of pickup → destination. */
export const rideKm = (pickup: LatLng, destination: LatLng) => round1(haversineKm(pickup, destination) * ROAD_FACTOR);

/** Fare for one vehicle on a ride of `km` road km. */
export function rideFare(vehicle: RideVehicle, km: number) {
  const r = RIDE_RATES[vehicle];
  const raw = r.base + Math.max(0, km - r.includedKm) * r.perKm;
  return Math.ceil(raw / FARE_STEP) * FARE_STEP;
}

export function rideDuration(vehicle: RideVehicle, km: number) {
  return Math.max(1, Math.round((km / RIDE_RATES[vehicle].speedKmh) * 60 + BOARDING_MINUTES));
}

/** Why this trip can't be a ride: too_close (straight line), too_far (road km), else null. */
export function rideRouteError(pickup: LatLng, destination: LatLng, vehicle: RideVehicle = "motorcycle") {
  if (haversineKm(pickup, destination) < MIN_RIDE_KM) return "too_close" as const;
  if (rideKm(pickup, destination) > RIDE_RATES[vehicle].maxKm) return "too_far" as const;
  return null;
}

export interface RideQuoteOption {
  vehicle_type: RideVehicle;
  /** Fare in DZD (before any coupon). */
  fare: number;
  /** Pickup → destination. */
  duration_minutes: number;
  /** false when the trip is too short or too long for this vehicle. */
  available: boolean;
  unavailable_reason: "too_close" | "too_far" | null;
}

/** Every vehicle's quote for one trip. */
export function quoteRide(pickup: LatLng, destination: LatLng) {
  const km = rideKm(pickup, destination);
  const options: RideQuoteOption[] = RIDE_VEHICLES.map((vehicle) => {
    const problem = rideRouteError(pickup, destination, vehicle);
    return {
      vehicle_type: vehicle,
      fare: rideFare(vehicle, km),
      duration_minutes: rideDuration(vehicle, km),
      available: problem == null,
      unavailable_reason: problem,
    };
  });
  return { distance_km: km, options };
}

/** Minutes for the nearest free rider to reach the pickup (null: none known). */
export function ridePickupEtaMinutes(vehicle: RideVehicle, riderKm: number | null) {
  if (riderKm == null) return null;
  const km = riderKm * ROAD_FACTOR;
  return Math.max(2, Math.round((km / RIDE_RATES[vehicle].speedKmh) * 60) + 1);
}
