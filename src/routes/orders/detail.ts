import { isActiveOrder } from "../../lib/rider-card";
import { attachRiders, attachStoreInfo } from "../../lib/rider-cards-load";
import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { OrderResponse } from "../../validators/orders";

const app = router();

// ─── Get single order ────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getOrder",
  tags: ["orders"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(OrderResponse), 403: errorResponses[403], 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: orderId } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !data) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (data.customer_id !== user.id && data.rider_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  // Which rider a store asked is the merchant's business only.
  const order = withoutOffer(data);
  if (data.customer_id !== user.id) return c.json({ order }, 200);
  // The customer sees who delivers (phone while under way) and the store card.
  const [withRider] = await attachRiders([order], isActiveOrder);
  const [full] = await attachStoreInfo([withRider]);
  return c.json({ order: full }, 200);
});

export default app;
