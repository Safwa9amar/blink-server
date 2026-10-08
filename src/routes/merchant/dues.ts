import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { MerchantDuesResponse } from "../../validators/merchant";
import { computeDues } from "./dues-shared";

const app = router();

// ─── Merchant: outstanding dues per store + payment history ──────────
const route = createRoute({
  method: "get",
  path: "/dues",
  operationId: "getMerchantDues",
  tags: ["merchant"],
  security: bearer,
  responses: {
    200: json(MerchantDuesResponse),
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { names, ...dues } = await computeDues(user.id);

  const { data: payments } = await supabaseAdmin
    .from("merchant_dues_payments")
    .select("*")
    .eq("merchant_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  return c.json(
    {
      ...dues,
      payments: (payments ?? []).map((p) => ({
        ...p,
        store_name: p.store_id ? names.get(p.store_id) ?? null : null,
      })),
    },
    200
  );
});

export default app;
