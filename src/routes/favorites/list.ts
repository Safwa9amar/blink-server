import { toStorefront } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { FavoriteListResponse } from "../../validators/favorites";

const app = router();

// ─── List my favorites (ids + resolved stores/products) ──────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listFavorites",
  tags: ["favorites"],
  security: bearer,
  responses: { 200: json(FavoriteListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data: favs, error } = await supabaseAdmin
    .from("customer_favorites")
    .select("target_type, target_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const storeIds = (favs ?? []).filter((f) => f.target_type === "store").map((f) => f.target_id);
  const productIds = (favs ?? []).filter((f) => f.target_type === "product").map((f) => f.target_id);

  const [stores, products] = await Promise.all([
    storeIds.length
      ? supabaseAdmin.from("stores").select("*").in("id", storeIds).eq("status", "active")
      : Promise.resolve({ data: [] as any[] }),
    productIds.length
      ? supabaseAdmin.from("store_products").select("*, store:stores(name)").in("id", productIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  // Dangling ids (deleted store/product) drop out here.
  const storeRows = (stores.data ?? []).map((s: any) => toStorefront(s));
  const productRows = (products.data ?? []).map(({ store, ...p }: any) => ({
    ...p,
    store_name: store?.name ?? "",
  }));

  return c.json(
    {
      store_ids: storeRows.map((s: any) => s.id),
      product_ids: productRows.map((p: any) => p.id),
      stores: storeRows,
      products: productRows,
    },
    200
  );
});

export default app;
