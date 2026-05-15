import { z } from "zod";

export const createTripSchema = z.object({
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
});

export const updateTripStatusSchema = z.object({
  status: z.enum(["upcoming", "completed", "under_review", "canceled"]),
  cancellation_reason: z.string().optional(),
  notes: z.string().optional(),
});

export const listTripsSchema = z.object({
  status: z.enum(["upcoming", "completed", "under_review", "canceled"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
