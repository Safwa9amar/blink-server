import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { listTripsSchema } from "../../validators/trips";

const app = new Hono<AuthEnv>();

// ─── List trips (rider sees their trips, customer sees theirs) ───────
app.get("/", async (c) => {
  const user = c.get("user");
  const query = listTripsSchema.parse(c.req.query());
  const { page, limit, status } = query;
  const offset = (page - 1) * limit;

  const column = user.role === "rider" ? "rider_id" : "customer_id";

  let q = supabaseAdmin
    .from("trips")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    q = q.eq("status", status);
  }

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    trips: data,
    pagination: { page, limit, total: count ?? 0 },
  });
});

export default app;
