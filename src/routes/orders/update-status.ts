import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { updateOrderStatusSchema } from "../../validators/orders";

const app = new Hono<AuthEnv>();

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
