import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { verifyPin } from "../../lib/pin";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { processTransactionSchema, TransactionResponse } from "../../validators/transactions";

const app = router();

// ─── Process transaction (agent confirms/cancels via QR) ─────────────
const route = createRoute({
  method: "post",
  path: "/process",
  operationId: "processTransaction",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  request: { body: { ...json(processTransactionSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Verify agent PIN
  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }
  const pinValid = await verifyPin(body.pin, user.pin_hash);
  if (!pinValid) {
    // 403, not 401: a wrong PIN must not look like an expired session to the
    // app (its 401 backstop signs the user out).
    return c.json({ error: "Invalid PIN" }, 403);
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

  return c.json({ transaction: data }, 200);
});

export default app;
