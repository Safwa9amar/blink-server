import { supabaseAdmin } from "../../lib/supabase";
import { withRider } from "../../lib/transactions";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { rateTransactionSchema, TransactionResponse } from "../../validators/transactions";

const app = router();

// ─── Agent rates the rider of a completed operation (receipt screen) ─
const route = createRoute({
  method: "post",
  path: "/{id}/rate-rider",
  operationId: "rateTransactionRider",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  request: { params: IdParam, body: { ...json(rateTransactionSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .update({ rider_rating: body.rating, rider_feedback: body.feedback ?? null })
    .eq("id", id)
    .eq("agent_id", user.id)
    .eq("status", "completed")
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found or not ratable" }, 400);
  }
  return c.json({ transaction: await withRider(data) }, 200);
});

export default app;
