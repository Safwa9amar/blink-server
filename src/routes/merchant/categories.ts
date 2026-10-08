// Per-store product categories (Product Management → Categories).
// The ordered list lives on stores.menu_categories ([{id, title}]); products
// reference a category by name (store_products.category).
import { categorySlug } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { saveCategoriesSchema, StoreCategoryListResponse } from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

async function listCategories(storeId: string, menu: { id: string; title: string }[]) {
  const { data } = await supabaseAdmin
    .from("store_products")
    .select("category")
    .eq("store_id", storeId);
  const counts = new Map<string, number>();
  for (const p of data ?? []) {
    if (!p.category) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  const names = menu.map((m) => m.title);
  // Categories used by products but not yet in the list come after it.
  for (const name of counts.keys()) if (!names.includes(name)) names.push(name);
  return names.map((name) => ({ name, product_count: counts.get(name) ?? 0 }));
}

app.openapi(
  createRoute({
    method: "get",
    path: "/stores/{id}/categories",
    operationId: "listStoreCategories",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(StoreCategoryListResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const store = await ownedStore(user.id, id);
    if (!store) return c.json({ error: "Store not found" }, 404);
    const menu = (store.menu_categories as { id: string; title: string }[]) ?? [];
    return c.json({ categories: await listCategories(id, menu) }, 200);
  }
);

// Save the ordered list. Renamed categories are renamed on products too;
// products in a category that was removed become uncategorised.
app.openapi(
  createRoute({
    method: "put",
    path: "/stores/{id}/categories",
    operationId: "saveStoreCategories",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam, body: { ...json(saveCategoriesSchema), required: true } },
    responses: {
      200: json(StoreCategoryListResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { categories, renames = [] } = c.req.valid("json");
    const store = await ownedStore(user.id, id);
    if (!store) return c.json({ error: "Store not found" }, 404);

    const unique = [...new Set(categories)];
    for (const r of renames) {
      if (r.from === r.to) continue;
      await supabaseAdmin
        .from("store_products")
        .update({ category: r.to })
        .eq("store_id", id)
        .eq("category", r.from);
    }
    const before = await listCategories(id, []);
    const removed = before.map((b) => b.name).filter((n) => !unique.includes(n));
    if (removed.length) {
      await supabaseAdmin
        .from("store_products")
        .update({ category: "" })
        .eq("store_id", id)
        .in("category", removed);
    }

    const menu = unique.map((title, i) => ({ id: categorySlug(title, `cat-${i}`), title }));
    const { error } = await supabaseAdmin.from("stores").update({ menu_categories: menu }).eq("id", id);
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ categories: await listCategories(id, menu) }, 200);
  }
);

export default app;
