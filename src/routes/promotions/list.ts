import { isLive } from "../../lib/coupons";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listPromotionsSchema, PromotionListResponse } from "../../validators/promotions";

const app = router();

// ─── List live promotions (promos tab / top deals) ───────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listPromotions",
  tags: ["promotions"],
  security: bearer,
  request: { query: listPromotionsSchema },
  responses: { 200: json(PromotionListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { kind } = c.req.valid("query");

  let query = supabaseAdmin
    .from("promotions")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (kind) query = query.eq("kind", kind);

  const [{ data, error }, { data: held }] = await Promise.all([
    query,
    supabaseAdmin.from("customer_coupons").select("promotion_id").eq("user_id", user.id),
  ]);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const activated = new Set((held ?? []).map((r) => r.promotion_id));
  const promotions = (data ?? [])
    .filter(isLive)
    .map((p) => ({ ...p, is_activated: activated.has(p.id) }));

  return c.json({ promotions }, 200);
});

export default app;
