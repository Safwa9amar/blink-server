import { isLive, issueCoupon, presentCoupon } from "../../lib/coupons";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { CouponResponse, redeemCouponSchema } from "../../validators/promotions";

const app = router();

// ─── Redeem a promo code → coupon ────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/redeem",
  operationId: "redeemCoupon",
  tags: ["coupons"],
  security: bearer,
  request: { body: { ...json(redeemCouponSchema), required: true } },
  responses: {
    200: json(CouponResponse, "Already redeemed"),
    201: json(CouponResponse, "Redeemed"),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { code } = c.req.valid("json");

  const { data: matches } = await supabaseAdmin
    .from("promotions")
    .select("*")
    .ilike("code", code)
    .eq("is_active", true);

  const promotion = (matches ?? []).find(isLive);
  if (!promotion) {
    return c.json({ error: "Invalid or expired code" }, 404);
  }

  try {
    const { coupon, created } = await issueCoupon(user.id, promotion);
    return c.json({ coupon: presentCoupon(coupon) }, created ? 201 : 200);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
