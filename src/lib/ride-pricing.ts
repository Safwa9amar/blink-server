// Ride (passenger moto-taxi) pricing, kept pure so it's unit-testable without
// a database (see ride-pricing.test.ts). The fare is ALWAYS computed here: the
// app shows the quote from POST /ride/quote and POST /ride/requests prices the
// same trip again, so a client can never pick its own fare.
import { driveMinutes, legFare, SEED_FORMULA, type FareFormula } from "./pricing/fare";
import type { PricingValue } from "./pricing/catalog";
import { haversineKm, type FareExtras, type LatLng } from "./courier-pricing";

export type RideVehicle = "motorcycle";

/** One product today ("Blink Moto"); the quote is a list so more can follow. */
export const RIDE_VEHICLES: RideVehicle[] = ["motorcycle"];

/** Configured rates (`ride_fare` in the pricing config). */
export type RideFareConfig = PricingValue<"ride_fare">;

/**
 * Pickup and destination closer than this (straight line, km) aren't a ride.
 * The live value is `fare_formula.min_ride_km`; this is only the seed.
 */
export const MIN_RIDE_KM = SEED_FORMULA.min_ride_km;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Estimated road km of pickup → destination. */
export const rideKm = (pickup: LatLng, destination: LatLng, formula: FareFormula = SEED_FORMULA) =>
  round1(haversineKm(pickup, destination) * formula.road_factor);

/** Longest ride (road km). */
export const rideMaxKm = (vehicle: RideVehicle, rates: RideFareConfig) => rates[vehicle].max_km;

/** Fare for one vehicle on a ride of `km` road km (the formula's 6 steps; seed formula = multiplier then round up to 10 DA). */
export function rideFare(vehicle: RideVehicle, km: number, rates: RideFareConfig, multiplier = 1, extras: FareExtras = {}) {
  const formula = extras.formula ?? SEED_FORMULA;
  return legFare(rates[vehicle], km, {
    multiplier,
    formula,
    surcharge: extras.surcharge,
    speedKmh: formula.speed_kmh.motorcycle,
  });
}

export function rideDuration(vehicle: RideVehicle, km: number, formula: FareFormula = SEED_FORMULA) {
  return Math.max(1, Math.round(driveMinutes(km, formula.speed_kmh.motorcycle) + formula.boarding_minutes));
}

/** Why this trip can't be a ride: too_close (straight line), too_far (road km), else null. */
export function rideRouteError(
  pickup: LatLng,
  destination: LatLng,
  rates: RideFareConfig,
  vehicle: RideVehicle = "motorcycle",
  formula: FareFormula = SEED_FORMULA
) {
  if (haversineKm(pickup, destination) < formula.min_ride_km) return "too_close" as const;
  if (rideKm(pickup, destination, formula) > rideMaxKm(vehicle, rates)) return "too_far" as const;
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
  unavailable_reason: "too_close" | "too_far" | "out_of_service_area" | null;
}

/** Every vehicle's quote for one trip. */
export function quoteRide(pickup: LatLng, destination: LatLng, rates: RideFareConfig, multiplier = 1, extras: FareExtras = {}) {
  const formula = extras.formula ?? SEED_FORMULA;
  const km = rideKm(pickup, destination, formula);
  const options: RideQuoteOption[] = RIDE_VEHICLES.map((vehicle) => {
    const problem = extras.enabled === false ? ("out_of_service_area" as const) : rideRouteError(pickup, destination, rates, vehicle, formula);
    return {
      vehicle_type: vehicle,
      fare: rideFare(vehicle, km, rates, multiplier, extras),
      duration_minutes: rideDuration(vehicle, km, formula),
      available: problem == null,
      unavailable_reason: problem,
    };
  });
  return { distance_km: km, options };
}

/** Minutes for the nearest free rider to reach the pickup (null: none known). */
export function ridePickupEtaMinutes(vehicle: RideVehicle, riderKm: number | null, formula: FareFormula = SEED_FORMULA) {
  if (riderKm == null) return null;
  const km = riderKm * formula.road_factor;
  return Math.max(2, Math.round(driveMinutes(km, formula.speed_kmh.motorcycle)) + 1);
}
