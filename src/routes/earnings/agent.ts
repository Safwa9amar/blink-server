import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentEarningsResponse } from "../../validators/earnings";

const app = router();

// ─── Agent earnings summary ─────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/agent",
  operationId: "getAgentEarnings",
  tags: ["earnings"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  responses: {
    200: json(AgentEarningsResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data: transactions, error } = await supabaseAdmin
    .from("transactions")
    .select("type, amount, fees, total, status, created_at")
    .eq("agent_id", user.id)
    .eq("status", "completed");

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const deposits = transactions?.filter((t) => t.type === "deposit") ?? [];
  const withdrawals = transactions?.filter((t) => t.type === "withdrawal") ?? [];
  const totalFees = transactions?.reduce((sum, t) => sum + (t.fees ?? 0), 0) ?? 0;

  return c.json(
    {
      earnings: {
        net_income: totalFees,
        gross_income: totalFees,
        deposits_count: deposits.length,
        withdrawals_count: withdrawals.length,
        recent_operations: transactions?.slice(0, 10) ?? [],
      },
    },
    200
  );
});

export default app;
