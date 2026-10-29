// Which riders a store may list / ask for an order (pure — the routes do the I/O).
// Same rule as rider offers (riderCanTake → canTake): an exclusive vehicle class
// (Comfort) only reaches riders of that class; legacy null / bicycle / motorcycle
// jobs behave as before. Spec: specs/2026-10-29-zone-pricing-design.md, Addendum 2.
import { riderCanTake } from "./courier";
import { VEHICLE_CLASS_SEEDS, type VehicleClass } from "./pricing/vehicle-classes";

type RiderVehicle = { vehicle_type?: string | null; vehicle_class?: string | null } | null | undefined;

/**
 * Can this rider (a rider_profiles row, undefined = none) take a job of every
 * `jobVehicles` entry (orders.vehicle_type — one order, or each member of a
 * checkout)?
 */
export function riderFitsOrder(
  jobVehicles: readonly (string | null | undefined)[],
  profile: RiderVehicle,
  classes: readonly VehicleClass[] = VEHICLE_CLASS_SEEDS
) {
  const rider = { vehicleType: profile?.vehicle_type ?? null, vehicleClass: profile?.vehicle_class ?? null };
  return jobVehicles.every((v) => riderCanTake(v, rider, classes));
}

/** The 400 body when a store asks a rider the order's vehicle class excludes. */
export const VEHICLE_CLASS_REFUSAL = {
  error: "This rider's vehicle can't take this order",
  code: "vehicle_class",
} as const;
