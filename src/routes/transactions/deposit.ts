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
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { CashRequestError, createDepositSchema, TransactionResponse } from "../../validators/transactions";
import { operationAgent } from "../agents/shared";
import { cancelTransaction } from "../../lib/wallet";
import { gatewayFees, gatewayRefusal, PaymentStartError, startCheckout, toCheckout } from "../../lib/payments/service";
import { round2 } from "../../lib/agent-finance";
import { randomUUID } from "crypto";

const app = router();

// ─── Create deposit (rider) ─────────────────────────────────────────
// Agent deposits wait `pending` (QR, expires after pending_expiry_minutes);
// electronic ones (only when blink_cash_settings.electronic_enabled) wait in
// `review` with the rider's payment reference until staff approve them; online
// ones (card, via a payment gateway) wait `pending` with no expiry — the
// payments module owns their lifecycle and the gateway credits them.
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
    502: json(ErrorSchema, "The payment provider could not create the checkout (nothing was charged)"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const settings = await getBlinkCashSettings();

  const replay = await findByClientRef(user.id, body.client_ref);
  if (replay) return c.json({ transaction: replay, checkout: await pendingCheckout(replay) }, 200);

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

  const online = body.method === "online";
  if (online) {
    if (!body.payment_method) {
      return c.json({ error: "A payment method is required", code: "payment_method_required" as const }, 400);
    }
    const refusal = gatewayRefusal(body.payment_method, user.id, body.amount);
    if (refusal) return c.json(refusal, 400);
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
  const target = electronic || online
    ? { agent_id: null, shop_id: null }
    : await operationAgent(body.agent_id, body.shop_id);
  if ("error" in target) {
    return c.json({ error: target.error }, 400);
  }

  // The fee is Pricing & Fees' blink_cash_fee_rate (what the app quoted the
  // rider), snapshotted as fee_rate. blink_cash_settings keeps limits / expiry.
  const quote = await quoteBlinkCashFee({ type: "deposit", amount: body.amount, riderId: user.id });
  const { fee_rate } = quote;
  // A whole-dinar gateway (Chargily / SATIM) rounds the fee up to make the
  // card charge whole; the row records exactly what is charged.
  const fees = online ? gatewayFees(body.payment_method!, body.amount, quote.fees) : quote.fees;
  const total = online ? round2(body.amount + fees) : quote.total;

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
      pending_id: electronic || online ? null : randomUUID(),
      expires_at: electronic || online ? null : expiresAtFor(settings.pending_expiry_minutes),
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
    if (winner) return c.json({ transaction: winner, checkout: await pendingCheckout(winner) }, 200);
  }
  if (error || !data) {
    return c.json({ error: error?.message ?? "Could not create the deposit" }, 400);
  }

  if (online) {
    // The card is charged the whole total (amount + Blink fee); the wallet gets `amount`.
    try {
      const payment = await startCheckout({
        userId: user.id,
        purpose: "wallet_topup",
        refId: data.id,
        amount: Number(data.total),
        method: body.payment_method!,
        locale: body.locale,
        description: "Blink Cash",
      });
      return c.json({ transaction: data, checkout: toCheckout(payment) }, 201);
    } catch (e) {
      // Nothing was charged: drop the request so it does not count toward the limits.
      await cancelTransaction(data.id, "rider", user.id);
      if (e instanceof PaymentStartError && e.code === "method_unavailable") {
        return c.json({ error: e.message, code: "method_unavailable" as const }, 400);
      }
      return c.json({ error: (e as Error).message }, 502);
    }
  }

  void notifyAgentOfRequest(data);
  return c.json({ transaction: data, checkout: null }, 201);
});

/** The open checkout of a still-pending online deposit (a client_ref replay returns the same one). */
async function pendingCheckout(tx: { id: string; method?: string | null; status?: string | null }) {
  if (tx.method !== "online" || tx.status !== "pending") return null;
  const { data } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("purpose", "wallet_topup")
    .eq("ref_id", tx.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.checkout_url ? toCheckout(data) : null;
}

export default app;
