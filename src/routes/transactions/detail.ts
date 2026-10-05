import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { TransactionResponse } from "../../validators/transactions";

const app = router();

// ─── Get single transaction ──────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getTransaction",
  tags: ["transactions"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(TransactionResponse),
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: txId } = c.req.valid("param");

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

  return c.json({ transaction: data }, 200);
});

export default app;
