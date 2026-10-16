import { cancelTransaction, walletError } from "../../lib/wallet";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { TransactionResponse, WalletFunctionError } from "../../validators/transactions";

const app = router();

// ─── Cancel a request (rider) ───────────────────────────────────────
// The owner may cancel while it is pending (QR) or in review; a withdrawal's
// hold on the funds is released. Anything else answers 409 not_pending.
const route = createRoute({
  method: "post",
  path: "/{id}/cancel",
  operationId: "cancelTransaction",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { params: IdParam },
  responses: {
    200: json(TransactionResponse),
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(WalletFunctionError, "Already processed (code not_pending)"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data: tx } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!tx) return c.json({ error: "Transaction not found" }, 404);

  const { data, error } = await cancelTransaction(id, "rider", user.id);
  const known = walletError(error);
  if (known?.status === 409) return c.json({ error: known.body.error, code: "not_pending" as const }, 409);
  if (known?.status === 404 || !data) return c.json({ error: "Transaction not found" }, 404);
  return c.json({ transaction: data as any }, 200);
});

export default app;
