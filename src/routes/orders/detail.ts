import { expireSearchingOrder, isSearchExpired } from "../../lib/search-timeouts";
import { isActiveOrder, isLiveOrder } from "../../lib/rider-card";
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

  const { data: row, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !row) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (row.customer_id !== user.id && row.rider_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  // A courier request or ride no rider took ends here even without the cron,
  // so the customer's searching screen moves on (canceled, cancel_reason no_rider).
  const data = isSearchExpired(row) ? ((await expireSearchingOrder(row)) ?? row) : row;

  // Which rider a store asked is the merchant's business only.
  const order = withoutOffer(data);
  if (data.customer_id !== user.id) return c.json({ order }, 200);
  // The customer sees who delivers (phone while under way) and the store card.
  // …and, while the rider is driving it, where they are.
  const [withRider] = await attachRiders([order], isActiveOrder, isLiveOrder);
  const [full] = await attachStoreInfo([withRider]);
  return c.json({ order: full }, 200);
});

export default app;
