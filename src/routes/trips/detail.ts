import { isActiveTrip } from "../../lib/rider-card";
import { attachRiders, attachTripCosts } from "../../lib/rider-cards-load";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { TripResponse, TRIP_SELECT } from "../../validators/trips";

const app = router();

// ─── Get single trip ─────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getTrip",
  tags: ["trips"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(TripResponse), 403: errorResponses[403], 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: tripId } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("trips")
    .select(TRIP_SELECT)
    .eq("id", tripId)
    .single();

  if (error || !data) {
    return c.json({ error: "Trip not found" }, 404);
  }

  // Ensure user owns this trip
  if (data.rider_id !== user.id && data.customer_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  if (data.customer_id !== user.id) return c.json({ trip: data }, 200);
  // The customer sees who delivers (phone while under way) and the fare split.
  const [withRider] = await attachRiders([data], isActiveTrip);
  const [trip] = await attachTripCosts([withRider]);
  return c.json({ trip }, 200);
});

export default app;
