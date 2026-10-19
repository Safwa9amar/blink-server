// A product's price history (Coca: 100 DA until 15 Oct, then 80 DA), read from
// store_product_price_changes — filled by a DB trigger, never by this route.
import { toPriceChange } from "../../lib/price-history";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { ProductPriceHistoryResponse } from "../../validators/merchant";
import { ownedProduct } from "./shared";

const app = router();

const HISTORY_LIMIT = 100;

// ─── Merchant: a product's price changes, newest first ───────────────
const route = createRoute({
  method: "get",
  path: "/products/{id}/price-history",
  operationId: "getMerchantProductPriceHistory",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(ProductPriceHistoryResponse, "The latest 100 changes, newest first"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  if (!(await ownedProduct(user.id, id))) return c.json({ error: "Product not found" }, 404);

  const { data, error } = await supabaseAdmin
    .from("store_product_price_changes")
    .select("id, old_price, new_price, old_blink_price, new_blink_price, source, changed_at")
    .eq("product_id", id)
    .order("changed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw new Error(`[price-history] read failed: ${error.message}`);

  return c.json({ changes: (data ?? []).map((r) => toPriceChange(r as any)) }, 200);
});

export default app;
