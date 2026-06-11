import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole, type AuthEnv } from "../../middleware/auth";
import { scanQrSchema } from "../../validators/transactions";

const app = new Hono<AuthEnv>();

// ─── Scan QR (agent) ─────────────────────────────────────────────────
app.post("/scan-qr", requireRole("agent"), async (c) => {
  const body = scanQrSchema.parse(await c.req.json());

  let qrPayload: { pending_id: string };
  try {
    qrPayload = JSON.parse(body.qr_data);
  } catch {
    return c.json({ error: "Invalid QR code" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("pending_id", qrPayload.pending_id)
    .eq("status", "pending")
    .single();

  if (error || !data) {
    return c.json({ error: "No pending transaction found for this QR" }, 404);
  }

  return c.json({ transaction: data });
});

export default app;
