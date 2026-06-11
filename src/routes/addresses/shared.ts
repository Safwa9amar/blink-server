// Shared validation schemas for the address endpoints.
import { z } from "zod";

export const createAddressSchema = z.object({
  label: z.string().min(1),
  address: z.string().min(1),
  type: z.enum(["home", "work", "other"]),
  latitude: z.number(),
  longitude: z.number(),
  street: z.string().optional(),
  street_number: z.string().optional(),
  floor_apt: z.string().optional(),
  directions: z.string().optional(),
  is_default: z.boolean().default(false),
});

export const updateAddressSchema = createAddressSchema.partial();
