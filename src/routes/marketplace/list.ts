import { slugsMatching, toStorefront } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listStoresSchema, StoreListResponse } from "../../validators/marketplace";

const app = router();

// ─── List stores ─────────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/stores",
  operationId: "listStores",
  tags: ["marketplace"],
  security: bearer,
  request: { query: listStoresSchema },
  responses: { 200: json(StoreListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const { category, featured, q } = c.req.valid("query");

  let query = supabaseAdmin
    .from("stores")
    .select("*")
    .eq("status", "active")
    .order("is_featured", { ascending: false })
    .order("rating", { ascending: false });

  // Merchant stores carry their own store type (grocery, bakery…) — match
  // every type that maps onto the requested marketplace category.
  if (category && category !== "all_stores") {
    query = query.overlaps("category_slugs", slugsMatching(category));
  }
  if (featured !== undefined) query = query.eq("is_featured", featured);
  if (q) query = query.ilike("name", `%${q}%`);

  const { data, error } = await query;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ stores: (data ?? []).map((s) => toStorefront(s)) }, 200);
});

export default app;
