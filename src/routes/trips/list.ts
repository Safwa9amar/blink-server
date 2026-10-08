import { isActiveTrip } from "../../lib/rider-card";
import { attachRiders, attachTripCosts } from "../../lib/rider-cards-load";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listTripsSchema, TripListResponse, TRIP_SELECT } from "../../validators/trips";

const app = router();

// ─── List trips (rider sees their trips, customer sees theirs) ───────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listTrips",
  tags: ["trips"],
  security: bearer,
  request: { query: listTripsSchema },
  responses: { 200: json(TripListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { page, limit, status } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const column = user.role === "rider" ? "rider_id" : "customer_id";

  let q = supabaseAdmin
    .from("trips")
    .select(TRIP_SELECT, { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    q = q.eq("status", status);
  }

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // A customer's own trips: who delivered them + the fare split.
  const trips =
    column === "customer_id"
      ? await attachTripCosts(await attachRiders(data ?? [], isActiveTrip))
      : data;

  return c.json(
    {
      trips,
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
