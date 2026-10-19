import { withoutPriceAttribution } from "../../lib/price-history";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantProductListResponse } from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: a store's products (all review states) ────────────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}/products",
  operationId: "listMerchantProducts",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(MerchantProductListResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  if (!(await ownedStore(user.id, id))) return c.json({ error: "Store not found" }, 404);

  const { data, error } = await supabaseAdmin
    .from("store_products")
    .select("*")
    .eq("store_id", id)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 404);
  return c.json({ products: (data ?? []).map(withoutPriceAttribution) }, 200);
});

export default app;
