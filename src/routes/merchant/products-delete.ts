import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, OkSchema, router } from "../../openapi";
import { ownedProduct } from "./shared";

const app = router();

// ─── Merchant: remove a product from a store ─────────────────────────
const route = createRoute({
  method: "delete",
  path: "/products/{id}",
  operationId: "deleteMerchantProduct",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(OkSchema),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  if (!(await ownedProduct(user.id, id))) return c.json({ error: "Product not found" }, 404);

  const { error } = await supabaseAdmin.from("store_products").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 404);
  return c.json({ success: true }, 200);
});

export default app;
