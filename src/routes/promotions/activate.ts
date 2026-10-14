import { isLive, issueCoupon, presentCoupon, PromotionUnavailableError } from "../../lib/coupons";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { CouponResponse, PromotionUnavailableResponse } from "../../validators/promotions";

const app = router();

// ─── Activate / claim a promotion → customer coupon ──────────────────
const route = createRoute({
  method: "post",
  path: "/{id}/activate",
  operationId: "activatePromotion",
  tags: ["promotions"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { params: IdParam },
  responses: {
    200: json(CouponResponse, "Already activated"),
    201: json(CouponResponse, "Activated"),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(PromotionUnavailableResponse, "Sold out, budget spent or not live"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data: promotion } = await supabaseAdmin
    .from("promotions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!promotion || !isLive(promotion)) {
    return c.json({ error: "Promotion not found" }, 404);
  }

  try {
    const { coupon, created } = await issueCoupon(user.id, promotion);
    if (coupon.revoked_at) {
      return c.json({ error: "This coupon was revoked", code: "not_live" as const }, 409);
    }
    return c.json({ coupon: presentCoupon(coupon) }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof PromotionUnavailableError) {
      return c.json({ error: e.message, code: e.code }, 409);
    }
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
