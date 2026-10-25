// Payment orchestration: starts a gateway checkout for a wallet top-up or a dues
// payment, keeps the `payments` row in step with the provider (webhooks, polling,
// expiry) and pays the purpose out exactly once.
//
// Safety rules (spec 2026-10-20-payment-gateways-design.md):
//  - fulfil only when the provider reports the exact amount + currency we asked for;
//  - the purpose's own write is idempotent (blink_cash_gateway_complete / dues
//    `status in (pending, cancelled)`), and runs BEFORE the payment is marked
//    paid, so a crash in between is retried by the next sync;
//  - a payment that lands after the request lapsed is still credited.
import { env } from "../../config/env";
import type { PaymentProvider as ProviderEnum } from "../../db";
import { round2 } from "../agent-finance";
import { supabaseAdmin } from "../supabase";
import { cancelTransaction, walletErrorCode } from "../wallet";
import {
  amountMatches,
  convertFromDzd,
  isGatewayMethod,
  isPastExpiry,
  needsSync,
  returnUrl,
  webhookUrl,
  wholeChargeFees,
  type MethodId,
  type PaymentPurposeValue,
  type PaymentStatusValue,
} from "./core";
import { getProvider, providerForMethod, providerForUser } from "./registry";
import { ProviderError, type Locale, type ParsedEvent } from "./types";

type Row = Record<string, any>;

export class PaymentStartError extends Error {
  constructor(readonly code: "method_unavailable" | "gateway_error", message: string) {
    super(message);
  }
}

const basePath = () => env.BASE_PATH;

/** Display names for staff-facing copy (the inbox renders the param as is). */
const PROVIDER_NAMES: Record<ProviderEnum, string> = { chargily: "Chargily", stripe: "Stripe", satim: "SATIM" };

/** The return page a provider sends the customer back to. */
export const paymentReturnUrl = (paymentId: string) => returnUrl(env.PUBLIC_API_URL, basePath(), paymentId);

/**
 * Why `userId` cannot pay `amount` online with `method` right now, as a 400
 * body, or null when it can. Routes check it before writing anything (and
 * before the PIN). The charge is `amount` plus fees, so checking `amount`
 * against the provider floor is enough.
 */
export function gatewayRefusal(method: string, userId: string, amount: number) {
  const provider = isGatewayMethod(method) ? providerForUser(method, userId) : null;
  if (!provider) return { error: "This payment method is not available", code: "method_unavailable" as const };
  if (provider.minAmount && amount < provider.minAmount) {
    return { error: `The minimum online payment is ${provider.minAmount} DZD`, code: "online_min_amount" as const, limit: provider.minAmount };
  }
  return null;
}

/**
 * The fee to record for a gateway charge of `base + fees`. Chargily and SATIM
 * take whole dinars, so the fee is rounded up to make the total whole: the row
 * then records exactly what the card is charged and the ledger matches.
 */
export function gatewayFees(method: MethodId, base: number, fees: number): number {
  if (providerForMethod(method)?.id === "stripe") return round2(fees);
  return wholeChargeFees(base, fees);
}

/** The shape clients get after creating a payment. */
export function toCheckout(p: Row) {
  return {
    payment_id: p.id as string,
    provider: p.provider as ProviderEnum,
    method: p.method as MethodId,
    checkout_url: p.checkout_url as string,
    return_url: paymentReturnUrl(p.id),
    expires_at: (p.expires_at ?? null) as string | null,
  };
}

// ─── Staff alert ─────────────────────────────────────────────────────

/** A critical staff notification (dashboard bell); never throws. */
async function alertStaff(kind: string, payment: Row, summary: string) {
  try {
    await supabaseAdmin.rpc("staff_notify", {
      p_kind: kind,
      p_entity_id: payment.id,
      p_params: { provider: PROVIDER_NAMES[payment.provider as ProviderEnum] ?? payment.provider, amount: Number(payment.amount), purpose: payment.purpose },
      p_summary: summary,
      p_group_key: `${kind}:${payment.id}`,
      p_severity: "critical",
    });
  } catch (e) {
    console.error("[payments] staff alert failed", (e as Error).message);
  }
}

// ─── Start ───────────────────────────────────────────────────────────

export interface StartCheckoutArgs {
  userId: string;
  purpose: PaymentPurposeValue;
  refId: string;
  /** Exact total to charge (before provider rounding). */
  amount: number;
  method: MethodId;
  locale?: Locale;
  description?: string;
}

