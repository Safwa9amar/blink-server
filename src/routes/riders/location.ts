import { releaseRiderRequests } from "../../lib/dispatch";
import { RIDER_NOT_VERIFIED } from "../../lib/rider-access";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, json, OkSchema, router } from "../../openapi";
import { riderLocationSchema } from "../../validators/merchant";
import { RiderNotVerifiedError } from "../../validators/riders";

const app = router();

// ─── Rider: report position + availability ───────────────────────────
// Sent by the rider app while it's open; merchants use it to find the
// nearest available Blink rider for an order.
const route = createRoute({
  method: "patch",
  path: "/location",
  operationId: "updateRiderLocation",
  tags: ["riders"],
  security: bearer,
  request: { body: { ...json(riderLocationSchema), required: true } },
  responses: {
    200: json(OkSchema),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(RiderNotVerifiedError, "Forbidden / rider not verified"),
    503: json(ErrorSchema, "Service unavailable"),
  },
});

// Best-effort: the road driven so far is appended to the orders the rider is
// carrying; a failure must never fail the ping.
async function saveRoutePath(riderId: string, path: [number, number][] | undefined) {
  if (!path?.length) return;
  const { error } = await supabaseAdmin.rpc("append_rider_route_path", {
    p_rider: riderId,
    p_points: path,
  });
  if (error) console.warn("[riders/location] route path not saved:", error.message);
}

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const patch: Record<string, unknown> = {
    latitude: body.latitude,
    longitude: body.longitude,
    location_updated_at: new Date().toISOString(),
  };
  if (body.is_available !== undefined) patch.is_available = body.is_available;

  // Going online is one conditional write (approved riders only): a ping must
  // not be a second way online, and there's no check-then-write race.
  if (body.is_available === true) {
    const { data: on, error: onError } = await supabaseAdmin
      .from("rider_profiles")
      .update(patch)
      .eq("user_id", user.id)
      .eq("verification_status", "approved")
      .select("user_id")
      .maybeSingle();
    if (onError) return c.json({ error: "Service unavailable, please retry" }, 503);
    if (!on) return c.json(RIDER_NOT_VERIFIED, 403);
    await saveRoutePath(user.id, body.path);
    return c.json({ success: true }, 200);
  }

  const { error } = await supabaseAdmin
    .from("rider_profiles")
    .update(patch)
    .eq("user_id", user.id);
  if (error) return c.json({ error: error.message }, 400);
  // Going offline: stores waiting on this rider can pick someone else.
  if (body.is_available === false) await releaseRiderRequests(user.id);
  await saveRoutePath(user.id, body.path);
  return c.json({ success: true }, 200);
});

export default app;
