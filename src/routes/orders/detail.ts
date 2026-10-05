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

  return c.json({ order: data }, 200);
});

export default app;
