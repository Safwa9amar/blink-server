import { verifyPin } from "../../lib/pin";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { payDuesSchema, PayDuesResponse } from "../../validators/merchant";
import { computeDues } from "./dues-shared";
import { DUES_FEE_RATE, round2 } from "./shared";

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
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  if (!user.pin_hash) return c.json({ error: "PIN not set up" }, 400);
  if (!(await verifyPin(body.pin, user.pin_hash))) {
    return c.json({ error: "Invalid PIN" }, 403);
  }

  const dues = await computeDues(user.id);
  const outstanding = body.store_id
    ? dues.stores.find((s) => s.store_id === body.store_id)?.dues_payable
    : dues.total_dues;
  if (outstanding === undefined) return c.json({ error: "Store not found" }, 404);
  if (body.amount > outstanding + 0.01) {
    return c.json({ error: "Amount exceeds outstanding dues" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("merchant_dues_payments")
    .insert({
      merchant_id: user.id,
      store_id: body.store_id ?? null,
      amount: body.amount,
      fees: round2(body.amount * DUES_FEE_RATE),
      method: body.method,
      // No payment provider is wired: nothing proves this money arrived, so it
      // waits as pending (not counted in dues) until finance confirms it.
      status: "pending",
    })
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Payment failed" }, 400);

  return c.json(
    {
      payment: {
        ...data,
        store_name: data.store_id ? dues.names.get(data.store_id) ?? null : null,
      },
    },
    201
  );
});

export default app;
