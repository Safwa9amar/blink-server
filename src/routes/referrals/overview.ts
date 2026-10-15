import { getReferralOverview } from "../../lib/referrals";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { ReferralOverviewResponse } from "../../validators/referrals";

const app = router();

// ─── GET /referrals — Referral dashboard & overview ───────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "getReferralOverview",
  tags: ["referrals"],
  security: bearer,
  responses: {
    200: json(ReferralOverviewResponse, "Customer referral overview and history"),
    400: errorResponses[400],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  try {
    const overview = await getReferralOverview(user.id);
    return c.json(overview, 200);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
