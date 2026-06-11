import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { listOrdersSchema } from "../../validators/orders";

const app = new Hono<AuthEnv>();

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

export default app;
