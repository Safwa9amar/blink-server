import { isLeavingBlink } from "../../lib/account-deletion";
import { resolveStoreResubmit } from "../../lib/store-review";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantStoreResponse, StoreReviewError } from "../../validators/merchant";
import { normalizeStore, ownedStore, storeSalesStats } from "./shared";

const app = router();

// ─── Merchant: send a rejected / deactivated store back to review ────
// Only a store staff turned off with a note (stores.review_note) can be
// resubmitted; the note stays so the reviewer sees the earlier reason, and
// staff approval clears it (rules: src/lib/store-review.ts). Refused while the
// merchant is leaving Blink (account deletion request pending or completed).
const route = createRoute({
  method: "post",
  path: "/stores/{id}/resubmit",
  operationId: "resubmitMerchantStore",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(MerchantStoreResponse, "Back in review (status under_review)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(
      StoreReviewError,
      "invalid_state: not a store staff rejected / deactivated; owner_leaving: you have an account deletion request pending or completed; stale: it changed meanwhile — reload"
    ),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const store = await ownedStore(user.id, id);
  if (!store) return c.json({ error: "Store not found" }, 404);

  const decision = resolveStoreResubmit(
    {
      status: store.status as "active" | "inactive" | "under_review",
      review_note: (store.review_note as string | null | undefined) ?? null,
    },
    { leaving: await isLeavingBlink(user.id, "merchant") }
  );
  if (!decision.ok) return c.json({ error: decision.error, code: decision.code }, 409);

  const { data, error } = await supabaseAdmin
    .from("stores")
    .update(decision.columns)
    .eq("id", id)
    .eq("owner_id", user.id)
    .eq("updated_at", store.updated_at as string)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[store-review] store resubmit failed: ${error.message}`);
  if (!data) {
    return c.json(
      { error: "This store changed while you were resubmitting it. Reload and try again.", code: "stale" as const },
      409
    );
  }

  const stats = await storeSalesStats([id]);
  return c.json({ store: { ...normalizeStore(data), ...stats.get(id)! } as any }, 200);
});

export default app;
