import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";
import { rateTransactionSchema } from "../../validators/transactions";

const app = new Hono<AuthEnv>();

// ─── Rate transaction (rider) ────────────────────────────────────────
app.post("/:id/rate", requireRole("rider"), async (c) => {
  const user = c.get("user");
  const txId = c.req.param("id");
  const body = rateTransactionSchema.parse(await c.req.json());

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .update({ rating: body.rating, feedback: body.feedback ?? null })
    .eq("id", txId)
    .eq("user_id", user.id)
    .eq("status", "completed")
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found or not ratable" }, 400);
  }

  return c.json({ transaction: data });
});

export default app;
