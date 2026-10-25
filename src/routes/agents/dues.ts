// Agent Blink Cash dues: what the agent owes Blink for the operations they
// processed (see lib/agent-finance.ts) and PIN-confirmed dues payments.
import { computeAgentDues, resolveAgentRates, round2 } from "../../lib/agent-finance";
import { getPrice } from "../../lib/pricing";
import { agentCapacity } from "../../lib/blink-cash-rules";
import { agentLimitFor } from "../../lib/blink-cash-requests";
import { getBlinkCashSettings } from "../../lib/blink-cash-settings";
import { checkPin, pinFailureBody, verifyPin } from "../../lib/pin";
import { supabaseAdmin } from "../../lib/supabase";
import { gatewayFees, gatewayRefusal, PaymentStartError, startCheckout, toCheckout } from "../../lib/payments/service";
import { isGatewayMethod, type MethodId } from "../../lib/payments/core";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  AgentDuesResponse,
  payAgentDuesSchema,
  PayAgentDuesResponse,
} from "../../validators/agents";
import { PinError } from "../../validators/transactions";

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
    const [dues, feeRate, limit, { data: payments }] = await Promise.all([
      computeAgentDues(user.id, rates),
      getPrice("dues_payment_fee_rate").then((p) => p.value.rate),
      getBlinkCashSettings().then((settings) => agentLimitFor(user.id, settings)),
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
        credit_limit: limit,
        capacity: agentCapacity(dues.total_dues, limit),
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
      403: json(PinError, "Wrong PIN, or pin_locked (with retry_after seconds)"),
      502: json(ErrorSchema, "Gateway methods: the provider could not create the checkout (nothing was charged)"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const gateway = isGatewayMethod(body.method);
    const refusal = gateway ? gatewayRefusal(body.method, user.id, body.amount) : null;
    if (refusal) return c.json(refusal, 400);

    // 403, not 401, for a wrong PIN: the app's 401 backstop signs the user out.
    const pin = await checkPin(user, body.pin);
    if (!pin.ok) {
      const f = pinFailureBody(pin);
      return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
    }

    const feeRate = (await getPrice("dues_payment_fee_rate")).value.rate;
    const amount = round2(body.amount);
    const { data, error } = await supabaseAdmin
      .from("agent_dues_payments")
      .insert({
        agent_id: user.id,
        amount,
        fees: gateway ? gatewayFees(body.method as MethodId, amount, round2(amount * feeRate)) : round2(amount * feeRate),
        method: body.method,
        // A manual method has no proof the money arrived: it waits as pending (not
        // counted in dues) until finance confirms it. A gateway method waits for the
        // gateway, which completes the row (lib/payments/service.ts).
        status: "pending",
      })
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Payment failed" }, 400);

    if (!gateway) return c.json({ payment: data, checkout: null }, 201);

    // The gateway charges what the pay summary shows: the amount paid plus the payment fee.
    try {
      const payment = await startCheckout({
        userId: user.id,
        purpose: "agent_dues",
        refId: data.id,
        amount: round2(Number(data.amount) + Number(data.fees)),
        method: body.method as "edahabia" | "cib" | "card",
        locale: body.locale,
        description: "Blink dues",
      });
      return c.json({ payment: data, checkout: toCheckout(payment) }, 201);
    } catch (e) {
      await supabaseAdmin.from("agent_dues_payments").update({ status: "cancelled", rejected_reason: "provider_error" }).eq("id", data.id);
      if (e instanceof PaymentStartError && e.code === "method_unavailable") {
        return c.json({ error: e.message, code: "method_unavailable" }, 400);
      }
      return c.json({ error: (e as Error).message }, 502);
    }
  }
);

export default app;
