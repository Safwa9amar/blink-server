import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { AddressDeletedResponse } from "../../validators/addresses";

const app = router();

// ─── Delete address ──────────────────────────────────────────────────
const route = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteAddress",
  tags: ["addresses"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(AddressDeletedResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: addressId } = c.req.valid("param");

  const { error } = await supabaseAdmin
    .from("addresses")
    .delete()
    .eq("id", addressId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Address deleted" }, 200);
});

export default app;
