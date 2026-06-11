import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Agent earnings summary ─────────────────────────────────────────
app.get("/agent", requireRole("agent"), async (c) => {
  const user = c.get("user");

  const { data: transactions, error } = await supabaseAdmin
    .from("transactions")
    .select("type, amount, fees, total, status, created_at")
    .eq("agent_id", user.id)
    .eq("status", "completed");

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const deposits = transactions?.filter((t) => t.type === "deposit") ?? [];
  const withdrawals = transactions?.filter((t) => t.type === "withdrawal") ?? [];
  const totalFees = transactions?.reduce((sum, t) => sum + (t.fees ?? 0), 0) ?? 0;

  return c.json({
    earnings: {
      net_income: totalFees,
      gross_income: totalFees,
      deposits_count: deposits.length,
      withdrawals_count: withdrawals.length,
      recent_operations: transactions?.slice(0, 10) ?? [],
    },
  });
});

export default app;
