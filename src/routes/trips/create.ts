import { tripPayout } from "../../lib/cash-jobs";
import { riderRates } from "../../lib/dispatch";
import { rideDuration, rideFare, rideKm, rideRouteError } from "../../lib/ride-pricing";
import { rideFareConfig } from "../../lib/pricing/fare-config";
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

  // The payout, distance and duration are priced here from the coordinates
  // (motorcycle ride fare + the configured commission), never from the body.
  const pickup = { lat: body.pickup_lat, lng: body.pickup_lng };
  const dropoff = { lat: body.dropoff_lat, lng: body.dropoff_lng };
  const cfg = await rideFareConfig(pickup, dropoff);
  const km = rideKm(pickup, dropoff, cfg.formula);
  if (rideRouteError(pickup, dropoff, cfg.rates, "motorcycle", cfg.formula)) {
    return c.json({ error: "Route too short or too long for a trip" }, 400);
  }
  const fare = rideFare("motorcycle", km, cfg.rates, cfg.multiplier, { formula: cfg.formula, surcharge: cfg.surcharge });
  const { commissionRate } = await riderRates({ type: "ride" }, pickup);

  const displayId = `BK-${Math.floor(1000 + Math.random() * 9000)}`;

  const { data, error } = await supabaseAdmin
    .from("trips")
    .insert({
      customer_id: body.customer_id,
      pickup_label: body.pickup_label,
      pickup_address: body.pickup_address,
      pickup_lat: body.pickup_lat,
      pickup_lng: body.pickup_lng,
      dropoff_label: body.dropoff_label,
      dropoff_address: body.dropoff_address,
      dropoff_lat: body.dropoff_lat,
      dropoff_lng: body.dropoff_lng,
      ...tripPayout(fare, commissionRate),
      commission_rate: commissionRate,
      distance_km: km,
      duration_minutes: rideDuration("motorcycle", km, cfg.formula),
      rider_id: userId,
      display_id: displayId,
      status: "upcoming",
    })
    .select(TRIP_SELECT)
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ trip: data }, 201);
});

export default app;
