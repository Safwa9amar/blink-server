import { normalizeStoreMenu, toStorefront } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { StoreResponse } from "../../validators/marketplace";

const app = router();

// ─── Get store (with its products) ───────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}",
  operationId: "getStore",
  tags: ["marketplace"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(StoreResponse), 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("stores")
    .select("*, products:store_products(*)")
    .eq("id", id)
    .eq("status", "active")
    .eq("store_products.is_available", true)
    // Manual merchant products only surface once staff approved them.
    .eq("store_products.review_status", "approved")
    .order("sort_order", { referencedTable: "store_products", ascending: true })
    .maybeSingle();

  if (error || !data) {
    return c.json({ error: "Store not found" }, 404);
  }

  // Merchant-managed stores name categories freely — map them onto the
  // menu-category ids the app filters by.
  const { menu, products } = normalizeStoreMenu(data.menu_categories, data.products ?? []);
  return c.json({ store: { ...toStorefront(data), menu_categories: menu, products } }, 200);
});

export default app;
