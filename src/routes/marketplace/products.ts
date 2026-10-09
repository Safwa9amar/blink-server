import {
  menuCategoryFilter,
  normalizeStoreMenu,
  productSearchFilter,
} from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { listStoreProductsSchema, StoreProductListResponse } from "../../validators/marketplace";

const app = router();

// ─── List a store's products, a page at a time ───────────────────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}/products",
  operationId: "listStoreProducts",
  tags: ["marketplace"],
  security: bearer,
  request: { params: IdParam, query: listStoreProductsSchema },
  responses: {
    200: json(StoreProductListResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const { page, limit, category, q } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const { data: store } = await supabaseAdmin
    .from("stores")
    .select("id")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();
  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  const filters: string[] = [];
  if (category && category !== "all") {
    // Untagged merchant products match by category name (see menuCategoryFilter).
    const { data: names } = await supabaseAdmin
      .from("store_products")
      .select("category")
      .eq("store_id", id)
      .eq("is_available", true)
      .eq("review_status", "approved")
      .is("menu_category", null);
    filters.push(menuCategoryFilter(category, (names ?? []).map((r) => r.category)));
  }
  const term = q?.trim();
  if (term) filters.push(productSearchFilter(term));

  // Same visibility as GET /stores/{id}: available, and manual merchant
  // products only once staff approved them.
  const matching = (head: boolean) => {
    const query = supabaseAdmin
      .from("store_products")
      .select("*", { count: "exact", head })
      .eq("store_id", id)
      .eq("is_available", true)
      .eq("review_status", "approved");
    return filters.length ? query.or(`and(${filters.join(",")})`) : query;
  };

  const { data, error, count } = await matching(false)
    // `id` breaks sort_order ties so pages never overlap.
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  // A page past the end is an empty page, not an error.
  if (error?.code === "PGRST103") {
    const { count: total } = await matching(true);
    return c.json({ products: [], pagination: { page, limit, total: total ?? 0 } }, 200);
  }
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const { products } = normalizeStoreMenu(null, data ?? []);
  return c.json({ products, pagination: { page, limit, total: count ?? 0 } }, 200);
});

export default app;
