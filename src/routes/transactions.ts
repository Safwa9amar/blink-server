import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import { verifyPin } from "../lib/pin";
import {
  createDepositSchema,
  createWithdrawalSchema,
  processTransactionSchema,
  scanQrSchema,
  rateTransactionSchema,
  listTransactionsSchema,
} from "../validators/transactions";
import { randomUUID } from "crypto";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

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

// ─── Get single transaction ──────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const txId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("id", txId)
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found" }, 404);
  }

  if (data.user_id !== user.id && data.agent_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ transaction: data });
});

// ─── Create deposit (rider) ─────────────────────────────────────────
app.post("/deposit", requireRole("rider"), async (c) => {
  const user = c.get("user");
  const body = createDepositSchema.parse(await c.req.json());

  const fees = Math.round(body.amount * 0.02); // 2% fee
  const total = body.amount + fees;

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .insert({
      type: "deposit",
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
