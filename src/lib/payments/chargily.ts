// Chargily Pay v2 adapter (EDAHABIA + CIB, DZD). Docs: https://dev.chargily.com/pay-v2
//   test API  https://pay.chargily.net/test/api/v2   live  https://pay.chargily.net/api/v2
//   auth      Authorization: Bearer <secret key>
//   amount    INTEGER dinars (callers make the total whole, see gatewayFees)
//   webhook   header `signature` = hex HMAC-SHA256(raw body, secret key)
import { env } from "../../config/env";
import { chargilyEventStatus, mapChargilyStatus, verifyHmacSha256Hex } from "./core";
import { ProviderError, type PaymentProvider, type ParsedEvent } from "./types";

const base = () =>
  env.CHARGILY_MODE === "live" ? "https://pay.chargily.net/api/v2" : "https://pay.chargily.net/test/api/v2";
// Chargily closes a checkout by itself after 30 minutes.
const CHARGILY_TTL_MIN = 30;

async function call(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CHARGILY_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ProviderError(`Chargily unreachable: ${(e as Error).message}`, "chargily");
  }
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok) {
    throw new ProviderError(`Chargily ${res.status}: ${body?.message ?? res.statusText}`, "chargily");
  }
  return body ?? {};
}

export const chargily: PaymentProvider = {
  id: "chargily",
  methods: ["edahabia", "cib"],
  // POST /checkouts answers 422 "amount must be greater than or equal to 50".
  minAmount: 50,
  isConfigured: () => !!env.CHARGILY_SECRET_KEY,
  // Mode follows the key prefix when it has one (test_sk_ / live_sk_), else CHARGILY_MODE.
  testMode: () =>
    env.CHARGILY_SECRET_KEY?.startsWith("test_") ? true : env.CHARGILY_SECRET_KEY?.startsWith("live_") ? false : env.CHARGILY_MODE !== "live",

  async createCheckout(i) {
    const out = await call("/checkouts", {
      method: "POST",
      body: JSON.stringify({
        amount: Math.round(i.amount),
        currency: "dzd",
        payment_method: i.method,
        success_url: i.successUrl,
        failure_url: i.failureUrl,
        ...(i.webhookUrl ? { webhook_endpoint: i.webhookUrl } : {}),
        locale: i.locale,
        description: i.description,
        // Blink absorbs Chargily's fee, so the customer is charged exactly `amount`.
        chargily_pay_fees_allocation: "merchant",
        metadata: { payment_id: i.paymentId },
      }),
    });
    if (!out.id || !out.checkout_url) throw new ProviderError("Chargily returned no checkout", "chargily");
    return {
      providerRef: String(out.id),
      // Chargily answers http://pay.chargily.dz/… and 301s to https: skip the plain-text hop.
      checkoutUrl: String(out.checkout_url).replace(/^http:\/\//, "https://"),
      livemode: out.livemode === true,
      expiresAt: new Date(Date.now() + Math.min(i.ttlMinutes, CHARGILY_TTL_MIN) * 60_000),
    };
  },

  async fetchStatus(ref) {
    const out = await call(`/checkouts/${encodeURIComponent(ref)}`);
    return {
      status: mapChargilyStatus(out.status),
      amount: typeof out.amount === "number" ? out.amount : null,
      currency: typeof out.currency === "string" ? out.currency : null,
      reference: out.id ? String(out.id) : null,
      failureReason: out.status && out.status !== "paid" ? String(out.status) : null,
    };
  },

  async cancel(ref) {
    await call(`/checkouts/${encodeURIComponent(ref)}/expire`, { method: "POST" });
  },

  verifyWebhook: (raw, headers) => verifyHmacSha256Hex(raw, headers.get("signature"), env.CHARGILY_SECRET_KEY ?? ""),

  parseEvent(raw): ParsedEvent | null {
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!e?.id || typeof e.type !== "string") return null;
    return {
      eventId: String(e.id),
      type: e.type,
      providerRef: e.data?.id ? String(e.data.id) : null,
      hint: chargilyEventStatus(e.type),
    };
  },
};