/**
 * Creates the `payments` row and the provider checkout. Throws PaymentStartError
 * (method_unavailable before anything is written; gateway_error after the row was
 * marked failed) — the caller then cancels the row it created for the purpose.
 */
export async function startCheckout(a: StartCheckoutArgs) {
  const provider = providerForUser(a.method, a.userId);
  if (!provider) throw new PaymentStartError("method_unavailable", "This payment method is not available");

  // Chargily / SATIM take whole dinars. Callers make the total whole through
  // gatewayFees(), so the purpose row and the charge agree; never round here.
  const dzd = round2(a.amount);
  if (provider.id !== "stripe" && !Number.isInteger(dzd)) {
    throw new PaymentStartError("gateway_error", "The amount must be a whole number of dinars");
  }
  // Callers already refused this through gatewayRefusal(); the provider would too.
  if (provider.minAmount && dzd < provider.minAmount) {
    throw new PaymentStartError("gateway_error", `The minimum online payment is ${provider.minAmount} DZD`);
  }
  // A provider charging another currency (Stripe in EUR) gets the dinar total
  // converted at Blink's fixed rate; the row keeps the dinars and the rate.
  const currency = provider.chargeCurrency?.() ?? "DZD";
  const rate = currency === "DZD" ? null : (provider.dzdRate?.() ?? null);
  if (currency !== "DZD" && !rate) throw new PaymentStartError("method_unavailable", "This payment method is not available");
  const charged = rate ? convertFromDzd(dzd, rate) : dzd;

  const { data: row, error } = await supabaseAdmin
    .from("payments")
    .insert({
      user_id: a.userId,
      purpose: a.purpose,
      ref_id: a.refId,
      provider: provider.id,
      method: a.method,
      amount: charged,
      currency,
      livemode: !provider.testMode(),
      metadata: rate ? { base_amount: dzd, base_currency: "DZD", dzd_rate: rate } : {},
    })
    .select()
    .single();
  if (error || !row) throw new PaymentStartError("gateway_error", "Could not start the payment");

  let providerRef: string | null = null;
  try {
    const checkout = await provider.createCheckout({
      paymentId: row.id,
      amount: charged,
      currency,
      method: a.method,
      locale: a.locale ?? "fr",
      description: a.description ?? "Blink",
      successUrl: returnUrl(env.PUBLIC_API_URL, basePath(), row.id, "success"),
      failureUrl: returnUrl(env.PUBLIC_API_URL, basePath(), row.id, "failure"),
      webhookUrl: env.PUBLIC_API_URL && provider.verifyWebhook ? webhookUrl(env.PUBLIC_API_URL, basePath(), provider.id as "chargily" | "stripe") : null,
      ttlMinutes: env.PAYMENT_CHECKOUT_TTL_MINUTES,
    });
    providerRef = checkout.providerRef;
    const expiresAt = (checkout.expiresAt ?? new Date(Date.now() + env.PAYMENT_CHECKOUT_TTL_MINUTES * 60_000)).toISOString();
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("payments")
      .update({
        provider_ref: checkout.providerRef,
        checkout_url: checkout.checkoutUrl,
        livemode: checkout.livemode,
        expires_at: expiresAt,
      })
      .eq("id", row.id)
      .select()
      .single();
    if (upErr || !updated) throw new Error(upErr?.message ?? "update failed");
    return updated as Row;
  } catch (e) {
    const reason = e instanceof ProviderError ? "provider_error" : "internal_error";
    console.error(`[payments] checkout failed (${provider.id}):`, (e as Error).message);
    // The checkout exists at the provider but was not recorded: close it, and keep
    // its ref on the failed row so the late re-check still credits a payment.
    if (providerRef) await provider.cancel?.(providerRef).catch(() => {});
    await supabaseAdmin
      .from("payments")
      .update({ status: "failed", failure_reason: reason, ...(providerRef ? { provider_ref: providerRef } : {}) })
      .eq("id", row.id);
    throw new PaymentStartError("gateway_error", "The payment provider is unavailable, please try again");
  }
}

// ─── Purpose side effects ────────────────────────────────────────────

const DUES_TABLE: Record<"agent_dues" | "merchant_dues", string> = {
  agent_dues: "agent_dues_payments",
  merchant_dues: "merchant_dues_payments",
};

