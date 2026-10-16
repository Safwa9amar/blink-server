import { feeFor, expiresAtFor } from "../../lib/blink-cash-rules";
import { findByClientRef, isUniqueViolation, limitBreach, notifyAgentOfRequest } from "../../lib/blink-cash-requests";
import { getBlinkCashSettings } from "../../lib/blink-cash-settings";
import { checkPin, pinFailureBody } from "../../lib/pin";
import { createWithdrawal, expirePending, ledgerWallet, walletError } from "../../lib/wallet";
import { backfillRider } from "../../lib/wallet-backfill";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, json, router } from "../../openapi";
import { CashRequestError, createWithdrawalSchema, PinError, TransactionResponse } from "../../validators/transactions";
import { operationAgent } from "../agents/shared";
import { randomUUID } from "crypto";

const app = router();

// ─── Create withdrawal (rider) ──────────────────────────────────────
// The request and a hold on the funds are created together
// (blink_cash_create_withdrawal), so the same money can't be promised twice;
// cancel / expiry release it. The PIN is required when
// blink_cash_settings.require_pin_for_withdrawal is on. Electronic ones (only
// when electronic_enabled) wait in `review` with the rider's payout account.
const route = createRoute({
  method: "post",
  path: "/withdrawal",
  operationId: "createWithdrawal",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { body: { ...json(createWithdrawalSchema), required: true } },
  responses: {
    200: json(TransactionResponse, "Replay of an earlier request with the same client_ref"),
    201: json(TransactionResponse, "Created"),
    400: json(CashRequestError, "Bad request, or a limit / balance rule (code)"),
    403: json(PinError, "Wrong or locked PIN (pin_locked), or a frozen wallet"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const settings = await getBlinkCashSettings();

  const replay = await findByClientRef(user.id, body.client_ref);
  if (replay) return c.json({ transaction: replay }, 200);

  const electronic = body.method === "electronic";
  if (electronic && !settings.electronic_enabled) {
    return c.json(
      { error: "Electronic withdrawals are not available yet. Please use a Blink Cash agent.", code: "electronic_unavailable" as const },
      400
    );
  }
  if (electronic && !body.payout_account) {
    return c.json({ error: "A payout account is required", code: "payout_account_required" as const }, 400);
  }

  if (settings.require_pin_for_withdrawal && !body.pin) {
    return c.json({ error: "Your PIN is required to withdraw", code: "pin_required" as const }, 400);
  }
  if (body.pin) {
    const pin = await checkPin(user, body.pin);
    if (!pin.ok) {
      const f = pinFailureBody(pin);
      return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
    }
  }

  await expirePending(user.id);
  const breach = await limitBreach(user.id, "withdrawal", body.amount, settings);
  if (breach) {
    return c.json({ error: "Amount outside your Blink Cash limits", code: breach.code, limit: breach.limit, used: breach.used }, 400);
  }

  const target = electronic
    ? { agent_id: null, shop_id: null }
    : await operationAgent(body.agent_id, body.shop_id);
  if ("error" in target) {
    return c.json({ error: target.error }, 400);
  }

  // The hold needs the ledger: bring a rider who wasn't backfilled yet onto it
  // (same result as the staff backfill).
  if (!(await ledgerWallet(user.id))) {
    try {
      await backfillRider(user.id);
    } catch (e) {
      console.error("[blink-cash] lazy backfill failed", (e as Error).message);
      return c.json({ error: "Service unavailable, please retry" }, 400);
    }
  }

  const { data, error } = await createWithdrawal({
    userId: user.id,
    amount: body.amount,
    fees: feeFor("withdrawal", body.amount, settings),
    method: body.method,
    agentId: target.agent_id,
    shopId: target.shop_id,
    status: electronic ? "review" : "pending",
    expiresAt: electronic ? null : expiresAtFor(settings.pending_expiry_minutes),
    clientRef: body.client_ref ?? null,
    payoutAccount: electronic ? (body.payout_account ?? null) : null,
    pendingId: electronic ? null : randomUUID(),
  });

  if (isUniqueViolation(error)) {
    const winner = await findByClientRef(user.id, body.client_ref);
    if (winner) return c.json({ transaction: winner }, 200);
  }
  const known = walletError(error);
  if (known) {
    return known.status === 403
      ? c.json({ error: known.body.error, code: "wallet_frozen" as const }, 403)
      : c.json(known.body as { error: string; code: "insufficient_funds" }, 400);
  }
  if (error || !data) {
    return c.json({ error: error?.message ?? "Could not create the withdrawal" }, 400);
  }

  void notifyAgentOfRequest(data);
  return c.json({ transaction: data as any }, 201);
});

export default app;
