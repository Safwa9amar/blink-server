import { storeDeliveryModes } from "../../lib/pricing/store-quote";
import { normalizeStoreMenu, toStorefront } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { getStoreSchema, StoreResponse } from "../../validators/marketplace";

const app = router();

// ─── Get store (with its products) ───────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}",
  operationId: "getStore",
  tags: ["marketplace"],
  security: bearer,
  request: { params: IdParam, query: getStoreSchema },
  responses: { 200: json(StoreResponse), 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const { products: withProducts } = c.req.valid("query");

  // Without products the menu chips still need every product's category —
  // read just those two columns (rows are paged by GET /stores/{id}/products).
  const { data, error } = await supabaseAdmin
    .from("stores")
    .select(
      withProducts
        ? "*, products:store_products(*)"
        : "*, products:store_products(category, menu_category)"
    )
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
  const { products: rows, ...row } = data;
  const { menu, products } = normalizeStoreMenu(row.menu_categories, rows ?? []);
  return c.json(
    {
      store: {
        ...toStorefront(row),
        delivery_fee_mode: (await storeDeliveryModes([row])).get(row.id) ?? ("merchant" as const),
        menu_categories: menu,
        ...(withProducts ? { products } : {}),
      },
    },
    200
  );
});

export default app;
