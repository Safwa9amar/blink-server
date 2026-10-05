import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { AddressResponse, updateAddressSchema } from "../../validators/addresses";

const app = router();

// ─── Update address ──────────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateAddress",
  tags: ["addresses"],
  security: bearer,
  request: { params: IdParam, body: { ...json(updateAddressSchema), required: true } },
  responses: { 200: json(AddressResponse), 400: errorResponses[400], 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: addressId } = c.req.valid("param");
  const body = c.req.valid("json");

  if (body.is_default) {
    await supabaseAdmin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", user.id);
  }

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .update(body)
    .eq("id", addressId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Address not found" }, 404);
  }

  return c.json({ address: data }, 200);
});

export default app;
