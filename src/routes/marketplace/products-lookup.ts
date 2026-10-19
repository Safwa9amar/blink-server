import { normalizeStoreMenu } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { LookupProductsResponse, lookupProductsSchema } from "../../validators/marketplace";

const app = router();

// ─── Refresh products by id (cart prices) ────────────────────────────
const route = createRoute({
  method: "post",
  path: "/products/lookup",
  operationId: "lookupMarketplaceProducts",
  tags: ["marketplace"],
  security: bearer,
  request: { body: { ...json(lookupProductsSchema), required: true } },
  responses: {
    200: json(LookupProductsResponse, "The ids a customer can order, with their live price; unknown or hidden ids are absent"),
    400: errorResponses[400],
  },
});

app.openapi(route, async (c) => {
  const { ids } = c.req.valid("json");

  // Same visibility as GET /stores/{id}/products: an active store's available
  // products, manual merchant products only once staff approved them.
  const { data, error } = await supabaseAdmin
    .from("store_products")
    .select("*, store:stores!inner(status)")
    .in("id", ids)
    .eq("is_available", true)
    .eq("review_status", "approved")
    .eq("store.status", "active");
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const rows = (data ?? []).map(({ store: _store, ...product }) => product);
  const { products } = normalizeStoreMenu(null, rows);
  return c.json({ products }, 200);
});

export default app;
