import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { nearbyAgentsQuery, NearbyAgentsResponse } from "../../validators/agents";

const app = router();

const MAX_RESULTS = 20;

/** Great-circle distance in km. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// ─── Public: list nearby agents (for rider agent locator) ────────────
// Open, staff-verified shops with a name, closest first.
const route = createRoute({
  method: "get",
  path: "/nearby",
  operationId: "getNearbyAgents",
  tags: ["agents"],
  security: bearer,
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

  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .select("*, users!inner(first_name, last_name, profile_picture)")
    .eq("status", "open")
    .eq("review_status", "active")
    .neq("shop_name", "")
    .limit(500);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const agents = (data ?? [])
    .map((s) => ({
      ...s,
      documents: s.documents ?? {},
      distance_km:
        s.latitude || s.longitude
          ? Math.round(haversineKm(lat, lng, s.latitude, s.longitude) * 10) / 10
          : undefined,
    }))
    .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity))
    .slice(0, MAX_RESULTS);

  return c.json({ agents }, 200);
});

export default app;
