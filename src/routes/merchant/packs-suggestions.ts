import { buildPackSuggestions } from "../../lib/pack-suggestions";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { PackSuggestionsResponse } from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

const WINDOW_DAYS = 60;

// ─── Merchant: pack ideas from the store's catalog + recent orders ───
// Rule-based (src/lib/pack-suggestions.ts); the app localizes each by kind.
const route = createRoute({
  method: "get",
  path: "/stores/{id}/pack-suggestions",
  operationId: "listMerchantPackSuggestions",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(PackSuggestionsResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  if (!(await ownedStore(user.id, id))) return c.json({ error: "Store not found" }, 404);

  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
  const [{ data: products }, { data: orders }, { data: packs }] = await Promise.all([
    supabaseAdmin
      .from("store_products")
      .select("id, title, price, image, photos, category, is_available, review_status")
      .eq("store_id", id),
    supabaseAdmin
      .from("orders")
      .select("items")
      .eq("store_id", id)
      .eq("status", "delivered")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabaseAdmin.from("store_packs").select("status, items").eq("store_id", id).neq("status", "archived"),
  ]);

  return c.json({ suggestions: buildPackSuggestions(products ?? [], orders ?? [], packs ?? []) }, 200);
});

export default app;
