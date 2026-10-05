import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { upsertVehicleSchema, VehicleResponse } from "../../validators/riders";

const app = router();

// ─── Create or update vehicle ────────────────────────────────────────
const route = createRoute({
  method: "put",
  path: "/vehicle",
  operationId: "upsertRiderVehicle",
  tags: ["riders"],
  security: bearer,
  request: { body: { ...json(upsertVehicleSchema), required: true } },
  responses: {
    200: json(VehicleResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Check if vehicle exists
  const { data: existing } = await supabaseAdmin
    .from("vehicles")
    .select("id")
    .eq("user_id", user.id)
    .single();

  let result;
  if (existing) {
    result = await supabaseAdmin
      .from("vehicles")
      .update(body)
      .eq("user_id", user.id)
      .select()
      .single();
  } else {
    result = await supabaseAdmin
      .from("vehicles")
      .insert({
        ...body,
        user_id: user.id,
        gray_card_status: "not_uploaded",
        insurance_status: "not_uploaded",
        driving_license_status: "not_uploaded",
      })
      .select()
      .single();
  }

  if (result.error) {
    return c.json({ error: result.error.message }, 400);
  }

  return c.json({ vehicle: result.data }, 200);
});

export default app;
