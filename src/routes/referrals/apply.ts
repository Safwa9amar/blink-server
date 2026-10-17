import { applyFriendReferral } from "../../lib/referrals";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { ApplyReferralResponse, applyReferralSchema } from "../../validators/referrals";

const app = router();

// ─── POST /referrals/apply — Apply a friend's referral code ──────────
const route = createRoute({
  method: "post",
  path: "/apply",
  operationId: "applyReferralCode",
  tags: ["referrals"],
  security: bearer,
  request: { body: { ...json(applyReferralSchema), required: true } },
  responses: {
    200: json(ApplyReferralResponse, "Referral code applied"),
    400: errorResponses[400],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { code } = c.req.valid("json");

  try {
    const result = await applyFriendReferral(user.id, code);
    return c.json(
      {
        success: true,
        discount_amount: result.discount_amount,
        coupon_code: result.coupon_code,
      },
      200
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
