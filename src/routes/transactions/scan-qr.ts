import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { scanQrSchema, TransactionResponse } from "../../validators/transactions";

const app = router();

// ─── Scan QR (agent) ─────────────────────────────────────────────────
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
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");

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

  return c.json({ transaction: data }, 200);
});

export default app;
