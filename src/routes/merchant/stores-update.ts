import { marketplaceSlugs } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantStoreResponse, updateMerchantStoreSchema } from "../../validators/merchant";
import { normalizeStore, ownedStore, storeSalesStats } from "./shared";

const app = router();

// ─── Merchant: update own store (settings, open/closed, hours, docs) ─
const route = createRoute({
  method: "patch",
  path: "/stores/{id}",
  operationId: "updateMerchantStore",
  tags: ["merchant"],
  security: bearer,
  request: {
    params: IdParam,
    body: { ...json(updateMerchantStoreSchema), required: true },
  },
  responses: {
    200: json(MerchantStoreResponse),
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

  const store = await ownedStore(user.id, id);
  if (!store) return c.json({ error: "Store not found" }, 404);

  // Only one primary store per merchant.
  if (body.is_primary) {
    await supabaseAdmin
      .from("stores")
      .update({ is_primary: false })
      .eq("owner_id", user.id)
      .neq("id", id);
  }

  // Review state isn't the merchant's to set: staff decide it (PATCH
  // /merchant/admin/stores/{id}/status and …/documents) and the merchant only
  // resubmits (POST /merchant/stores/{id}/resubmit). The body schema has none
  // of these columns; drop them here too in case it ever grows them. A new
  // document value is simply pending again (verdicts are matched by value).
  const {
    status: _status,
    review_note: _reviewNote,
    document_review: _documentReview,
    documents_status: _documentsStatus,
    ...patch
  } = { ...body } as Record<string, unknown>;
  if (body.category_slugs) patch.is_supermarket = marketplaceSlugs(body.category_slugs).includes("supermarket");

  const { data, error } = await supabaseAdmin
    .from("stores")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: error?.message ?? "Store not found" }, 400);
  }

  const stats = await storeSalesStats([id]);
  return c.json({ store: { ...normalizeStore(data), ...stats.get(id)! } as any }, 200);
});

export default app;
