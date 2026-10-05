import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { OrderResponse, updateOrderStatusSchema } from "../../validators/orders";

const app = router();

// ─── Update order status ─────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/{id}/status",
  operationId: "updateOrderStatus",
  tags: ["orders"],
  security: bearer,
  request: { params: IdParam, body: { ...json(updateOrderStatusSchema), required: true } },
  responses: { 200: json(OrderResponse), 400: errorResponses[400], 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const { id: orderId } = c.req.valid("param");
  const body = c.req.valid("json");

  const updatePayload: Record<string, unknown> = { status: body.status };
  if (body.estimated_time) updatePayload.estimated_time = body.estimated_time;
  if (body.rider_id) updatePayload.rider_id = body.rider_id;

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update(updatePayload)
    .eq("id", orderId)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Order not found" }, 404);
  }

  return c.json({ order: data }, 200);
});

export default app;
