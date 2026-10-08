import { CLEAR_OFFER } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, IdParam, json, router } from "../../openapi";
import { EnrichedMerchantOrderResponse } from "../../validators/merchant";
import { enrichOrders } from "./orders-shared";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: withdraw a rider request ──────────────────────────────
// Clears the request POST /orders/{id}/assign sent (pending, declined or
// expired) while no rider holds the order, so the store can ask someone else.
// The requested rider's sheet closes through realtime (the order trigger also
// notifies the previous offered_rider_id), so no push. 409 when there is no
// request to withdraw (a double tap, or the rider answered already), or once a
// rider accepted (or claimed it from the pool) in between.
const route = createRoute({
  method: "delete",
  path: "/orders/{id}/offer",
  operationId: "cancelOrderRiderOffer",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(EnrichedMerchantOrderResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(ErrorSchema, "No request to withdraw, or the rider already answered"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, store_id, offered_rider_id, offered_at")
    .eq("id", id)
    .maybeSingle();
  const store = order?.store_id ? await ownedStore(user.id, order.store_id) : null;
  if (!order || !store) return c.json({ error: "Order not found" }, 404);

  // Only a request this caller saw: with none read, a write would clear
  // whatever request another device sent meanwhile.
  if (!order.offered_rider_id || !order.offered_at) {
    return c.json({ error: "No rider request to withdraw — refresh" }, 409);
  }

  // Compare-and-swap on the request read: an accept, a pool claim or a newer
  // request in between makes the write miss.
  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .update(CLEAR_OFFER)
    .eq("id", id)
    .is("rider_id", null)
    .eq("status", "searching")
    .eq("offered_rider_id", order.offered_rider_id)
    .eq("offered_at", order.offered_at)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!row) return c.json({ error: "The rider already answered — refresh" }, 409);

  const [withdrawn] = await enrichOrders([row]);
  return c.json({ order: withdrawn }, 200);
});

export default app;
