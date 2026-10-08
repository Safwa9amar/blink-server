import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { setTransactionShopSchema, TransactionResponse } from "../../validators/transactions";
import { operationAgent } from "../agents/shared";

const app = router();

// ─── Pick the agent shop of a pending agent operation (rider) ───────
// The deposit QR is created before the rider picks a shop in the locator, so
// the pick is attached afterwards: the shop's owner becomes agent_id (the op
// lists for that agent) and the shop is used when that agent processes it.
const route = createRoute({
  method: "patch",
  path: "/{id}/shop",
  operationId: "setTransactionShop",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { params: IdParam, body: { ...json(setTransactionShopSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: txId } = c.req.valid("param");
  const body = c.req.valid("json");

  const target = await operationAgent(undefined, body.shop_id);
  if ("error" in target) {
    return c.json({ error: target.error }, 400);
  }

  const { data } = await supabaseAdmin
    .from("transactions")
    .update({ agent_id: target.agent_id, shop_id: target.shop_id })
    .eq("id", txId)
    .eq("user_id", user.id)
    .eq("method", "agent")
    .eq("status", "pending") // only while no agent has processed it
    .select()
    .maybeSingle();

  if (!data) {
    return c.json({ error: "Transaction not found or already processed" }, 404);
  }

  return c.json({ transaction: data }, 200);
});

export default app;
