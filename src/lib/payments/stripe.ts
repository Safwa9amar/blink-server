// Stripe Checkout Sessions adapter (international cards), via the official SDK.
// Amounts are in the currency's minor unit (x100 unless zero-decimal). It
// charges STRIPE_CURRENCY (default eur); the service converts the dinar total
// at STRIPE_DZD_RATE before calling createCheckout.
import Stripe from "stripe";
import { env } from "../../config/env";
import { fromMinorUnits, mapStripeSession, toMinorUnits } from "./core";
import { ProviderError, type PaymentProvider, type ParsedEvent } from "./types";

let client: Stripe | null = null;
const stripe = () => (client ??= new Stripe(env.STRIPE_SECRET_KEY ?? ""));

// Stripe only accepts a session lifetime between 30 minutes and 24 hours.
const MIN_TTL = 30;

const dzdRate = () => (env.STRIPE_CURRENCY === "dzd" ? null : (env.STRIPE_DZD_RATE ?? null));

const wrap = (e: unknown) => new ProviderError(`Stripe: ${(e as Error).message}`, "stripe");

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  methods: ["card"],
  // A session must be worth at least €0.50. In DZD Stripe converts it itself
  // (≈ 76 DA, moves with its rate): 100 DA keeps a margin.
  get minAmount() {
    const rate = dzdRate();
    return rate ? Math.ceil(0.5 * rate) : 100;
  },
  // Blink amounts are dinars: in euros they are converted at Blink's fixed
  // STRIPE_DZD_RATE, so Stripe stays off until that rate is set.
  isConfigured: () => !!env.STRIPE_SECRET_KEY && (env.STRIPE_CURRENCY === "dzd" || !!env.STRIPE_DZD_RATE),
  testMode: () => !env.STRIPE_SECRET_KEY?.startsWith("sk_live_"),
  chargeCurrency: () => env.STRIPE_CURRENCY.toUpperCase(),
  dzdRate,

  async createCheckout(i) {
    const ttl = Math.min(Math.max(i.ttlMinutes, MIN_TTL + 1), 24 * 60);
    const expiresAt = new Date(Date.now() + ttl * 60_000);
    try {
      const s = await stripe().checkout.sessions.create({
        mode: "payment",
        // The method is "card" (Visa / Mastercard): not the account's other
        // (European, often asynchronous) methods such as Bancontact or EPS.
        allowed_payment_method_types: ["card"],
        client_reference_id: i.paymentId,
        metadata: { payment_id: i.paymentId },
        payment_intent_data: { metadata: { payment_id: i.paymentId } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: i.currency.toLowerCase(),
              unit_amount: toMinorUnits(i.amount, i.currency),
              product_data: { name: i.description },
            },
          },
        ],
        success_url: i.successUrl,
        cancel_url: i.failureUrl,
        locale: i.locale === "fr" ? "fr" : i.locale === "en" ? "en" : "auto",
        expires_at: Math.floor(expiresAt.getTime() / 1000),
      });
      if (!s.url) throw new Error("no checkout url");
      return { providerRef: s.id, checkoutUrl: s.url, livemode: s.livemode, expiresAt };
    } catch (e) {
      throw wrap(e);
    }
  },

  async fetchStatus(ref) {
    try {
      const s = await stripe().checkout.sessions.retrieve(ref);
      const currency = s.currency ?? null;
      return {
        status: mapStripeSession(s),
        amount: s.amount_total != null && currency ? fromMinorUnits(s.amount_total, currency) : null,
        currency,
        reference: typeof s.payment_intent === "string" ? s.payment_intent : s.id,
        failureReason: s.status === "expired" ? "expired" : null,
      };
    } catch (e) {
      throw wrap(e);
    }
  },

  async cancel(ref) {
    try {
      await stripe().checkout.sessions.expire(ref);
    } catch (e) {
      throw wrap(e);
    }
  },

  // constructEvent checks the signed header against the RAW body.
  verifyWebhook(raw, headers) {
    const sig = headers.get("stripe-signature");
    if (!sig || !env.STRIPE_WEBHOOK_SECRET) return false;
    try {
      stripe().webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET);
      return true;
    } catch {
      return false;
    }
  },

  parseEvent(raw): ParsedEvent | null {
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!e?.id || typeof e.type !== "string") return null;
    const obj = e.data?.object;
    let hint: ParsedEvent["hint"] = null;
    if (e.type === "checkout.session.completed") hint = obj?.payment_status === "paid" ? "paid" : null;
    else if (e.type === "checkout.session.async_payment_succeeded") hint = "paid";
    else if (e.type === "checkout.session.async_payment_failed") hint = "failed";
    else if (e.type === "checkout.session.expired") hint = "expired";
    return { eventId: e.id, type: e.type, providerRef: obj?.object === "checkout.session" ? String(obj.id) : null, hint };
  },
};
