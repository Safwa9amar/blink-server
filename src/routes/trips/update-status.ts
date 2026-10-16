import { supabaseAdmin } from "../../lib/supabase";
import { fundedDiscountForOrder, postTripToLedger } from "../../lib/wallet";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { TripResponse, updateTripStatusSchema, TRIP_SELECT } from "../../validators/trips";

const app = router();

// ─── Update trip status ──────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/{id}/status",
  operationId: "updateTripStatus",
  tags: ["trips"],
  security: bearer,
  request: { params: IdParam, body: { ...json(updateTripStatusSchema), required: true } },
  responses: { 200: json(TripResponse), 400: errorResponses[400], 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: tripId } = c.req.valid("param");
  const body = c.req.valid("json");

  // Verify ownership
  const { data: existing } = await supabaseAdmin
    .from("trips")
    .select("rider_id, customer_id")
    .eq("id", tripId)
    .single();

  if (!existing || (existing.rider_id !== user.id && existing.customer_id !== user.id)) {
    return c.json({ error: "Trip not found or access denied" }, 404);
  }

  const { data, error } = await supabaseAdmin
    .from("trips")
    .update(body)
    .eq("id", tripId)
    .select(TRIP_SELECT)
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // Keep the Blink Cash ledger in step with the derived balance (idempotent per trip).
  if (body.status === "completed") {
    const { data: full } = await supabaseAdmin.from("trips").select("*").eq("id", tripId).maybeSingle();
    await postTripToLedger(full, await fundedDiscountForOrder(full?.order_id));
  }

  return c.json({ trip: data }, 200);
});

export default app;
