import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AddressListResponse } from "../../validators/addresses";

const app = router();

// ─── List addresses ──────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listAddresses",
  tags: ["addresses"],
  security: bearer,
  responses: { 200: json(AddressListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .select("*")
    .eq("user_id", user.id)
    .order("is_default", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ addresses: data }, 200);
});

export default app;
