// Merchant "to do" list — derived from the merchant's real data so the app's
// Required Actions screen (and its badge) can't drift from it. The rules live
// in src/lib/merchant-required-actions.ts.
import { buildMerchantRequiredActions } from "../../lib/merchant-required-actions";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { MerchantRequiredActionsResponse, requiredActionsQuerySchema } from "../../validators/merchant";
import { duesForStores } from "./dues-shared";
import { ownedStores } from "./shared";

const app = router();

app.openapi(
  createRoute({
    method: "get",
    path: "/required-actions",
    operationId: "getMerchantRequiredActions",
    tags: ["merchant"],
    security: bearer,
    request: { query: requiredActionsQuerySchema },
    responses: {
      200: json(MerchantRequiredActionsResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { store_id } = c.req.valid("query");

    const owned = await ownedStores(user.id);
    const stores = store_id ? owned.filter((s) => s.id === store_id) : owned;
    if (store_id && stores.length === 0) return c.json({ error: "Store not found" }, 404);
    const ids = stores.map((s) => s.id);

    const [counts, { data: products }, { data: packs }, dues] = await Promise.all([
      Promise.all(
        ids.map(async (id) => {
          const { count } = await supabaseAdmin
            .from("store_products")
            .select("id", { count: "exact", head: true })
            .eq("store_id", id);
          return [id, count ?? 0] as const;
        })
      ),
      // Only the flagged products: rejected, or with a declined price.
      ids.length
        ? supabaseAdmin
            .from("store_products")
            .select("store_id, review_status, suggestion_status, review_note, updated_at")
            .in("store_id", ids)
            .or("review_status.eq.rejected,suggestion_status.eq.rejected")
        : Promise.resolve({ data: [] }),
      ids.length
        ? supabaseAdmin
            .from("store_packs")
            .select("store_id, status, review_note, updated_at")
            .in("store_id", ids)
            .eq("status", "inactive")
        : Promise.resolve({ data: [] }),
      // One dues pass over the stores already loaded, allocated across ALL of
      // them (an all-stores payment is shared) even when one store is asked for.
      duesForStores(owned),
    ]);

    const actions = buildMerchantRequiredActions({
      stores: stores.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        hours: s.hours,
        documents: s.documents,
        document_review: s.document_review,
        review_note: (s.review_note as string | null | undefined) ?? null,
      })),
      products: products ?? [],
      productCounts: new Map(counts),
      packs: packs ?? [],
      dues: new Map(dues.map((d) => [d.store_id, d.dues_payable])),
      pinSet: !!user.pin_hash,
    });

    return c.json(
      {
        actions,
        total: actions.length,
        blocking: actions.filter((a) => a.severity === "blocking").length,
      },
      200
    );
  }
);

export default app;
