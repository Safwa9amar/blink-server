import { marketplaceSlugs } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createMerchantStoreSchema, MerchantStoreResponse } from "../../validators/merchant";
import { normalizeStore, ownedStores } from "./shared";

const app = router();

// ─── Merchant: create a store (lands under review) ───────────────────
const route = createRoute({
  method: "post",
  path: "/stores",
  operationId: "createMerchantStore",
  tags: ["merchant"],
  security: bearer,
  request: { body: { ...json(createMerchantStoreSchema), required: true } },
  responses: {
    201: json(MerchantStoreResponse, "Created"),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  // Blink's verdicts aren't the merchant's to set (the body schema has no such
  // column; drop it here too in case it ever grows one): documents start pending.
  const valid = c.req.valid("json");
  const {
    document_review: _documentReview,
    documents_status: _documentsStatus,
    ...body
  } = valid as typeof valid & { document_review?: unknown; documents_status?: unknown };
  const existing = await ownedStores(user.id);

  const { data, error } = await supabaseAdmin
    .from("stores")
    .insert({
      ...body,
      owner_id: user.id,
      image: body.image ?? "",
      status: "under_review",
      is_open: false,
      // The merchant's first store is their primary one.
      is_primary: existing.length === 0,
      is_supermarket: marketplaceSlugs(body.category_slugs).includes("supermarket"),
    })
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: error?.message ?? "Could not create store" }, 400);
  }

  return c.json(
    { store: { ...normalizeStore(data), total_sales: 0, orders_count: 0 } as any },
    201
  );
});

export default app;
