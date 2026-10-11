import { newPackStatus } from "../../lib/pack-review";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { createPackSchema, PackResponse } from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: create a pack (bundle) ────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/stores/{id}/packs",
  operationId: "createMerchantPack",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam, body: { ...json(createPackSchema), required: true } },
  responses: {
    201: json(PackResponse, "Created"),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: storeId } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!(await ownedStore(user.id, storeId))) return c.json({ error: "Store not found" }, 404);

  // Every item must be one of this store's products.
  const ids = [...new Set(body.items.map((i) => i.product_id))];
  const { count } = await supabaseAdmin
    .from("store_products")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .in("id", ids);
  if ((count ?? 0) !== ids.length) {
    return c.json({ error: "Pack items must be products of this store" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("store_packs")
    // Free delivery is paid by Blink, so those packs wait for staff review.
    .insert({
      ...body,
      store_id: storeId,
      status: newPackStatus(body.free_delivery),
      reviewed_at: null,
      review_note: null,
    })
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Could not create pack" }, 400);
  return c.json({ pack: data }, 201);
});

export default app;
