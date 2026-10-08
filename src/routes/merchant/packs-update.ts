import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { PackResponse, updatePackSchema } from "../../validators/merchant";
import { ownedPack } from "./shared";

const app = router();

// ─── Merchant: update a pack (details, items, status) ────────────────
const route = createRoute({
  method: "patch",
  path: "/packs/{id}",
  operationId: "updateMerchantPack",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam, body: { ...json(updatePackSchema), required: true } },
  responses: {
    200: json(PackResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const pack = await ownedPack(user.id, id);
  if (!pack) return c.json({ error: "Pack not found" }, 404);

  if (body.items) {
    const ids = [...new Set(body.items.map((i) => i.product_id))];
    const { count } = await supabaseAdmin
      .from("store_products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", pack.store_id)
      .in("id", ids);
    if ((count ?? 0) !== ids.length) {
      return c.json({ error: "Pack items must be products of this store" }, 400);
    }
  }

  // Turning free delivery on (or re-activating a free-delivery pack still in
  // review) sends the pack back to staff review.
  const patch: Record<string, unknown> = { ...body };
  const freeDelivery = body.free_delivery ?? pack.free_delivery;
  if (body.free_delivery && !pack.free_delivery) patch.status = "under_review";
  else if (body.status === "active" && freeDelivery && pack.status === "under_review") {
    delete patch.status;
  }

  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Pack not found" }, 400);
  return c.json({ pack: data }, 200);
});

export default app;
