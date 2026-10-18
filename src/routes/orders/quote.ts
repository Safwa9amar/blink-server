import { checkoutAlreadyCharged, orderPricingContext, quoteServiceFee } from "../../lib/pricing/fees";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { QuoteOrderBody, QuoteOrderResponse } from "../../validators/pricing";

const app = router();

// ─── POST /orders/quote — what the customer will be charged ──────────
// The service fee shown in the cart/checkout. POST /orders prices the same
// order with the same helpers, so the quote is the charge.
const route = createRoute({
  method: "post",
  path: "/quote",
  operationId: "quoteOrder",
  tags: ["orders"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(QuoteOrderBody), required: true } },
  responses: {
    200: json(QuoteOrderResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const [ctx, charged] = await Promise.all([
    orderPricingContext({ type: body.type, storeId: body.store_id, lat: body.lat, lng: body.lng }),
    checkoutAlreadyCharged(user.id, body.checkout_id),
  ]);
  const { amount } = await quoteServiceFee(ctx, { type: body.type, checkoutAlreadyCharged: charged });
  return c.json({ service_fee: amount }, 200);
});

export default app;
