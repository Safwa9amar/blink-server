// Staff actions on a Blink Cash transaction: cancel a stuck one, approve /
// reject an electronic request under review, reverse a completed one. The money
// moves inside the SQL functions (blink_cash_*); here we map their errors,
// audit and tell the rider. Tagged admin-* so orval skips it.
import type { TxnEvent } from "../../lib/blink-cash-copy";
import { txnEventCopy } from "../../lib/blink-cash-copy";
import { round2 } from "../../lib/blink-cash-admin";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  ApproveTransactionBody,
  ReasonBody,
  StaffTransactionResponse,
  TransactionIdParam,
} from "../../validators/blink-cash-admin";
import { callRpc, notifyUser, RIDER_BLINK_CASH_HREF, staff } from "./admin-shared";

const app = router();

const TAG = ["admin-blink-cash"];

type Txn = Record<string, any>;

async function loadTxn(id: string): Promise<Txn | null> {
  const { data, error } = await supabaseAdmin.from("transactions").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`[blink-cash-admin] transaction read failed: ${error.message}`);
  return (data ?? null) as Txn | null;
}

async function fresh(id: string, fallback: Txn): Promise<Txn> {
  return (await loadTxn(id)) ?? fallback;
}

async function finish(opts: {
  actorId: string;
  txn: Txn;
  action: string;
  event: TxnEvent;
  reason?: string;
  details?: Record<string, unknown>;
}) {
  const { actorId, txn, action, event, reason, details } = opts;
  const amount = round2(Number(txn.amount));
  await recordFinanceAudit({
    actorId,
    action,
    targetType: "transaction",
    targetId: txn.id,
    amount,
    reason,
    details: { type: txn.type, user_id: txn.user_id, status_before: txn.status, ...details },
  });
  await notifyUser({
    userId: txn.user_id,
    role: "rider",
    copy: txnEventCopy(event, txn.type, amount),
    href: RIDER_BLINK_CASH_HREF,
    payload: { kind: `transaction_${event}`, transaction_id: txn.id },
    createdBy: actorId,
  });
}

const responses = {
  200: json(StaffTransactionResponse),
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: errorResponses[409],
} as const;

// ─── Cancel a stuck pending / review transaction ─────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/transactions/{id}/cancel",
    operationId: "cancelBlinkCashTransactionAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: TransactionIdParam, body: { ...json(ReasonBody), required: true } },
    responses,
  }),
  async (c) => {
    const actor = c.get("user");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const txn = await loadTxn(id);
    if (!txn) return c.json({ error: "Transaction not found", code: "not_found" }, 404);

    const r = await callRpc("blink_cash_cancel", { p_txn: id, p_reason: "staff", p_actor: actor.id });
    if (!r.ok) return r.status === 404 ? c.json(r.body, 404) : c.json(r.body, 409);
    // The SQL function records who / why-class; the staff's own words go on the row.
    await supabaseAdmin.from("transactions").update({ staff_note: reason }).eq("id", id);

    await finish({ actorId: actor.id, txn, action: "transaction.cancel", event: "cancelled", reason });
    return c.json({ transaction: await fresh(id, txn) }, 200);
  }
);

// ─── Electronic review: approve / reject ─────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/transactions/{id}/approve",
    operationId: "approveBlinkCashTransactionAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: TransactionIdParam, body: { ...json(ApproveTransactionBody), required: true } },
    responses,
  }),
  async (c) => {
    const actor = c.get("user");
    const { id } = c.req.valid("param");
    const { reference } = c.req.valid("json");
    const txn = await loadTxn(id);
    if (!txn) return c.json({ error: "Transaction not found", code: "not_found" }, 404);

    const r = await callRpc("blink_cash_approve", { p_txn: id, p_actor: actor.id, p_reference: reference });
    if (!r.ok) return r.status === 404 ? c.json(r.body, 404) : c.json(r.body, 409);

    await finish({ actorId: actor.id, txn, action: "transaction.approve", event: "approved", details: { reference } });
    return c.json({ transaction: await fresh(id, txn) }, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/transactions/{id}/reject",
    operationId: "rejectBlinkCashTransactionAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: TransactionIdParam, body: { ...json(ReasonBody), required: true } },
    responses,
  }),
  async (c) => {
    const actor = c.get("user");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const txn = await loadTxn(id);
    if (!txn) return c.json({ error: "Transaction not found", code: "not_found" }, 404);
    // Rejecting is for the review queue only; a plain pending one is a cancel.
    if (txn.status !== "review") {
      return c.json({ error: "The transaction is not awaiting review", code: "not_in_review" }, 409);
    }

    const r = await callRpc("blink_cash_cancel", { p_txn: id, p_reason: "rejected", p_actor: actor.id });
    if (!r.ok) return r.status === 404 ? c.json(r.body, 404) : c.json(r.body, 409);
    await supabaseAdmin.from("transactions").update({ staff_note: reason }).eq("id", id);

    await finish({ actorId: actor.id, txn, action: "transaction.reject", event: "rejected", reason });
    return c.json({ transaction: await fresh(id, txn) }, 200);
  }
);

// ─── Reverse a completed transaction ─────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/transactions/{id}/reverse",
    operationId: "reverseBlinkCashTransactionAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: TransactionIdParam, body: { ...json(ReasonBody), required: true } },
    responses,
  }),
  async (c) => {
    const actor = c.get("user");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const txn = await loadTxn(id);
    if (!txn) return c.json({ error: "Transaction not found", code: "not_found" }, 404);

    const r = await callRpc("blink_cash_reverse", { p_txn: id, p_actor: actor.id, p_reason: reason });
    if (!r.ok) return r.status === 404 ? c.json(r.body, 404) : c.json(r.body, 409);

    await finish({
      actorId: actor.id,
      txn,
      action: "transaction.reverse",
      event: "reversed",
      reason,
      details: { bonus_amount: txn.bonus_amount ?? null, agent_id: txn.agent_id ?? null },
    });
    return c.json({ transaction: await fresh(id, txn) }, 200);
  }
);

export default app;
