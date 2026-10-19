import { quoteBlinkCashFee } from "../../lib/pricing/fees";
import { expiresAtFor, offerRefusal } from "../../lib/blink-cash-rules";
import {
  findByClientRef,
  isUniqueViolation,
  limitBreach,
  loadOffer,
  notifyAgentOfRequest,
  offerUses,
} from "../../lib/blink-cash-requests";
import { getBlinkCashSettings } from "../../lib/blink-cash-settings";
import { supabaseAdmin } from "../../lib/supabase";
import { expirePending } from "../../lib/wallet";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { CashRequestError, createDepositSchema, TransactionResponse } from "../../validators/transactions";
import { operationAgent } from "../agents/shared";
import { randomUUID } from "crypto";

const app = router();

// ─── Create deposit (rider) ─────────────────────────────────────────
// Agent deposits wait `pending` (QR, expires after pending_expiry_minutes);
// electronic ones (only when blink_cash_settings.electronic_enabled) wait in
// `review` with the rider's payment reference until staff approve them.
// A retry with the same client_ref returns the first request (200).
const route = createRoute({
  method: "post",
  path: "/deposit",
  operationId: "createDeposit",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { body: { ...json(createDepositSchema), required: true } },
  responses: {
    200: json(TransactionResponse, "Replay of an earlier request with the same client_ref"),
    201: json(TransactionResponse, "Created"),
    400: json(CashRequestError, "Bad request, or a limit / offer rule (code)"),
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const settings = await getBlinkCashSettings();

  const replay = await findByClientRef(user.id, body.client_ref);
  if (replay) return c.json({ transaction: replay }, 200);

  // No payment provider is wired: an electronic request is only taken when
  // finance verifies it (review), and only once they switched it on.
  const electronic = body.method === "electronic";
  if (electronic && !settings.electronic_enabled) {
    return c.json(
      { error: "Electronic deposits are not available yet. Please use a Blink Cash agent.", code: "electronic_unavailable" as const },
      400
    );
  }
  if (electronic && !body.reference) {
    return c.json({ error: "A payment reference is required", code: "reference_required" as const }, 400);
  }

  // Lapsed requests no longer count toward the limits.
  await expirePending(user.id);
  const breach = await limitBreach(user.id, "deposit", body.amount, settings);
  if (breach) {
    return c.json({ error: "Amount outside your Blink Cash limits", code: breach.code, limit: breach.limit, used: breach.used }, 400);
  }

  if (body.offer_id) {
    const offer = await loadOffer(body.offer_id);
    const refusal = offer
      ? offerRefusal(offer, body.amount, await offerUses(offer.id, user.id))
      : ("offer_inactive" as const);
    if (refusal) return c.json({ error: "This offer is not available", code: refusal }, 400);
  }

  // An agent deposit can go to a shop the rider picked (its owner is the
  // agent). An electronic one has no agent: a client-sent agent_id would count
  // toward that agent's dues and stats.
  const target = electronic
    ? { agent_id: null, shop_id: null }
    : await operationAgent(body.agent_id, body.shop_id);
  if ("error" in target) {
    return c.json({ error: target.error }, 400);
  }

  // The fee is Pricing & Fees' blink_cash_fee_rate (what the app quoted the
  // rider), snapshotted as fee_rate. blink_cash_settings keeps limits / expiry.
  const { fees, total, fee_rate } = await quoteBlinkCashFee({ type: "deposit", amount: body.amount, riderId: user.id });

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .insert({
      type: "deposit",
      user_id: user.id,
      rider_id: user.id,
      agent_id: target.agent_id,
      shop_id: target.shop_id,
      amount: body.amount,
      fees,
      fee_rate,
      total,
      status: electronic ? "review" : "pending",
      method: body.method,
      pending_id: electronic ? null : randomUUID(),
      expires_at: electronic ? null : expiresAtFor(settings.pending_expiry_minutes),
      client_ref: body.client_ref ?? null,
      offer_id: body.offer_id ?? null,
      reference: electronic ? body.reference : null,
      receipt_url: electronic ? (body.receipt_url ?? null) : null,
    })
    .select()
    .single();

  if (isUniqueViolation(error)) {
    // Lost a client_ref race: the other request is the answer.
    const winner = await findByClientRef(user.id, body.client_ref);
    if (winner) return c.json({ transaction: winner }, 200);
  }
  if (error || !data) {
    return c.json({ error: error?.message ?? "Could not create the deposit" }, 400);
  }

  void notifyAgentOfRequest(data);
  return c.json({ transaction: data }, 201);
});

export default app;
