// Courier (parcel) pricing, kept pure so it's unit-testable without a database
// (see courier-pricing.test.ts). The fare is ALWAYS computed here: the app
// shows the quote from POST /courier/quote and POST /courier/requests prices
// the same route again, so a client can never pick its own delivery fee.

import { driveMinutes, legFare, SEED_FORMULA, type FareFormula, type FareLeg } from "./pricing/fare";
import { legOf, type PricingValue } from "./pricing/catalog";
import { legacyLegs, VEHICLE_CLASS_SEEDS, type BaseVehicle, type ClassLeg } from "./pricing/vehicle-classes";

/** A courier vehicle class code: `bicycle` / `motorcycle` today, any enabled courier class (pricing config). */
export type CourierVehicle = string;

/** The two legacy codes — what old apps send. The live list is the enabled `courier` classes. */
export const COURIER_VEHICLES: CourierVehicle[] = ["bicycle", "motorcycle"];

/** Speed table key of a class code (formula.speed_kmh is per BASE vehicle). */
const baseOf = (vehicle: string, base?: BaseVehicle): BaseVehicle =>
  base ?? VEHICLE_CLASS_SEEDS.find((c) => c.code === vehicle)?.base_vehicle ?? (vehicle === "bicycle" ? "bicycle" : "motorcycle");

/** Configured rates (`courier_fare` in the pricing config): per-vehicle fare leg + the extra-stop fee. */
export type CourierFareConfig = PricingValue<"courier_fare">;

/** Max drop-offs on one courier request. */
export const MAX_DROP_OFFS = 5;
/**
 * Great-circle → road distance. The live value is `fare_formula.road_factor`
 * (pricing config); this is only the seed, for callers without a formula.
 */
export const ROAD_FACTOR = SEED_FORMULA.road_factor;

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
export function routeKm(pickup: LatLng, dropOffs: LatLng[], formula: FareFormula = SEED_FORMULA) {
  let km = 0;
  let from = pickup;
  for (const to of dropOffs) {
    km += haversineKm(from, to);
    from = to;
  }
  return round1(km * formula.road_factor);
}

export interface CourierQuoteOption {
  vehicle_type: CourierVehicle;
  /** Display name of the class. */
  vehicle_name: { en: string; fr: string; ar: string };
  /** bicycle | motorcycle — the class's base vehicle (icon, speed). */
  base_vehicle: BaseVehicle;
  /** Delivery fee in DZD (before any coupon). */
  fare: number;
  /** Pickup → last drop-off, stops included. */
  duration_minutes: number;
  /** false when the route is longer than this vehicle takes, or the pickup is outside the service area. */
  available: boolean;
  unavailable_reason: "too_far" | "out_of_service_area" | null;
}

/** What the pricing config adds on top of the rates (all default to the seeds). */
export type FareExtras = {
  formula?: FareFormula;
  surcharge?: number;
  enabled?: boolean;
  /** The priced classes (pricing config, per-class legs). Absent = the legacy `rates.bicycle` / `rates.motorcycle`. */
  classes?: ClassLeg[];
};

/** The leg + base vehicle of a class: from the resolved classes when given, else from `rates`. */
function legFor(vehicle: string, rates: unknown, extras: FareExtras, key: "courier_fare" | "ride_fare") {
  const found = extras.classes?.find((c) => c.cls.code === vehicle);
  if (found) return { leg: found.leg as FareLeg, base: found.cls.base_vehicle };
  const leg = legOf(rates, vehicle, key);
  if (!leg) throw new Error(`No ${key} leg for vehicle class "${vehicle}"`);
  return { leg: leg as FareLeg, base: baseOf(vehicle) };
}
export { legFor as classLegFor };

/** Longest route (road km) a vehicle takes. */
export const courierMaxKm = (vehicle: CourierVehicle, rates: CourierFareConfig, extras: FareExtras = {}) =>
  legFor(vehicle, rates, extras, "courier_fare").leg.max_km;

/** Fare for one vehicle on a route of `km` with `stops` drop-offs (the formula's 6 steps; seed formula = multiplier then round up to 10 DA). */
export function courierFare(
  vehicle: CourierVehicle,
  km: number,
  stops: number,
  rates: CourierFareConfig,
  multiplier = 1,
  extras: FareExtras = {}
) {
  const formula = extras.formula ?? SEED_FORMULA;
  const { leg, base } = legFor(vehicle, rates, extras, "courier_fare");
  return legFare(leg, km, {
    stops,
    extraStopFee: rates.extra_stop_fee,
    multiplier,
    formula,
    surcharge: extras.surcharge,
    speedKmh: formula.speed_kmh[base],
  });
}

export function courierDuration(vehicle: CourierVehicle, km: number, stops: number, formula: FareFormula = SEED_FORMULA, base?: BaseVehicle) {
  return Math.max(1, Math.round(driveMinutes(km, formula.speed_kmh[baseOf(vehicle, base)]) + stops * formula.stop_minutes));
}

/** Every vehicle's quote for one route. */
export function quoteRoute(
  pickup: LatLng,
  dropOffs: LatLng[],
  rates: CourierFareConfig,
  multiplier = 1,
  extras: FareExtras = {}
) {
  const formula = extras.formula ?? SEED_FORMULA;
  const km = routeKm(pickup, dropOffs, formula);
  const classes = extras.classes ?? legacyLegs("courier_fare", rates);
  const options: CourierQuoteOption[] = classes.map(({ cls, leg }) => {
    const vehicle = cls.code;
    const tooFar = km > leg.max_km;
    const outside = extras.enabled === false;
    return {
      vehicle_type: vehicle,
      vehicle_name: cls.names,
      base_vehicle: cls.base_vehicle,
      fare: courierFare(vehicle, km, dropOffs.length, rates, multiplier, { ...extras, classes }),
      duration_minutes: courierDuration(vehicle, km, dropOffs.length, formula, cls.base_vehicle),
      available: !tooFar && !outside,
      unavailable_reason: outside ? ("out_of_service_area" as const) : tooFar ? ("too_far" as const) : null,
    };
  });
  return { distance_km: km, options };
}

/** Minutes for the nearest free rider to reach the pickup (null: none known). */
export function pickupEtaMinutes(vehicle: CourierVehicle, riderKm: number | null, formula: FareFormula = SEED_FORMULA, base?: BaseVehicle) {
  if (riderKm == null) return null;
  const km = riderKm * formula.road_factor;
  return Math.max(2, Math.round(driveMinutes(km, formula.speed_kmh[baseOf(vehicle, base)])) + 1);
}
