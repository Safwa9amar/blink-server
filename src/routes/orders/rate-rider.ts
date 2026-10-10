import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { OrderResponse, rateRiderSchema } from "../../validators/orders";

const app = router();

// ─── Customer: rate the rider of a delivered order ───────────────────
// Courier requests and rides rate the rider (there is no store); any
// delivered order with a rider may. Re-rating replaces. The average shows on
// RiderCard.rating.
const route = createRoute({
  method: "post",
  path: "/{id}/rate-rider",
  operationId: "rateOrderRider",
  tags: ["orders"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { params: IdParam, body: { ...json(rateRiderSchema), required: true } },
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
  const { rating, review, tags } = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, rider_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!order || order.customer_id !== user.id) {
    return c.json({ error: "Order not found" }, 404);
  }
  if (order.status !== "delivered") {
    return c.json({ error: "Only delivered orders can be rated" }, 400);
  }
  if (!order.rider_id) {
    return c.json({ error: "This order had no rider to rate" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({
      rider_rating: rating,
      rider_review: review?.trim() || null,
      rider_tags: tags?.length ? [...new Set(tags)] : null,
    })
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "Order not found" }, 400);

  return c.json({ order: withoutOffer(data) }, 200);
});

export default app;
