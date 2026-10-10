import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { verifyPin } from "../../lib/pin";
import { createNotification } from "../../lib/notifications";
import { withRider } from "../../lib/transactions";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { processTransactionSchema, TransactionResponse } from "../../validators/transactions";
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
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Verify agent PIN
  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }
  const pinValid = await verifyPin(body.pin, user.pin_hash);
  if (!pinValid) {
    // 403, not 401: a wrong PIN must not look like an expired session to the
    // app (its 401 backstop signs the user out).
    return c.json({ error: "Invalid PIN" }, 403);
  }

  // The pending operation; its shop_id is the shop the rider picked, if any.
  const { data: tx } = await supabaseAdmin
    .from("transactions")
    .select("id, status, shop_id")
    .eq("id", body.transaction_id)
    .maybeSingle();
  if (!tx || tx.status !== "pending") {
    return c.json({ error: "Transaction not found or already processed" }, 400);
  }

  const shop = await processingShop(user.id, body.shop_id, tx.shop_id);
  if (body.shop_id && !shop) {
    return c.json({ error: "Shop not found" }, 400);
  }

  const newStatus = body.action === "confirm" ? "completed" : "cancelled";
  const { data, error } = await supabaseAdmin
    .from("transactions")
    .update({ status: newStatus, agent_id: user.id, shop_id: shop?.id ?? null })
    .eq("id", body.transaction_id)
    .eq("status", "pending") // only update pending transactions
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found or already processed" }, 400);
  }

  // Best-effort: a failed push must not fail the confirmation.
  notifyRider(data).catch((e) => console.error("[transactions] rider notify failed", e));

  return c.json({ transaction: await withRider(data) }, 200);
});

export default app;
