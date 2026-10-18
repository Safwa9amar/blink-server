// Agent Blink Cash dues: what the agent owes Blink for the operations they
// processed (see lib/agent-finance.ts) and PIN-confirmed dues payments.
import { computeAgentDues, resolveAgentRates, round2 } from "../../lib/agent-finance";
import { getPrice } from "../../lib/pricing";
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
    const rates = await resolveAgentRates(user.id);
    const [dues, feeRate, { data: payments }] = await Promise.all([
      computeAgentDues(user.id, rates),
      getPrice("dues_payment_fee_rate").then((p) => p.value.rate),
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
        platform_fee_rate: rates.platform,
        tax_rate: rates.tax,
        payment_fee_rate: feeRate,
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

    const feeRate = (await getPrice("dues_payment_fee_rate")).value.rate;
    const { data, error } = await supabaseAdmin
      .from("agent_dues_payments")
      .insert({
        agent_id: user.id,
        amount: round2(body.amount),
        fees: round2(body.amount * feeRate),
        method: body.method,
        status: "completed",
      })
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Payment failed" }, 400);

    return c.json({ payment: data }, 201);
  }
);

export default app;
