import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AddressResponse, createAddressSchema } from "../../validators/addresses";

const app = router();

// ─── Create address ──────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/",
  operationId: "createAddress",
  tags: ["addresses"],
  security: bearer,
  request: { body: { ...json(createAddressSchema), required: true } },
  responses: { 201: json(AddressResponse, "Created"), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // If this is set as default, unset others
  if (body.is_default) {
    await supabaseAdmin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", user.id);
  }

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .insert({ ...body, user_id: user.id })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ address: data }, 201);
});

export default app;
