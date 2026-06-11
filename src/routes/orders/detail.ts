import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

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

export default app;
