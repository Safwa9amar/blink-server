import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { RiderEarningsResponse } from "../../validators/earnings";

const app = router();

// ─── Rider earnings summary ─────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/rider",
  operationId: "getRiderEarnings",
  tags: ["earnings"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  responses: {
    200: json(RiderEarningsResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  // Get completed trips for this rider
  const { data: trips, error } = await supabaseAdmin
    .from("trips")
    .select("estimated_payout, net_payout, created_at")
    .eq("rider_id", user.id)
    .eq("status", "completed");

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const grossIncome = trips?.reduce((sum, t) => sum + (t.estimated_payout ?? 0), 0) ?? 0;
  const netIncome = trips?.reduce((sum, t) => sum + (t.net_payout ?? 0), 0) ?? 0;
  const commissions = grossIncome - netIncome;

  return c.json(
    {
      earnings: {
        net_income: netIncome,
        gross_income: grossIncome,
        commissions_taxes: commissions,
        trips_count: trips?.length ?? 0,
      },
    },
    200
  );
});

export default app;
