import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { OptionalVehicleResponse } from "../../validators/riders";

const app = router();

// ─── Get vehicle ─────────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/vehicle",
  operationId: "getRiderVehicle",
  tags: ["riders"],
  security: bearer,
  responses: {
    200: json(OptionalVehicleResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("vehicles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error) {
    return c.json({ vehicle: null }, 200);
  }

  return c.json({ vehicle: data }, 200);
});

export default app;
