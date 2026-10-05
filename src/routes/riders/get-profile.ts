import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { RiderProfileResponse } from "../../validators/riders";

const app = router();

// ─── Get rider profile ───────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/profile",
  operationId: "getRiderProfile",
  tags: ["riders"],
  security: bearer,
  responses: {
    200: json(RiderProfileResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return c.json({ error: "Rider profile not found" }, 404);
  }

  return c.json({ profile: data }, 200);
});

export default app;
