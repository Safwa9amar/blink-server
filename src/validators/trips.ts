import { z } from "@hono/zod-openapi";
import { trips } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

const tripStatus = z.enum(["upcoming", "completed", "under_review", "canceled"]);

/** Customer embedded in trip responses (PostgREST `customer:users!…` join). */
export const TRIP_SELECT =
  "*, customer:users!trips_customer_id_fkey(first_name, last_name, phone_number, profile_picture)";

export const TripCustomerSchema = z
  .object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    phone_number: z.string().nullable(),
    profile_picture: z.string().nullable(),
  })
  .openapi("TripCustomer");

export const TripSchema = rowSchema(trips, "TripRow")
  .extend({ customer: TripCustomerSchema.nullable().optional() })
  .openapi("Trip");

export const createTripSchema = z
  .object({
    customer_id: z.string().uuid(),
    pickup_label: z.string().min(1),
    pickup_address: z.string().min(1),
    pickup_lat: z.number(),
    pickup_lng: z.number(),
    dropoff_label: z.string().min(1),
    dropoff_address: z.string().min(1),
    dropoff_lat: z.number(),
    dropoff_lng: z.number(),
    estimated_payout: z.number().positive(),
    distance_km: z.number().positive(),
    duration_minutes: z.number().positive(),
  })
  .openapi("CreateTripBody");

export const updateTripStatusSchema = z
  .object({
    status: tripStatus,
    cancellation_reason: z.string().optional(),
    notes: z.string().optional(),
  })
  .openapi("UpdateTripStatusBody");

export const listTripsSchema = z.object({
  status: tripStatus.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export const TripResponse = z.object({ trip: TripSchema }).openapi("TripResponse");
export const TripListResponse = z
  .object({ trips: z.array(TripSchema), pagination: PaginationSchema })
  .openapi("TripListResponse");
