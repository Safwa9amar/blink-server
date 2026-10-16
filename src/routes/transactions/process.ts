import { AGENT_ACCESS_MESSAGE, canAgentProcess } from "../../lib/agent-access";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { computeAgentDues } from "../../lib/agent-finance";
import { breachesAgentLimit } from "../../lib/blink-cash-rules";
import { agentLimitFor, expireIfLapsed, warnAgentNearLimit } from "../../lib/blink-cash-requests";
import { getBlinkCashSettings } from "../../lib/blink-cash-settings";
import { checkPin, pinFailureBody } from "../../lib/pin";
import { cancelTransaction, completeTransaction, walletError } from "../../lib/wallet";
import { createNotification } from "../../lib/notifications";
import { withRider } from "../../lib/transactions";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  AgentAccessError,
  processTransactionSchema,
  TransactionResponse,
  WalletFunctionError,
} from "../../validators/transactions";
import { processingShop } from "../agents/shared";

const app = router();

type Row = Record<string, any>;

const fmt = (n: number) => `${Math.round(n).toLocaleString("fr-DZ")} DA`;

/** Tell the rider their pending deposit / withdrawal was confirmed or cancelled. */
async function notifyRider(tx: Row) {
  const deposit = tx.type === "deposit";
  const done = tx.status === "completed";
  const amount = fmt(Number(tx.amount));
  const copy = {
    en: {
      title: done
        ? deposit ? "Deposit confirmed" : "Withdrawal confirmed"
        : deposit ? "Deposit cancelled" : "Withdrawal cancelled",
      description: done
        ? deposit
          ? `${amount} was added to your Blink Cash balance.`
          : `${amount} was withdrawn from your Blink Cash balance.`
        : `The agent cancelled your ${deposit ? "deposit" : "withdrawal"} of ${amount}.`,
    },
    fr: {
      title: done
        ? deposit ? "Dépôt confirmé" : "Retrait confirmé"
        : deposit ? "Dépôt annulé" : "Retrait annulé",
      description: done
        ? deposit
          ? `${amount} a été ajouté à votre solde Blink Cash.`
          : `${amount} a été retiré de votre solde Blink Cash.`
        : `L'agent a annulé votre ${deposit ? "dépôt" : "retrait"} de ${amount}.`,
    },
    ar: {
      title: done
        ? deposit ? "تم تأكيد الإيداع" : "تم تأكيد السحب"
        : deposit ? "تم إلغاء الإيداع" : "تم إلغاء السحب",
      description: done
        ? deposit
          ? `تمت إضافة ${amount} إلى رصيد Blink Cash الخاص بك.`
          : `تم سحب ${amount} من رصيد Blink Cash الخاص بك.`
        : `ألغى الوكيل ${deposit ? "إيداعك" : "سحبك"} بقيمة ${amount}.`,
    },
  };
  await createNotification({
    userId: tx.user_id,
    role: "rider",
    type: "alert",
    title: copy.en.title,
    description: copy.en.description,
    contentEng: copy.en,
    contentFr: copy.fr,
    contentAr: copy.ar,
    href: "/(rider)/blink-cash",
  });
}

// ─── Process transaction (agent confirms/cancels via QR) ─────────────
const route = createRoute({
  method: "post",
  path: "/process",
  operationId: "processTransaction",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("agent")] as const,
  request: { body: { ...json(processTransactionSchema), required: true } },
  responses: {
    200: json(TransactionResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(
      AgentAccessError,
      "Forbidden: wrong PIN (no code), pin_locked (with retry_after), shop_not_approved | not_your_transaction"
    ),
    409: json(
      WalletFunctionError,
      "Already processed (not_pending), or the agent's cash limit would be exceeded (agent_limit_reached)"
    ),
    410: json(WalletFunctionError, "The request expired (code expired)"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Verify agent PIN (5 wrong tries lock it for 15 minutes)
  const pin = await checkPin(user, body.pin);
  if (!pin.ok) {
    const f = pinFailureBody(pin);
    return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
  }

  // The operation; agent_id / shop_id are the agent and shop the rider picked,
  // if any (both null for a walk-in).
  const { data: tx } = await supabaseAdmin
    .from("transactions")
    .select("id, user_id, type, amount, status, agent_id, shop_id, expires_at")
    .eq("id", body.transaction_id)
    .maybeSingle();
  // Lazy expiry (pg_cron is the primary): a lapsed QR is never confirmed.
  if (await expireIfLapsed(tx)) {
    return c.json({ error: "This request has expired", code: "expired" as const }, 410);
  }
  if (!tx || tx.status !== "pending") {
    return c.json({ error: "Transaction not found or already processed" }, 400);
  }

  const shop = await processingShop(user.id, body.shop_id, tx.shop_id);
  if (body.shop_id && !shop) {
    return c.json({ error: "Shop not found" }, 400);
  }

  // Only through an approved shop of this agent, and only this agent's (or a
  // walk-in) operation — src/lib/agent-access.ts.
  const access = canAgentProcess({ shop, tx, agentId: user.id });
  if (!access.ok) {
    return c.json({ error: AGENT_ACCESS_MESSAGE[access.code], code: access.code }, 403);
  }

  // The money moves inside one DB transaction that locks the row: status,
  // expiry and the assigned agent are re-checked there (a rider re-picking a
  // shop in between can't slip another agent's operation past the check).
  let dues: Awaited<ReturnType<typeof computeAgentDues>> | null = null;
  let limit = 0;
  if (body.action === "confirm" && tx.type === "deposit") {
    // Confirming a deposit makes the agent hold the rider's cash for Blink.
    const settings = await getBlinkCashSettings();
    [dues, limit] = await Promise.all([computeAgentDues(user.id), agentLimitFor(user.id, settings)]);
    if (breachesAgentLimit("deposit", dues.total_dues, Number(tx.amount), limit)) {
      return c.json(
        { error: "You've reached your cash limit. Pay your dues to Blink first.", code: "agent_limit_reached" as const, limit, total_dues: dues.total_dues },
        409
      );
    }
  }

  const { data, error } =
    body.action === "confirm"
      ? await completeTransaction(tx.id, user.id, shop?.id ?? null)
      : await cancelTransaction(tx.id, "agent", user.id);
  if (error || !data) {
    const known = walletError(error);
    if (known) {
      const code = known.body.code as "not_pending" | "expired" | "wrong_agent" | "wallet_frozen";
      if (known.status === 403) return c.json({ error: known.body.error, code }, 403);
      if (known.status === 410) return c.json({ error: known.body.error, code: "expired" as const }, 410);
      if (known.status === 409) return c.json({ error: known.body.error, code: "not_pending" as const }, 409);
    }
    if (error) console.error("[transactions] process failed", error.message);
    return c.json({ error: "Transaction not found or already processed" }, 400);
  }

  if (dues) void warnAgentNearLimit(user.id, dues.total_dues + Number(tx.amount), limit);

  // Best-effort: a failed push must not fail the confirmation.
  notifyRider(data).catch((e) => console.error("[transactions] rider notify failed", e));

  return c.json({ transaction: await withRider(data) }, 200);
});

export default app;
