import { AGENT_ACCESS_MESSAGE, canAgentProcess } from "../../lib/agent-access";
import { supabaseAdmin } from "../../lib/supabase";
import { withRider } from "../../lib/transactions";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentAccessError, scanQrSchema, TransactionResponse } from "../../validators/transactions";
import { processingShop } from "../agents/shared";

const app = router();

// ─── Scan QR (agent) ─────────────────────────────────────────────────
// Looks up the rider's pending operation from its QR, under the same rule as
// /process (canAgentProcess): an agent without an approved shop, or scanning
// an operation sent to another agent, gets a coded 403 and never sees it.
const route = createRoute({
  method: "post",
  path: "/scan-qr",
  operationId: "scanQr",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  request: { body: { ...json(scanQrSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    403: json(
      AgentAccessError,
      "Forbidden: code shop_not_approved | not_your_transaction (no code: not an agent)"
    ),
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  let qrPayload: { pending_id?: unknown };
  try {
    qrPayload = JSON.parse(body.qr_data);
  } catch {
    return c.json({ error: "Invalid QR code" }, 400);
  }
  const pendingId = qrPayload?.pending_id;
  if (
    typeof pendingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingId)
  ) {
    return c.json({ error: "Invalid QR code" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("pending_id", pendingId)
    .eq("status", "pending")
    .single();

  if (error || !data) {
    return c.json({ error: "No pending transaction found for this QR" }, 404);
  }

  // The shop /process will use (the app sends no shop choice): the rider's
  // pick when it is this agent's, else the agent's primary shop.
  const shop = await processingShop(user.id, undefined, data.shop_id);
  const access = canAgentProcess({ shop, tx: data, agentId: user.id });
  if (!access.ok) {
    return c.json({ error: AGENT_ACCESS_MESSAGE[access.code], code: access.code }, 403);
  }

  return c.json({ transaction: await withRider(data) }, 200);
});

export default app;
