import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { PromotionResponse } from "../../validators/promotions";

const app = router();

// ─── Get promotion ───────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getPromotion",
  tags: ["promotions"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(PromotionResponse), 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("promotions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    return c.json({ error: "Promotion not found" }, 404);
  }

  const { count } = await supabaseAdmin
    .from("customer_coupons")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("promotion_id", id);

  return c.json({ promotion: { ...data, is_activated: (count ?? 0) > 0 } }, 200);
});

export default app;
