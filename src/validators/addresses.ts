// Validation + response schemas for the address endpoints.
import { z } from "@hono/zod-openapi";
import { addresses } from "../db/schema";
import { rowSchema } from "../openapi";

export const createAddressSchema = z
  .object({
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
  })
  .openapi("CreateAddressBody");

export const updateAddressSchema = createAddressSchema.partial().openapi("UpdateAddressBody");

// ─── Response schemas ────────────────────────────────────────────────

export const AddressSchema = rowSchema(addresses, "Address");

export const AddressResponse = z.object({ address: AddressSchema }).openapi("AddressResponse");
export const AddressListResponse = z
  .object({ addresses: z.array(AddressSchema) })
  .openapi("AddressListResponse");
export const AddressDeletedResponse = z
  .object({ message: z.string() })
  .openapi("AddressDeletedResponse");
