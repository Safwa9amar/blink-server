// Rider-facing durations (job views, trip rows, merchant rider ETAs) from the
// resolved `fare_formula` — the same speed / stop / boarding figures the fare
// and the customer quote use (pure: callers resolve the formula at the job's
// pickup place and pass it in). Spec: Addendum 1, fare_formula.
import { driveMinutes, SEED_FORMULA, type FareFormula } from "./pricing/fare";
import { VEHICLE_CLASS_SEEDS, type BaseVehicle, type VehicleClass } from "./pricing/vehicle-classes";

/** The speed-table key of a job's vehicle (a class code, or a legacy value); unknown / null = motorcycle. */
export function jobBaseVehicle(
  vehicle: string | null | undefined,
  classes: readonly Pick<VehicleClass, "code" | "base_vehicle">[] = VEHICLE_CLASS_SEEDS
): BaseVehicle {
  const base = classes.find((c) => c.code === vehicle)?.base_vehicle;
  return base ?? (vehicle === "bicycle" ? "bicycle" : "motorcycle");
}

/** formula.speed_kmh for the job's base vehicle. */
export const jobSpeedKmh = (
  formula: FareFormula,
  vehicle: string | null | undefined,
  classes?: readonly Pick<VehicleClass, "code" | "base_vehicle">[]
) => formula.speed_kmh[jobBaseVehicle(vehicle, classes)];

/**
 * Minutes a job takes: drive time at the base vehicle's speed, plus
 * `stop_minutes` per courier drop-off (`stops`) and `boarding_minutes` for a ride.
 */
export function jobDurationMinutes(
  km: number,
  opts: {
    formula?: FareFormula;
    /** orders.vehicle_type (class code); null / unknown = motorcycle. */
    vehicle?: string | null;
    classes?: readonly Pick<VehicleClass, "code" | "base_vehicle">[];
    stops?: number;
    ride?: boolean;
  } = {}
) {
  const formula = opts.formula ?? SEED_FORMULA;
  const drive = driveMinutes(km, jobSpeedKmh(formula, opts.vehicle, opts.classes));
  const extra = (opts.stops ?? 0) * formula.stop_minutes + (opts.ride ? formula.boarding_minutes : 0);
  return Math.max(1, Math.round(drive + extra));
}
