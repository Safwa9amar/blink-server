import { computeAgentEarnings } from "../../lib/agent-finance";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { agentEarningsQuerySchema, AgentEarningsResponse } from "../../validators/earnings";
import { periodRange } from "../merchant/shared";

const app = router();

const MAX_OPERATIONS = 200;

// ─── Agent earnings for a period ─────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/agent",
  operationId: "getAgentEarnings",
  tags: ["earnings"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  request: { query: agentEarningsQuerySchema },
  responses: {
    200: json(AgentEarningsResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { period, from, to } = c.req.valid("query");
  const { start, end } = periodRange(period, from, to);

  const e = await computeAgentEarnings(user.id, start, end);
  const recent = e.operations
    .filter((o) => o.type !== "challenge_bonus" && o.status === "completed")
    .slice(0, 10)
    .map((o) => ({
      type: o.type as "deposit" | "withdrawal",
      amount: o.volume,
      fees: o.amount,
      total: o.type === "deposit" ? o.volume + o.amount : o.volume - o.amount,
      status: o.status,
      created_at: o.created_at,
    }));

  return c.json(
    {
      earnings: {
        ...e,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        recent_operations: recent,
        operations: e.operations.slice(0, MAX_OPERATIONS),
      },
    },
    200
  );
});

export default app;
