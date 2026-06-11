import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { listTransactionsSchema } from "../../validators/transactions";

const app = new Hono<AuthEnv>();

// ─── List transactions ───────────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  const query = listTransactionsSchema.parse(c.req.query());
  const { page, limit, type, status } = query;
  const offset = (page - 1) * limit;

  // Agents see transactions they processed; riders see their own
  const column = user.role === "agent" ? "agent_id" : "user_id";

  let q = supabaseAdmin
    .from("transactions")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) q = q.eq("type", type);
  if (status) q = q.eq("status", status);

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    transactions: data,
    pagination: { page, limit, total: count ?? 0 },
  });
});

export default app;
