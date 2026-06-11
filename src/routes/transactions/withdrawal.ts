import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";
import { createWithdrawalSchema } from "../../validators/transactions";
import { randomUUID } from "crypto";

const app = new Hono<AuthEnv>();

// ─── Create withdrawal (rider) ──────────────────────────────────────
app.post("/withdrawal", requireRole("rider"), async (c) => {
  const user = c.get("user");
  const body = createWithdrawalSchema.parse(await c.req.json());

  const fees = Math.round(body.amount * 0.02);
  const total = body.amount - fees;

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .insert({
      type: "withdrawal",
      user_id: user.id,
      rider_id: user.id,
      agent_id: body.agent_id ?? null,
      amount: body.amount,
      fees,
      total,
      status: body.method === "agent" ? "pending" : "completed",
      method: body.method,
      pending_id: body.method === "agent" ? randomUUID() : null,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ transaction: data }, 201);
});

export default app;
