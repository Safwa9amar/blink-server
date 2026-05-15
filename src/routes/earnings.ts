import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// ─── Rider earnings summary ─────────────────────────────────────────
app.get("/rider", requireRole("rider"), async (c) => {
  const user = c.get("user");

  // Get completed trips for this rider
  const { data: trips, error } = await supabaseAdmin
    .from("trips")
    .select("estimated_payout, net_payout, created_at")
    .eq("rider_id", user.id)
    .eq("status", "completed");

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const grossIncome = trips?.reduce((sum, t) => sum + (t.estimated_payout ?? 0), 0) ?? 0;
  const netIncome = trips?.reduce((sum, t) => sum + (t.net_payout ?? 0), 0) ?? 0;
  const commissions = grossIncome - netIncome;

  return c.json({
    earnings: {
      net_income: netIncome,
      gross_income: grossIncome,
      commissions_taxes: commissions,
      trips_count: trips?.length ?? 0,
    },
  });
});

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
