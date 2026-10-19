// Ride (passenger moto-taxi) pricing, kept pure so it's unit-testable without
// a database (see ride-pricing.test.ts). The fare is ALWAYS computed here: the
// app shows the quote from POST /ride/quote and POST /ride/requests prices the
// same trip again, so a client can never pick its own fare.
import { legFare } from "./pricing/fare";
import type { PricingValue } from "./pricing/catalog";
import { haversineKm, ROAD_FACTOR, type LatLng } from "./courier-pricing";

export type RideVehicle = "motorcycle";

/** One product today ("Blink Moto"); the quote is a list so more can follow. */
export const RIDE_VEHICLES: RideVehicle[] = ["motorcycle"];

/** Configured rates (`ride_fare` in the pricing config). */
export type RideFareConfig = PricingValue<"ride_fare">;

/** Average urban speed, for ETAs (not a price). */
const SPEED_KMH = 28;

/** Pickup and destination closer than this (straight line, km) aren't a ride. */
export const MIN_RIDE_KM = 0.3;
/** Passenger getting on / off. */
const BOARDING_MINUTES = 2;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Estimated road km of pickup → destination. */
export const rideKm = (pickup: LatLng, destination: LatLng) => round1(haversineKm(pickup, destination) * ROAD_FACTOR);

/** Longest ride (road km). */
export const rideMaxKm = (vehicle: RideVehicle, rates: RideFareConfig) => rates[vehicle].max_km;

/** Fare for one vehicle on a ride of `km` road km (multiplier applied before rounding up to 10 DA). */
export function rideFare(vehicle: RideVehicle, km: number, rates: RideFareConfig, multiplier = 1) {
  return legFare(rates[vehicle], km, { multiplier });
}

export function rideDuration(vehicle: RideVehicle, km: number) {
  return Math.max(1, Math.round((km / SPEED_KMH) * 60 + BOARDING_MINUTES));
}

/** Why this trip can't be a ride: too_close (straight line), too_far (road km), else null. */
export function rideRouteError(pickup: LatLng, destination: LatLng, rates: RideFareConfig, vehicle: RideVehicle = "motorcycle") {
  if (haversineKm(pickup, destination) < MIN_RIDE_KM) return "too_close" as const;
  if (rideKm(pickup, destination) > rideMaxKm(vehicle, rates)) return "too_far" as const;
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
export function quoteRide(pickup: LatLng, destination: LatLng, rates: RideFareConfig, multiplier = 1) {
  const km = rideKm(pickup, destination);
  const options: RideQuoteOption[] = RIDE_VEHICLES.map((vehicle) => {
    const problem = rideRouteError(pickup, destination, rates, vehicle);
    return {
      vehicle_type: vehicle,
      fare: rideFare(vehicle, km, rates, multiplier),
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
  return Math.max(2, Math.round((km / SPEED_KMH) * 60) + 1);
}
