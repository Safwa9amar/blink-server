import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  listOrdersSchema,
} from "../validators/orders";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// ─── List orders ─────────────────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  const query = listOrdersSchema.parse(c.req.query());
  const { page, limit, status } = query;
  const offset = (page - 1) * limit;

  const column =
    user.role === "customer"
      ? "customer_id"
      : user.role === "rider"
        ? "rider_id"
        : "customer_id";

  let q = supabaseAdmin
    .from("orders")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq("status", status);

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    orders: data,
    pagination: { page, limit, total: count ?? 0 },
  });
});

// ─── Get single order ────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const orderId = c.req.param("id");

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

  return c.json({ order: data });
});

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

// ─── Update order status ─────────────────────────────────────────────
app.patch("/:id/status", async (c) => {
  const orderId = c.req.param("id");
  const body = updateOrderStatusSchema.parse(await c.req.json());

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

  return c.json({ order: data });
});

export default app;
