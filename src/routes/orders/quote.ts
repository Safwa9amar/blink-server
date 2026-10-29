import { checkoutAlreadyCharged, orderPricingContext, quoteServiceFee, storeContextOf } from "../../lib/pricing/fees";
import { quoteStoreDelivery } from "../../lib/pricing/store-quote";
import { supabaseAdmin } from "../../lib/supabase";
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
  if (!body.store_ids) return c.json({ service_fee: amount }, 200);

  // Each store's delivery fee for this customer point (`lat` / `lng`): the same
  // function POST /orders prices with, so the quoted fee is the charged fee.
  const customer = body.lat != null && body.lng != null ? { lat: body.lat, lng: body.lng } : null;
  const ids = [...new Set(body.store_ids)];
  const { data: stores } = ids.length
    ? await supabaseAdmin
        .from("stores")
        .select("id, owner_id, wilaya, latitude, longitude, delivery_fee")
        .in("id", ids)
        .eq("status", "active")
    : { data: [] as any[] };
  const byId = new Map((stores ?? []).map((s) => [s.id as string, s]));
  const quoted = await Promise.all(
    ids.flatMap((id) => {
      const s = byId.get(id);
      if (!s) return [];
      return [
        (async () => {
          const sctx = await storeContextOf(s, body.type, customer);
          const store =
            s.latitude != null && s.longitude != null ? { lat: Number(s.latitude), lng: Number(s.longitude) } : null;
          const q = await quoteStoreDelivery({ ctx: sctx, merchantFee: Number(s.delivery_fee ?? 0), store, customer });
          return { store_id: id, delivery_fee: q.fee, mode: q.mode };
        })(),
      ];
    })
  );
  return c.json({ service_fee: amount, delivery_fees: quoted }, 200);
});

export default app;
