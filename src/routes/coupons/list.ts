import { presentCoupon } from "../../lib/coupons";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { CouponListResponse } from "../../validators/promotions";

const app = router();

// ─── List my coupons ─────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listCoupons",
  tags: ["coupons"],
  security: bearer,
  responses: { 200: json(CouponListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("customer_coupons")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ coupons: (data ?? []).map(presentCoupon) }, 200);
});

export default app;