/** Pays the purpose out. Idempotent. Returns false (and alerts) when the target row cannot take it. */
async function applyPaid(payment: Row, reference: string | null): Promise<boolean> {
  if (payment.purpose === "wallet_topup") {
    const { error } = await supabaseAdmin.rpc("blink_cash_gateway_complete", {
      p_txn: payment.ref_id,
      p_reference: reference,
    });
    if (error) {
      console.error("[payments] gateway_complete failed", payment.id, error.message);
      // not_found / not_pending cannot heal by retrying: staff must look.
      if (walletErrorCode(error)) await alertStaff("payment.unfulfilled", payment, `Paid payment cannot credit its deposit (${error.message})`);
      return false;
    }
    return true;
  }

  const table = DUES_TABLE[payment.purpose as "agent_dues" | "merchant_dues"];
  const { error } = await supabaseAdmin
    .from(table)
    .update({ status: "completed", reference, confirmed_at: new Date().toISOString() })
    .eq("id", payment.ref_id)
    .in("status", ["pending", "cancelled"]);
  if (error) {
    console.error("[payments] dues completion failed", payment.id, error.message);
    return false;
  }
  const { data: due } = await supabaseAdmin.from(table).select("status").eq("id", payment.ref_id).maybeSingle();
  if (due?.status !== "completed") {
    await alertStaff("payment.unfulfilled", payment, "Paid payment cannot complete its dues row");
    return false;
  }
  return true;
}

/** Who closed a pending payment: its payer (default) or a staff member. */
export type CancelActor = { by: "user" } | { by: "staff"; actorId: string };

