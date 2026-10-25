// Pure payment-gateway helpers (no env, no network, no database): method →
// provider routing, webhook HMAC, amount / currency matching, provider status →
// payment status, minor-unit conversion and return / webhook URLs. Everything
// money-critical lives here so it can be unit tested (src/lib/payments-core.test.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

export const PROVIDER_IDS = ["chargily", "stripe", "satim"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const METHOD_IDS = ["edahabia", "cib", "card"] as const;
export type MethodId = (typeof METHOD_IDS)[number];

export type PaymentStatusValue = "pending" | "paid" | "failed" | "canceled" | "expired";
export type PaymentPurposeValue = "wallet_topup" | "agent_dues" | "merchant_dues";

export const isGatewayMethod = (m: string): m is MethodId => (METHOD_IDS as readonly string[]).includes(m);

/** A payment in one of these states never changes again. */
export const isFinalStatus = (s: PaymentStatusValue) => s !== "pending";

// ─── Routing ─────────────────────────────────────────────────────────

export interface RoutingConfig {
  /** PAYMENT_CIB_PROVIDER */
  cibProvider: "chargily" | "satim";
  configured: Record<ProviderId, boolean>;
}

/**
 * The provider that serves a method, or null when it is not available.
 * edahabia → chargily; card → stripe; cib → satim only when asked for AND
 * configured, else chargily.
 */
export function routeMethod(method: MethodId, cfg: RoutingConfig): ProviderId | null {
  let provider: ProviderId;
  if (method === "edahabia") provider = "chargily";
  else if (method === "card") provider = "stripe";
  else provider = cfg.cibProvider === "satim" && cfg.configured.satim ? "satim" : "chargily";
  return cfg.configured[provider] ? provider : null;
}

// ─── Webhook signature ───────────────────────────────────────────────

/** Hex HMAC-SHA256 of the raw body, compared in constant time (Chargily's `signature` header). */
export function verifyHmacSha256Hex(rawBody: string, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length !== expected.length * 2) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

// ─── Amounts ─────────────────────────────────────────────────────────

/** Currencies Stripe charges without minor units (the subset that matters here). */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Stripe-style minor units: ×100 unless the currency is zero-decimal. */
export function toMinorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(amount) : Math.round(amount * 100);
}

export function fromMinorUnits(minor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? minor : Math.round(minor) / 100;
}

/**
 * Chargily and SATIM take whole dinars: a total with centimes rounds UP to the
 * next dinar. The service folds the adjustment into the Blink fee
 * (gatewayFees) so the stored row matches the charge.
 */
export function wholeDinars(total: number): { charged: number; adjustment: number } {
  const cents = Math.round(total * 100);
  const charged = Math.ceil(cents / 100);
  return { charged, adjustment: Math.round(charged * 100 - cents) / 100 };
}

/** The fee that makes `base + fee` a whole dinar, rounding up (never charges less than `fees`). */
export function wholeChargeFees(base: number, fees: number): number {
  const baseCents = Math.round(base * 100);
  const totalCents = Math.ceil((baseCents + Math.round(fees * 100)) / 100) * 100;
  return (totalCents - baseCents) / 100;
}

/**
 * A dinar amount in a foreign charge currency at Blink's fixed rate (DZD for
 * one unit), rounded UP to the cent so the charge never falls short.
 */
export function convertFromDzd(dzd: number, dzdPerUnit: number): number {
  return Math.ceil(Math.round(dzd * 100) / dzdPerUnit - 1e-9) / 100;
}

/** Exact match of what the provider reports against what we asked for (to the centime, currency case-insensitive). */
export function amountMatches(
  expected: { amount: number; currency: string },
  reported: { amount: number; currency: string }
): boolean {
  return (
    Number.isFinite(reported.amount) &&
    Math.round(expected.amount * 100) === Math.round(reported.amount * 100) &&
    expected.currency.toLowerCase() === reported.currency.toLowerCase()
  );
}

// ─── Provider status → payment status ────────────────────────────────

/** Chargily checkout status; null = still in flight (pending / processing / unknown). */
export function mapChargilyStatus(status: string | null | undefined): PaymentStatusValue | null {
  switch (status) {
    case "paid":
      return "paid";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    default:
      return null;
  }
}

/** Chargily webhook event type → payment status hint (the re-fetched checkout is what is acted on). */
export function chargilyEventStatus(type: string): PaymentStatusValue | null {
  switch (type) {
    case "checkout.paid":
      return "paid";
    case "checkout.failed":
      return "failed";
    case "checkout.canceled":
      return "canceled";
    case "checkout.expired":
      return "expired";
    default:
      return null;
  }
}

/** Stripe Checkout Session; null = still open or awaiting an async method. */
export function mapStripeSession(s: { status?: string | null; payment_status?: string | null }): PaymentStatusValue | null {
  if (s.payment_status === "paid") return "paid";
  if (s.status === "expired") return "expired";
  return null;
}

/** SATIM / RBS `OrderStatus` of getOrderStatusExtended.do: 2 = deposited (paid). */
export function mapSatimOrderStatus(orderStatus: number | string | null | undefined): PaymentStatusValue | null {
  switch (Number(orderStatus)) {
    case 2:
      return "paid";
    case 3: // reversed
    case 4: // refunded
    case 6: // declined
      return "failed";
    default: // 0 registered, 1 pre-authorised, 5 ACS in progress
      return null;
  }
}

// ─── URLs ────────────────────────────────────────────────────────────

export type Outcome = "success" | "failure";

/** Where a provider sends the customer back to: /payments/return/{id}. */
export function returnUrl(publicApi: string, basePath: string, paymentId: string, outcome?: Outcome): string {
  const url = `${publicApi}${basePath}/payments/return/${paymentId}`;
  return outcome ? `${url}?outcome=${outcome}` : url;
}

export function webhookUrl(publicApi: string, basePath: string, provider: "chargily" | "stripe"): string {
  return `${publicApi}${basePath}/payments/webhooks/${provider}`;
}

/** The app deep link the return page redirects to. */
export function appRedirectUrl(appReturn: string, paymentId: string, outcome: Outcome): string {
  const sep = appReturn.includes("?") ? "&" : "?";
  return `${appReturn}${sep}payment_id=${encodeURIComponent(paymentId)}&outcome=${outcome}`;
}

// ─── Timing ──────────────────────────────────────────────────────────

export const SYNC_MIN_INTERVAL_MS = 10_000;

/** Whether a pending payment should be re-checked with the provider now. */
export function needsSync(lastSyncedAt: string | null | undefined, now = Date.now()): boolean {
  return !lastSyncedAt || now - Date.parse(lastSyncedAt) >= SYNC_MIN_INTERVAL_MS;
}

export function isPastExpiry(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= now;
}
