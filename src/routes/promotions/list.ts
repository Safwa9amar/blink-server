import { type PromotionUsage, promotionAvailability } from "../../lib/coupons";
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
    .is("archived_at", null)
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
  // Only capped promotions need usage; if that lookup fails, hide them (fail closed).
  const usage = new Map<string, PromotionUsage | null>();
  await Promise.all(
    (data ?? [])
      .filter((p) => p.max_coupons != null || p.discount_budget != null)
      .map(async (p) => {
        const { data: rows, error: usageError } = await supabaseAdmin.rpc("promotion_usage", { p_id: p.id });
        const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, any> | null;
        usage.set(
          p.id,
          usageError ? null : { issued: Number(row?.issued ?? 0), discount_given: Number(row?.discount_given ?? 0) }
        );
      })
  );
  const now = Date.now();
  const promotions = (data ?? [])
    .filter((p) => {
      const u = usage.has(p.id) ? usage.get(p.id) : { issued: 0, discount_given: 0 };
      return u != null && promotionAvailability(p, u, now) === "live";
    })
    .map((p) => ({ ...p, is_activated: activated.has(p.id) }));

  return c.json({ promotions }, 200);
});

export default app;
