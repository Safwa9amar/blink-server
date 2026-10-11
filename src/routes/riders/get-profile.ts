import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { RiderProfileDetailResponse } from "../../validators/riders";

const app = router();

// ─── Get rider profile ───────────────────────────────────────────────
// Also returns the rider's average customer rating (`orders.rider_rating`,
// POST /orders/{id}/rate-rider), averaged the same way as RiderCard.rating.
const route = createRoute({
  method: "get",
  path: "/profile",
  operationId: "getRiderProfile",
  tags: ["riders"],
  security: bearer,
  responses: {
    200: json(RiderProfileDetailResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const [{ data, error }, { data: rated }] = await Promise.all([
    supabaseAdmin.from("rider_profiles").select("*").eq("user_id", user.id).single(),
    supabaseAdmin
      .from("orders")
      .select("rider_rating")
      .eq("rider_id", user.id)
      .not("rider_rating", "is", null),
  ]);

  if (error || !data) {
    return c.json({ error: "Rider profile not found" }, 404);
  }

  const ratings = (rated ?? []).map((r) => Number(r.rider_rating));
  const rating = ratings.length
    ? Math.round((ratings.reduce((s, x) => s + x, 0) / ratings.length) * 10) / 10
    : null;

  return c.json({ profile: data, rating, ratings_count: ratings.length }, 200);
});

export default app;
