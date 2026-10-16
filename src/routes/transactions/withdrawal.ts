import { riderWallet } from "../../lib/dispatch";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createWithdrawalSchema, TransactionResponse } from "../../validators/transactions";
import { operationAgent } from "../agents/shared";
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

  // No payment provider is wired: an "electronic" row used to be stored completed
  // with nothing verified (free balance, or a debit nobody paid out). Agent only
  // until the reviewed electronic flow ships.
  if (body.method !== "agent") {
    return c.json(
      { error: "Electronic withdrawals are not available yet. Please use a Blink Cash agent.", code: "electronic_unavailable" },
      400
    );
  }

  // Can't withdraw more than the derived Blink Cash balance allows.
  const wallet = await riderWallet(user.id);
  if (body.amount > wallet.available) {
    return c.json({ error: "Insufficient Blink Cash balance" }, 400);
  }

  // An agent withdrawal can go to a shop the rider picked (its owner is the
  // agent). An electronic one has no agent: it is stored completed, so a
  // client-sent agent_id would count toward that agent's dues and stats.
  const target =
    body.method === "agent"
      ? await operationAgent(body.agent_id, body.shop_id)
      : { agent_id: null, shop_id: null };
  if ("error" in target) {
    return c.json({ error: target.error }, 400);
  }

  const fees = Math.round(body.amount * 0.02);
  const total = body.amount - fees;

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .insert({
      type: "withdrawal",
      user_id: user.id,
      rider_id: user.id,
      agent_id: target.agent_id,
      shop_id: target.shop_id,
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
