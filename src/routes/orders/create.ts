import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createOrderSchema, OrderResponse } from "../../validators/orders";

const app = router();

// ─── Create order (customer) ─────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/",
  operationId: "createOrder",
  tags: ["orders"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(createOrderSchema), required: true } },
  responses: {
    201: json(OrderResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const total = body.subtotal + body.delivery_fee + body.service_fee - body.discount;

  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: user.id,
      store_name: body.store_name,
      store_logo: body.store_logo ?? null,
      type: body.type,
      status: "processing",
      items: body.items,
      subtotal: body.subtotal,
      delivery_fee: body.delivery_fee,
      service_fee: body.service_fee,
      discount: body.discount,
      total,
      pickup_address: body.pickup_address ?? null,
      destination_address: body.destination_address ?? null,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ order: data }, 201);
});

export default app;
