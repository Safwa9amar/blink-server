import { z } from "@hono/zod-openapi";
import { RiderProfileSchema, VehicleSchema } from "./auth";

// Only rider-specific fields. Common fields (wilaya, bank_rib) are on users and
// saved via PATCH /auth/profile.
export const updateRiderProfileSchema = z
  .object({
    vehicle_type: z.enum(["bicycle", "motorcycle"]).optional(),
  })
  .openapi("UpdateRiderProfileBody");

export const upsertVehicleSchema = z
  .object({
    brand: z.string().min(1),
    model: z.string().min(1),
    license_plate: z.string().min(1),
    year: z.string().min(1),
    color: z.string().min(1),
    category: z.enum(["standard", "electric", "hybrid"]),
  })
  .openapi("UpsertVehicleBody");

export const RiderProfileResponse = z
  .object({ profile: RiderProfileSchema })
  .openapi("RiderProfileResponse");

export const VehicleResponse = z
  .object({ vehicle: VehicleSchema })
  .openapi("VehicleResponse");

/** GET /riders/vehicle — `vehicle` is null when the rider has none yet. */
export const OptionalVehicleResponse = z
  .object({ vehicle: VehicleSchema.nullable() })
  .openapi("OptionalVehicleResponse");
