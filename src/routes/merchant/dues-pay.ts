import { checkPin, pinFailureBody } from "../../lib/pin";
import { supabaseAdmin } from "../../lib/supabase";
import { gatewayFees, gatewayRefusal, PaymentStartError, startCheckout, toCheckout } from "../../lib/payments/service";
import { isGatewayMethod, type MethodId } from "../../lib/payments/core";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { payDuesSchema, PayDuesResponse } from "../../validators/merchant";
import { PinError } from "../../validators/transactions";
import { computeDues } from "./dues-shared";
import { getPrice } from "../../lib/pricing";
import { round2 } from "./shared";

const app = router();

// ─── Merchant: pay dues (PIN-confirmed) ──────────────────────────────
const route = createRoute({
  method: "post",
  path: "/dues/pay",
  operationId: "payMerchantDues",
  tags: ["merchant"],
  security: bearer,
  request: { body: { ...json(payDuesSchema), required: true } },
  responses: {
    201: json(PayDuesResponse, "Created"),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(PinError, "Wrong PIN, or pin_locked (with retry_after seconds)"),
    404: errorResponses[404],
    502: json(ErrorSchema, "Gateway methods: the provider could not create the checkout (nothing was charged)"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const gateway = isGatewayMethod(body.method);
  const refusal = gateway ? gatewayRefusal(body.method, user.id, body.amount) : null;
  if (refusal) return c.json(refusal, 400);

  const pin = await checkPin(user, body.pin);
  if (!pin.ok) {
    const f = pinFailureBody(pin);
    return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
  }

  const dues = await computeDues(user.id);
  const outstanding = body.store_id
    ? dues.stores.find((s) => s.store_id === body.store_id)?.dues_payable
    : dues.total_dues;
  if (outstanding === undefined) return c.json({ error: "Store not found" }, 404);
  if (body.amount > outstanding + 0.01) {
    return c.json({ error: "Amount exceeds outstanding dues" }, 400);
  }

  const amount = round2(body.amount);
  const feeRate = (await getPrice("dues_payment_fee_rate")).value.rate;
  const { data, error } = await supabaseAdmin
    .from("merchant_dues_payments")
    .insert({
      merchant_id: user.id,
      store_id: body.store_id ?? null,
      amount,
      // The merchant pay summary shows only the amount, so a gateway charge carries no
      // payment fee beyond rounding a centime total up to the whole dinar Chargily takes.
      fees: gateway ? gatewayFees(body.method as MethodId, amount, 0) : round2(amount * feeRate),
      method: body.method,
      // A manual method has no proof the money arrived: it waits as pending (not
      // counted in dues) until finance confirms it. A gateway method waits for the
      // gateway, which completes the row (lib/payments/service.ts).
      status: "pending",
    })
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Payment failed" }, 400);

  const view = {
    ...data,
    store_name: data.store_id ? dues.names.get(data.store_id) ?? null : null,
  };
  if (!gateway) return c.json({ payment: view, checkout: null }, 201);

  try {
    const payment = await startCheckout({
      userId: user.id,
      purpose: "merchant_dues",
      refId: data.id,
      amount: Number(data.amount) + Number(data.fees),
      method: body.method as "edahabia" | "cib" | "card",
      locale: body.locale,
      description: "Blink dues",
    });
    return c.json({ payment: view, checkout: toCheckout(payment) }, 201);
  } catch (e) {
    await supabaseAdmin.from("merchant_dues_payments").update({ status: "cancelled", rejected_reason: "provider_error" }).eq("id", data.id);
    if (e instanceof PaymentStartError && e.code === "method_unavailable") {
      return c.json({ error: e.message, code: "method_unavailable" }, 400);
    }
    return c.json({ error: (e as Error).message }, 502);
  }
});

export default app;
