import { expireIfLapsed } from "../../lib/blink-cash-requests";
import { supabaseAdmin } from "../../lib/supabase";
import { withRider } from "../../lib/transactions";
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

  const read = () => supabaseAdmin.from("transactions").select("*").eq("id", txId).single();
  let { data, error } = await read();
  // Lazy expiry (pg_cron is the primary): never show a lapsed request as pending.
  if (!error && data && (await expireIfLapsed(data))) ({ data, error } = await read());

  if (error || !data) {
    return c.json({ error: "Transaction not found" }, 404);
  }

  // Only the active role's side: the agent who processed it, or the rider it's for.
  const asAgent = user.role === "agent" && data.agent_id === user.id;
  const asRider = user.role === "rider" && data.user_id === user.id;
  if (!asAgent && !asRider) {
    return c.json({ error: "Access denied" }, 403);
  }

  const transaction = asAgent ? await withRider(data) : data;
  return c.json({ transaction }, 200);
});

export default app;
