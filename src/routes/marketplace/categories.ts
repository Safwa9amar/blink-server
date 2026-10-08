import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { MarketplaceCategoryListResponse } from "../../validators/marketplace";

const app = router();

// ─── List marketplace categories ─────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/categories",
  operationId: "listMarketplaceCategories",
  tags: ["marketplace"],
  security: bearer,
  responses: { 200: json(MarketplaceCategoryListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const { data, error } = await supabaseAdmin
    .from("marketplace_categories")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ categories: data }, 200);
});

export default app;