/** The still-pending payment behind a deposit / dues row, if any. */
export async function pendingPaymentFor(purpose: PaymentPurposeValue, refId: string): Promise<Row | null> {
  const { data } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("purpose", purpose)
    .eq("ref_id", refId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** 409 body for staff confirming / rejecting a dues payment the gateway settles. */
export const PAID_ONLINE = { error: "This payment is made online: the payment gateway settles it", code: "paid_online" } as const;

/** Whether a dues payment row is paid through a gateway (it completes or lapses by itself, never by staff). */
export async function isOnlineDuesPayment(purpose: "agent_dues" | "merchant_dues", id: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from(DUES_TABLE[purpose]).select("method").eq("id", id).maybeSingle();
  return !!data && isGatewayMethod(String(data.method));
}

/** Cancels what a dead payment was paying for (deposit cancelled; dues row cancelled). */
async function cancelPurpose(payment: Row, status: PaymentStatusValue, reason: string | null, actor?: CancelActor) {
  if (payment.purpose === "wallet_topup") {
    const { error } =
      actor?.by === "staff"
        ? await cancelTransaction(payment.ref_id, "staff", actor.actorId)
        : await cancelTransaction(payment.ref_id, status === "expired" ? "expired" : "rider", null);
    // not_pending = already cancelled / completed: nothing to do.
    if (error && walletErrorCode(error) !== "not_pending") {
      console.error("[payments] cancel deposit failed", payment.id, error.message);
    }
    return;
  }
  const table = DUES_TABLE[payment.purpose as "agent_dues" | "merchant_dues"];
  const { error } = await supabaseAdmin
    .from(table)
    .update({ status: "cancelled", rejected_reason: reason ?? status })
    .eq("id", payment.ref_id)
    .eq("status", "pending");
  if (error) console.error("[payments] cancel dues failed", payment.id, error.message);
}

// ─── Transitions ─────────────────────────────────────────────────────

/**
 * Pays a payment out after checking the provider-reported amount and currency
 * against what we asked for. Accepts a late payment (payment already
 * expired / canceled / failed). Returns the fresh row.
 */
export async function fulfil(payment: Row, providerAmount: number | null, providerCurrency: string | null, reference: string | null): Promise<Row> {
  if (payment.status === "paid") return payment;

  if (
    providerAmount == null ||
    !providerCurrency ||
    !amountMatches({ amount: Number(payment.amount), currency: payment.currency }, { amount: providerAmount, currency: providerCurrency })
  ) {
    console.error(`[payments] amount mismatch on ${payment.id}: expected ${payment.amount} ${payment.currency}, got ${providerAmount} ${providerCurrency}`);
    await supabaseAdmin.from("payments").update({ failure_reason: "amount_mismatch" }).eq("id", payment.id).in("status", ["pending", "expired", "canceled", "failed"]);
    await alertStaff(
      "payment.amount_mismatch",
      payment,
      `Provider reported ${providerAmount ?? "?"} ${providerCurrency ?? "?"} for a ${payment.amount} ${payment.currency} payment (${payment.provider})`
    );
    return { ...payment, failure_reason: "amount_mismatch" };
  }

  if (!(await applyPaid(payment, reference))) return payment;

  const { data } = await supabaseAdmin
    .from("payments")
    .update({ status: "paid", paid_at: new Date().toISOString(), failure_reason: null, last_synced_at: new Date().toISOString() })
    .eq("id", payment.id)
    .neq("status", "paid")
    .select()
    .maybeSingle();
  if (data) return data as Row;
  const { data: current } = await supabaseAdmin.from("payments").select("*").eq("id", payment.id).single();
  return (current ?? payment) as Row;
}

/** Moves a pending payment to failed / canceled / expired and cancels its purpose. */
export async function failPayment(
  payment: Row,
  status: Exclude<PaymentStatusValue, "pending" | "paid">,
  reason: string | null,
  actor?: CancelActor
): Promise<Row> {
  const { data } = await supabaseAdmin
    .from("payments")
    .update({ status, failure_reason: reason ?? status, last_synced_at: new Date().toISOString() })
    .eq("id", payment.id)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (!data) {
    const { data: current } = await supabaseAdmin.from("payments").select("*").eq("id", payment.id).single();
    return (current ?? payment) as Row;
  }
  await cancelPurpose(data, status, reason, actor);
  return data as Row;
}

/**
 * Re-checks a payment with its provider and applies the outcome. `late` also
 * looks at a payment already closed, to credit money that arrived after it.
 */
export async function syncPayment(payment: Row, opts: { late?: boolean } = {}): Promise<Row> {
  const open = payment.status === "pending";
  if (!open && !(opts.late && payment.status !== "paid")) return payment;
  if (!payment.provider_ref) {
    return open && isPastExpiry(payment.expires_at) ? failPayment(payment, "expired", "expired") : payment;
  }

  const provider = getProvider(payment.provider);
  let result;
  try {
    result = await provider.fetchStatus(payment.provider_ref);
  } catch (e) {
    console.error(`[payments] status check failed (${payment.provider}):`, (e as Error).message);
    return payment;
  }
  await supabaseAdmin.from("payments").update({ last_synced_at: new Date().toISOString() }).eq("id", payment.id);

  if (result.status === "paid") return fulfil(payment, result.amount, result.currency, result.reference);
  if (!open) return payment;
  if (result.status && result.status !== "pending") return failPayment(payment, result.status, result.failureReason ?? result.status);
  if (isPastExpiry(payment.expires_at)) return expireAtProvider(payment);
  return payment;
}

/**
 * Expires a lapsed payment, closing its checkout at the provider first so it
 * can't be paid afterwards. If closing fails, the checkout may have just been
 * paid: one more status check decides.
 */
async function expireAtProvider(payment: Row): Promise<Row> {
  const provider = getProvider(payment.provider);
  if (provider.cancel && payment.provider_ref) {
    try {
      await provider.cancel(payment.provider_ref);
    } catch (e) {
      console.error(`[payments] provider expire failed (${payment.provider}):`, (e as Error).message);
      try {
        const result = await provider.fetchStatus(payment.provider_ref);
        if (result.status === "paid") return fulfil(payment, result.amount, result.currency, result.reference);
      } catch {}
    }
  }
  return failPayment(payment, "expired", "expired");
}

/** Owner / staff read: re-checks a still-pending payment first (unless synced in the last 10 s). */
export async function refreshIfPending(payment: Row): Promise<Row> {
  if (payment.status !== "pending") return payment;
  if (!needsSync(payment.last_synced_at) && !isPastExpiry(payment.expires_at)) return payment;
  return syncPayment(payment);
}

/**
 * Owner / staff cancel (only while pending): closes it at the provider when it
 * can, then cancels the purpose, attributed to `actor`.
 */
export async function cancelPayment(payment: Row, actor: CancelActor = { by: "user" }): Promise<Row> {
  if (payment.status !== "pending") return payment;
  const provider = getProvider(payment.provider);
  if (provider.cancel && payment.provider_ref) {
    try {
      await provider.cancel(payment.provider_ref);
    } catch (e) {
      // The checkout may already be paid / closed: look at the real status first.
      const synced = await syncPayment(payment);
      if (synced.status !== "pending") return synced;
      console.error("[payments] provider cancel failed", (e as Error).message);
    }
  }
  return failPayment(payment, "canceled", actor.by === "staff" ? "canceled_by_staff" : "canceled_by_user", actor);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * Cron sweep:
 *  - closes payments past their expiry (after one last provider check);
 *  - re-checks payments closed in the last day, at most every 30 min, so money
 *    that lands after closing is credited even if its webhook was lost;
 *  - cancels online deposits whose checkout was never recorded (crash between
 *    the two writes), so they stop counting toward the rider's limits.
 * An amount mismatch stays pending for staff and is skipped, not retried forever.
 */
export async function expireStale(limit = 50): Promise<{ expired: number; recovered: number; orphans: number }> {
  const { data: lapsed } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
    .or("failure_reason.is.null,failure_reason.neq.amount_mismatch")
    .order("expires_at")
    .limit(limit);
  let expired = 0;
  for (const p of lapsed ?? []) {
    const after = await syncPayment(p);
    if (after.status !== "pending") expired++;
  }

  const { data: closed } = await supabaseAdmin
    .from("payments")
    .select("*")
    .in("status", ["failed", "canceled", "expired"])
    .not("provider_ref", "is", null)
    .gt("updated_at", minutesAgo(24 * 60))
    .or(`last_synced_at.is.null,last_synced_at.lt.${minutesAgo(30)}`)
    .order("last_synced_at", { nullsFirst: true })
    .limit(20);
  let recovered = 0;
  for (const p of closed ?? []) {
    const after = await syncPayment(p, { late: true });
    if (after.status === "paid") recovered++;
  }

  return { expired, recovered, orphans: await cancelOrphanDeposits() };
}

/** Online deposits still pending well past any checkout lifetime, with no open or paid payment. */
async function cancelOrphanDeposits(): Promise<number> {
  const { data: txns } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("method", "online")
    .eq("status", "pending")
    .lt("created_at", minutesAgo(env.PAYMENT_CHECKOUT_TTL_MINUTES + 60))
    .limit(50);
  let n = 0;
  for (const t of txns ?? []) {
    const { count } = await supabaseAdmin
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("purpose", "wallet_topup")
      .eq("ref_id", t.id)
      .in("status", ["pending", "paid"]);
    if (count) continue;
    const { error } = await cancelTransaction(t.id, "expired", null);
    if (!error) n++;
  }
  return n;
}

// ─── Webhooks ────────────────────────────────────────────────────────

/**
 * Stores a verified webhook event (idempotent by provider + event id) and
 * reconciles its payment with the provider. Never throws for an unknown payment.
 */
export async function handleWebhookEvent(providerId: "chargily" | "stripe", event: ParsedEvent, payload: Record<string, unknown>) {
  const { data: payment } = event.providerRef
    ? await supabaseAdmin.from("payments").select("*").eq("provider", providerId).eq("provider_ref", event.providerRef).maybeSingle()
    : { data: null };

  const { error } = await supabaseAdmin.from("payment_events").insert({
    provider: providerId,
    event_id: event.eventId,
    type: event.type,
    payment_id: payment?.id ?? null,
    // Only the ids: webhook bodies can carry customer / card details.
    payload: { type: event.type, provider_ref: event.providerRef, livemode: payload.livemode ?? null },
  });
  if (error?.code === "23505") {
    // Seen before. Still reconcile an unfinished payment: the first delivery may have died midway.
    if (payment && payment.status === "pending") await syncPayment(payment);
    return;
  }
  if (!payment) return;

  if (event.hint === "failed" && providerId === "stripe") {
    await failPayment(payment, "failed", "async_payment_failed");
    return;
  }
  await syncPayment(payment, { late: event.hint === "paid" });
}

/** SATIM (and any provider without webhooks): confirm on the customer's return. */
export async function confirmOnReturn(payment: Row): Promise<Row> {
  // SATIM has no webhook and no cancel: a return after closing may still be a payment.
  return payment.status === "paid" ? payment : syncPayment(payment, { late: true });
}
