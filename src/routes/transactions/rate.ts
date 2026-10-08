import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { rateTransactionSchema, TransactionResponse } from "../../validators/transactions";

const app = router();

// ─── Rate transaction (rider) ────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/{id}/rate",
  operationId: "rateTransaction",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { params: IdParam, body: { ...json(rateTransactionSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: txId } = c.req.valid("param");
  const body = c.req.valid("json");

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

  // Keep the agent shop's rating (shown to riders in /agents/nearby) as the
  // average of its rated operations.
  if (data.shop_id) {
    const { data: rated } = await supabaseAdmin
      .from("transactions")
      .select("rating")
      .eq("shop_id", data.shop_id)
      .not("rating", "is", null);
    const ratings = (rated ?? []).map((r) => Number(r.rating));
    if (ratings.length) {
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      await supabaseAdmin
        .from("agent_shops")
        .update({ rating: Math.round(avg * 10) / 10 })
        .eq("id", data.shop_id);
    }
  }

  return c.json({ transaction: data }, 200);
});

export default app;
