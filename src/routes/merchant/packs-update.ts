import { changedColumns, resolvePackUpdate, type PackReviewState } from "../../lib/pack-review";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { CatalogError, PackResponse, updatePackSchema } from "../../validators/merchant";
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
    409: json(CatalogError, "The pack changed since it was read (code stale) — reload and retry"),
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

  // A free-delivery pack only goes live with staff approval: a material edit
  // (items / discount / free delivery) voids it and sends the pack back to
  // review; inactive → active can't skip it; a pack staff took down stays
  // down until staff approve it (src/lib/pack-review.ts).
  // The requested `status` is never written as sent: the rules decide it.
  const { sent_to_review: _sentToReview, ...review } = resolvePackUpdate(pack as PackReviewState, body);
  const { status: _requested, ...fields } = body;
  const patch: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    ...changedColumns(pack, review),
  };
  if (Object.keys(patch).length === 0) return c.json({ pack: pack as any }, 200);

  // Optimistic concurrency: only write over the row the rules were applied to.
  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .update(patch)
    .eq("id", id)
    .eq("updated_at", pack.updated_at)
    .select()
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 400);
  if (!data) {
    return c.json(
      { error: "This item changed while you were editing it. Reload and try again.", code: "stale" as const },
      409
    );
  }
  return c.json({ pack: data }, 200);
});

export default app;
