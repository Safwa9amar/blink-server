import { isLive, issueCoupon, presentCoupon } from "../../lib/coupons";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { CouponResponse } from "../../validators/promotions";

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
    return c.json({ coupon: presentCoupon(coupon) }, created ? 201 : 200);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
