import { z } from "@hono/zod-openapi";
import { AgentProfileSchema, AgentShopSchema } from "./auth";

export const updateShopSchema = z
  .object({
    shop_name: z.string().min(1).optional(),
    phone_number: z.string().optional(),
    open_time: z.string().optional(),
    close_time: z.string().optional(),
    status: z.enum(["open", "closed"]).optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    address: z.string().optional(),
  })
  .openapi("UpdateAgentShopBody");

export const nearbyAgentsQuery = z.object({
  lat: z.coerce
    .number()
    .openapi({ type: "number", param: { name: "lat", in: "query", required: true } }),
  lng: z.coerce
    .number()
    .openapi({ type: "number", param: { name: "lng", in: "query", required: true } }),
});

/** Agent shop with its owner embedded (PostgREST `users!inner(...)` join). */
export const NearbyAgentSchema = AgentShopSchema.extend({
  users: z.object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    profile_picture: z.string().nullable(),
  }),
}).openapi("NearbyAgent");

export const NearbyAgentsResponse = z
  .object({ agents: z.array(NearbyAgentSchema) })
  .openapi("NearbyAgentsResponse");

export const AgentShopResponse = z
  .object({ shop: AgentShopSchema })
  .openapi("AgentShopResponse");

export const AgentProfileResponse = z
  .object({ profile: AgentProfileSchema })
  .openapi("AgentProfileResponse");
