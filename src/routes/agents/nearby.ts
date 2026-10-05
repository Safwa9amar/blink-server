import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { nearbyAgentsQuery, NearbyAgentsResponse } from "../../validators/agents";

const app = router();

// ─── Public: list nearby agents (for rider agent locator) ────────────
const route = createRoute({
  method: "get",
  path: "/nearby",
  operationId: "getNearbyAgents",
  tags: ["agents"],
  security: bearer,
  middleware: [auth] as const,
  request: { query: nearbyAgentsQuery },
  responses: {
    200: json(NearbyAgentsResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { lat, lng } = c.req.valid("query");

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "lat and lng query params are required" }, 400);
  }

  // For now, return all open agents — in production use PostGIS for distance
  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .select("*, users!inner(first_name, last_name, profile_picture)")
    .eq("status", "open")
    .limit(20);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ agents: data }, 200);
});

export default app;
