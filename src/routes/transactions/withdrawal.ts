import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createWithdrawalSchema, TransactionResponse } from "../../validators/transactions";
import { randomUUID } from "crypto";

const app = router();

// ─── Create withdrawal (rider) ──────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/withdrawal",
  operationId: "createWithdrawal",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { body: { ...json(createWithdrawalSchema), required: true } },
  responses: {
    201: json(TransactionResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

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

export default app;
