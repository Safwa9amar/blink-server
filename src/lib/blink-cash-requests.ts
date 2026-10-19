// Helpers shared by the /transactions routes: usage windows for the limits,
// client_ref replay, lazy expiry, offers, and the pushes to an agent.
import { agentLimit, algiersDayStartIso, algiersMonthStartIso, checkLimits, type CashType, isNearLimit } from "./blink-cash-rules";
import type { BlinkCashSettings } from "./blink-cash-settings";
import { createNotification } from "./notifications";
import { supabaseAdmin } from "./supabase";
import { expirePending } from "./wallet";

type Row = Record<string, any>;

const fmt = (n: number) => `${Math.round(n).toLocaleString("fr-DZ")} DA`;

/** Σ amount of the user's pending + review + completed operations of `type` since `fromIso`. */
async function usedSince(userId: string, type: CashType, fromIso: string) {
  const { data } = await supabaseAdmin
    .from("transactions")
    .select("amount")
    .eq("user_id", userId)
    .eq("type", type)
    .in("status", ["pending", "review", "completed"])
    .gte("created_at", fromIso)
    .limit(5000);
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
}

/** The limit `amount` breaks for this rider (min / max / daily / monthly), or null. */
export async function limitBreach(userId: string, type: CashType, amount: number, settings: BlinkCashSettings) {
  const now = new Date();
  const [today, month] = await Promise.all([
    usedSince(userId, type, algiersDayStartIso(now)),
    usedSince(userId, type, algiersMonthStartIso(now)),
  ]);
  return checkLimits(type, amount, settings, today, month);
}

/** The rider's earlier request with this client_ref (a retry returns it instead of a second one). */
export async function findByClientRef(userId: string, clientRef: string | undefined | null) {
  if (!clientRef) return null;
  const { data } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("user_id", userId)
    .eq("client_ref", clientRef)
    .maybeSingle();
  return data ?? null;
}

/** True for a unique-violation (a lost client_ref race). */
export const isUniqueViolation = (error: { code?: string } | null | undefined) => error?.code === "23505";

/** Whether a pending row's expiry has passed. */
export function isLapsed(tx: Row | null | undefined, now = Date.now()) {
  return !!tx && tx.status === "pending" && !!tx.expires_at && Date.parse(tx.expires_at) <= now;
}

/**
 * Lazy expiry for one row (the pg_cron job is the primary): cancels the owner's
 * lapsed requests, so an expired QR is never confirmed even without cron.
 * Returns true when `tx` had lapsed.
 */
export async function expireIfLapsed(tx: Row | null | undefined) {
  if (!isLapsed(tx)) return false;
  await expirePending(tx!.user_id);
  return true;
}

/** An offer with its numeric columns coerced. */
export async function loadOffer(offerId: string) {
  const { data } = await supabaseAdmin.from("blink_cash_offers").select("*").eq("id", offerId).maybeSingle();
  if (!data) return null;
  return {
    ...data,
    min_deposit: Number(data.min_deposit),
    bonus_value: Number(data.bonus_value),
    max_bonus: data.max_bonus == null ? null : Number(data.max_bonus),
    budget: data.budget == null ? null : Number(data.budget),
    used_amount: Number(data.used_amount ?? 0),
  };
}

/** How many bonuses this rider already earned from the offer. */
export async function offerUses(offerId: string, userId: string) {
  const { count } = await supabaseAdmin
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("offer_id", offerId)
    .eq("user_id", userId)
    .eq("status", "completed")
    .gt("bonus_amount", 0);
  return count ?? 0;
}

// ─── Pushes to the agent ─────────────────────────────────────────────

/** "New deposit / withdrawal request · 5,000 DA" for the agent a rider picked. */
export async function notifyAgentOfRequest(tx: Row | null | undefined) {
  if (!tx?.agent_id) return;
  const deposit = tx.type === "deposit";
  const amount = fmt(Number(tx.amount));
  const copy = {
    en: {
      title: deposit ? "New deposit request" : "New withdrawal request",
      description: `${amount} · open Blink Cash to scan the rider's QR code.`,
    },
    fr: {
      title: deposit ? "Nouvelle demande de dépôt" : "Nouvelle demande de retrait",
      description: `${amount} · ouvrez Blink Cash pour scanner le QR du livreur.`,
    },
    ar: {
      title: deposit ? "طلب إيداع جديد" : "طلب سحب جديد",
      description: `${amount} · افتح Blink Cash لمسح رمز QR الخاص بالسائق.`,
    },
  };
  try {
    await createNotification({
      userId: tx.agent_id,
      role: "agent",
      type: "alert",
      title: copy.en.title,
      description: copy.en.description,
      contentEng: copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
      href: "/(agent)/blink-cash",
    });
  } catch (e) {
    console.error("[blink-cash] agent request push failed", (e as Error).message);
  }
}

/** The agent's cash limit: their own, else the settings default. */
export async function agentLimitFor(agentId: string, settings: BlinkCashSettings) {
  const { data } = await supabaseAdmin
    .from("agent_profiles")
    .select("credit_limit")
    .eq("user_id", agentId)
    .maybeSingle();
  return agentLimit(data?.credit_limit == null ? null : Number(data.credit_limit), settings.agent_credit_limit);
}

/**
 * At >= 80 % of the cash limit, tell the agent — at most once an Algiers day
 * (claimed with one conditional write on agent_profiles.limit_warned_at, so
 * concurrent confirmations send one push). Best effort.
 */
export async function warnAgentNearLimit(agentId: string, totalDues: number, limit: number) {
  if (!isNearLimit(totalDues, limit)) return;
  try {
    const { data: claimed } = await supabaseAdmin
      .from("agent_profiles")
      .update({ limit_warned_at: new Date().toISOString() })
      .eq("user_id", agentId)
      .or(`limit_warned_at.is.null,limit_warned_at.lt.${algiersDayStartIso()}`)
      .select("user_id")
      .maybeSingle();
    if (!claimed) return;
    const used = Math.min(999, Math.round((totalDues / limit) * 100));
    const owed = fmt(totalDues);
    const cap = fmt(limit);
    const copy = {
      en: {
        title: "You're close to your cash limit",
        description: `You hold ${owed} for Blink (${used}% of your ${cap} limit). Pay your dues to keep accepting deposits.`,
      },
      fr: {
        title: "Vous approchez de votre plafond de caisse",
        description: `Vous détenez ${owed} pour Blink (${used}% de votre plafond de ${cap}). Réglez vos dus pour continuer à accepter des dépôts.`,
      },
      ar: {
        title: "اقتربت من سقف النقد",
        description: `بحوزتك ${owed} لصالح Blink (${used}% من سقفك ${cap}). سدّد مستحقاتك لمواصلة قبول الإيداعات.`,
      },
    };
    await createNotification({
      userId: agentId,
      role: "agent",
      type: "alert",
      title: copy.en.title,
      description: copy.en.description,
      contentEng: copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
      href: "/(agent)/blink-cash",
    });
  } catch (e) {
    console.error("[blink-cash] limit warning failed", (e as Error).message);
  }
}
