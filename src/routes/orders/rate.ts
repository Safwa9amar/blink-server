import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { rateOrderSchema } from "../../validators/merchant";
import { OrderResponse } from "../../validators/orders";

const app = router();

// ─── Customer: rate the store of a delivered order ───────────────────
// Rolls the rating into stores.rating / review_count (re-rating replaces).
const route = createRoute({
  method: "post",
  path: "/{id}/rate",
  operationId: "rateOrder",
  tags: ["orders"],
  security: bearer,
  request: { params: IdParam, body: { ...json(rateOrderSchema), required: true } },
  responses: {
    200: json(OrderResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { rating, review } = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, store_id, status, type")
    .eq("id", id)
    .maybeSingle();
  if (!order || order.customer_id !== user.id) {
    return c.json({ error: "Order not found" }, 404);
  }
  if (order.status !== "delivered") {
    return c.json({ error: "Only delivered orders can be rated" }, 400);
  }
  // A parcel has no store: its rider is rated (POST /orders/{id}/rate-rider).
  if (order.type === "courier") {
    return c.json({ error: "Courier deliveries rate the rider instead" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ store_rating: rating, store_review: review ?? null })
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "Order not found" }, 400);

  if (order.store_id) {
    const { data: rated } = await supabaseAdmin
      .from("orders")
      .select("store_rating")
      .eq("store_id", order.store_id)
      .not("store_rating", "is", null);
    const n = rated?.length ?? 0;
    if (n > 0) {
      const avg = rated!.reduce((s, r) => s + Number(r.store_rating), 0) / n;
      await supabaseAdmin
        .from("stores")
        .update({ rating: Math.round(avg * 10) / 10, review_count: n })
        .eq("id", order.store_id);
    }
  }

  return c.json({ order: withoutOffer(data) }, 200);
});

export default app;
