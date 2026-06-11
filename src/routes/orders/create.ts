import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";
import { createOrderSchema } from "../../validators/orders";

const app = new Hono<AuthEnv>();

// ─── Create order (customer) ─────────────────────────────────────────
app.post("/", requireRole("customer"), async (c) => {
  const user = c.get("user");
  const body = createOrderSchema.parse(await c.req.json());

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
