// Agent Blink Cash dues: what the agent owes Blink for the operations they
// processed (see lib/agent-finance.ts) and PIN-confirmed dues payments.
import {
  AGENT_DUES_FEE_RATE,
  AGENT_PLATFORM_FEE_RATE,
  AGENT_TAX_RATE,
  computeAgentDues,
  round2,
} from "../../lib/agent-finance";
import { verifyPin } from "../../lib/pin";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  AgentDuesResponse,
  payAgentDuesSchema,
  PayAgentDuesResponse,
} from "../../validators/agents";

const app = router();

// ─── GET /dues ───────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/dues",
    operationId: "getAgentDues",
    tags: ["agents"],
    security: bearer,
    responses: {
      200: json(AgentDuesResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const [dues, { data: payments }] = await Promise.all([
      computeAgentDues(user.id),
      supabaseAdmin
        .from("agent_dues_payments")
        .select("*")
        .eq("agent_id", user.id)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    return c.json(
      {
        ...dues,
        platform_fee_rate: AGENT_PLATFORM_FEE_RATE,
        tax_rate: AGENT_TAX_RATE,
        payment_fee_rate: AGENT_DUES_FEE_RATE,
        payments: payments ?? [],
      },
      200
    );
  }
);

// ─── POST /dues/pay ──────────────────────────────────────────────────
// Overpaying is allowed — the surplus shows up as `credit` on GET /dues.
app.openapi(
  createRoute({
    method: "post",
    path: "/dues/pay",
    operationId: "payAgentDues",
    tags: ["agents"],
    security: bearer,
    request: { body: { ...json(payAgentDuesSchema), required: true } },
    responses: {
      201: json(PayAgentDuesResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // 403, not 401, for a wrong PIN: the app's 401 backstop signs the user out.
    if (!user.pin_hash) return c.json({ error: "PIN not set up" }, 400);
    if (!(await verifyPin(body.pin, user.pin_hash))) {
      return c.json({ error: "Invalid PIN" }, 403);
    }

    const { data, error } = await supabaseAdmin
      .from("agent_dues_payments")
      .insert({
        agent_id: user.id,
        amount: round2(body.amount),
        fees: round2(body.amount * AGENT_DUES_FEE_RATE),
        method: body.method,
        // No payment provider is wired: nothing proves this money arrived, so it
        // waits as pending (not counted in dues) until finance confirms it.
        status: "pending",
      })
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Payment failed" }, 400);

    return c.json({ payment: data }, 201);
  }
);

export default app;
