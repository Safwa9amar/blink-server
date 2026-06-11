import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";
import { verifyPin } from "../../lib/pin";
import { processTransactionSchema } from "../../validators/transactions";

const app = new Hono<AuthEnv>();

// ─── Process transaction (agent confirms/cancels via QR) ─────────────
app.post("/process", requireRole("agent"), async (c) => {
  const user = c.get("user");
  const body = processTransactionSchema.parse(await c.req.json());

  // Verify agent PIN
  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }
  const pinValid = await verifyPin(body.pin, user.pin_hash);
  if (!pinValid) {
    return c.json({ error: "Invalid PIN" }, 401);
  }

  const newStatus = body.action === "confirm" ? "completed" : "cancelled";

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .update({ status: newStatus, agent_id: user.id })
    .eq("id", body.transaction_id)
    .eq("status", "pending") // only update pending transactions
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found or already processed" }, 400);
  }

  return c.json({ transaction: data });
});

export default app;
