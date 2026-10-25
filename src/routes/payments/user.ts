// App-facing payment routes: the methods a client can offer, one payment's state
// (re-checked with the provider while pending) and cancelling a pending one.
import { supabaseAdmin } from "../../lib/supabase";
import { cancelPayment, refreshIfPending } from "../../lib/payments/service";
import { enabledMethods } from "../../lib/payments/registry";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { PaymentMethodsResponse, PaymentResponse } from "../../validators/payments";
import { PaymentIdParam, toPayment } from "./shared";

const app = router();

app.openapi(
  createRoute({
    method: "get",
    path: "/methods",
    operationId: "listPaymentMethods",
    tags: ["payments"],
    security: bearer,
    middleware: [auth] as const,
    responses: { 200: json(PaymentMethodsResponse, "Enabled online methods (empty = no online payment)"), 401: errorResponses[401] },
  }),
  (c) => c.json({ methods: enabledMethods(c.get("user").id) }, 200)
);

async function ownPayment(userId: string, id: string) {
  const { data } = await supabaseAdmin.from("payments").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  return data;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    operationId: "getPayment",
    tags: ["payments"],
    security: bearer,
    middleware: [auth] as const,
    request: { params: PaymentIdParam },
    responses: { 200: json(PaymentResponse), 401: errorResponses[401], 404: errorResponses[404] },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const payment = await ownPayment(c.get("user").id, id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);
    return c.json({ payment: toPayment(await refreshIfPending(payment)) }, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/cancel",
    operationId: "cancelPayment",
    tags: ["payments"],
    security: bearer,
    middleware: [auth] as const,
    request: { params: PaymentIdParam },
    responses: {
      200: json(PaymentResponse),
      401: errorResponses[401],
      404: errorResponses[404],
      409: errorResponses[409],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const payment = await ownPayment(c.get("user").id, id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);
    if (payment.status !== "pending") {
      return c.json({ error: "This payment is no longer pending" }, 409);
    }
    const after = await cancelPayment(payment);
    // Paid in the meantime (the provider check inside cancel found it).
    if (after.status !== "canceled") return c.json({ error: "This payment is no longer pending" }, 409);
    return c.json({ payment: toPayment(after) }, 200);
  }
);

export default app;
