// SATIM CIB direct adapter (RBS REST, https://test.satim.dz/payment/rest in test,
// https://cib.satim.dz/payment/rest live). DISABLED STUB: it reports
// not-configured unless SATIM_USERNAME, SATIM_PASSWORD and SATIM_TERMINAL_ID are
// all set, and has NOT been tested against a SATIM sandbox. It follows the public
// RBS contract: register.do -> formUrl, getOrderStatusExtended.do -> OrderStatus
// (2 = paid), amounts in centimes, currency 012 (DZD). SATIM has no webhook: the
// order is confirmed on return and by polling.
import { env } from "../../config/env";
import { mapSatimOrderStatus } from "./core";
import { ProviderError, type PaymentProvider } from "./types";

const base = () =>
  env.SATIM_MODE === "live" ? "https://cib.satim.dz/payment/rest" : "https://test.satim.dz/payment/rest";

async function call(endpoint: string, params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(`${base()}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        userName: env.SATIM_USERNAME ?? "",
        password: env.SATIM_PASSWORD ?? "",
        ...params,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ProviderError(`SATIM unreachable: ${(e as Error).message}`, "satim");
  }
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || !body) throw new ProviderError(`SATIM ${res.status}`, "satim");
  return body;
}

const orderNumber = (paymentId: string) => paymentId.replace(/-/g, ""); // 32 chars, the RBS maximum

export const satim: PaymentProvider = {
  id: "satim",
  methods: ["cib"],
  isConfigured: () => !!env.SATIM_USERNAME && !!env.SATIM_PASSWORD && !!env.SATIM_TERMINAL_ID,
  testMode: () => env.SATIM_MODE !== "live",

  async createCheckout(i) {
    const out = await call("register.do", {
      orderNumber: orderNumber(i.paymentId),
      amount: String(Math.round(i.amount * 100)),
      currency: "012",
      returnUrl: i.successUrl,
      failUrl: i.failureUrl,
      language: i.locale,
      description: i.description,
      jsonParams: JSON.stringify({ force_terminal_id: env.SATIM_TERMINAL_ID, udf1: orderNumber(i.paymentId) }),
    });
    if (String(out.errorCode ?? "0") !== "0" || !out.orderId || !out.formUrl) {
      throw new ProviderError(`SATIM register failed: ${out.errorMessage ?? out.errorCode ?? "no order"}`, "satim");
    }
    return {
      providerRef: String(out.orderId),
      checkoutUrl: String(out.formUrl),
      livemode: env.SATIM_MODE === "live",
    };
  },

  async fetchStatus(ref) {
    const out = await call("getOrderStatusExtended.do", { orderId: ref, language: "en" });
    const ok = String(out.errorCode ?? "0") === "0";
    const status = ok ? mapSatimOrderStatus(out.orderStatus ?? out.OrderStatus) : null;
    const minor = Number(out.amount);
    return {
      status,
      amount: Number.isFinite(minor) && out.amount != null ? minor / 100 : null,
      currency: out.currency === "012" || out.currency === 12 ? "DZD" : out.currency != null ? String(out.currency) : null,
      reference: ref,
      failureReason: status === "failed" ? String(out.actionCodeDescription ?? out.actionCode ?? "declined") : null,
    };
  },
};
