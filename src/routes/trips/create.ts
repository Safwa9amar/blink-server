import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createTripSchema, TripResponse, TRIP_SELECT } from "../../validators/trips";

const app = router();

// ─── Create trip (internal/admin) ────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/",
  operationId: "createTrip",
  tags: ["trips"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { body: { ...json(createTripSchema), required: true } },
  responses: { 201: json(TripResponse, "Created"), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");

  const displayId = `BK-${Math.floor(1000 + Math.random() * 9000)}`;

  const { data, error } = await supabaseAdmin
    .from("trips")
    .insert({
      ...body,
      rider_id: userId,
      display_id: displayId,
      status: "upcoming",
      net_payout: body.estimated_payout,
    })
    .select(TRIP_SELECT)
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ trip: data }, 201);
});

export default app;
