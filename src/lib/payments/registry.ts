// Provider registry: which adapters exist, which are enabled, and which one serves a method.
import { env } from "../../config/env";
import { METHOD_IDS, PROVIDER_IDS, routeMethod, type MethodId, type ProviderId } from "./core";
import { chargily } from "./chargily";
import { satim } from "./satim";
import { stripeProvider } from "./stripe";
import type { PaymentProvider } from "./types";

const providers: Record<ProviderId, PaymentProvider> = { chargily, stripe: stripeProvider, satim };

export const getProvider = (id: ProviderId) => providers[id];
export const allProviders = () => PROVIDER_IDS.map((id) => providers[id]);

const routing = () => ({
  cibProvider: env.PAYMENT_CIB_PROVIDER,
  configured: {
    chargily: chargily.isConfigured(),
    stripe: stripeProvider.isConfigured(),
    satim: satim.isConfigured(),
  },
});

/** The enabled provider for a method, or null. */
export function providerForMethod(method: MethodId): PaymentProvider | null {
  const id = routeMethod(method, routing());
  return id ? providers[id] : null;
}

export const METHOD_LABELS: Record<MethodId, string> = {
  edahabia: "EDAHABIA",
  cib: "CIB",
  card: "Visa / Mastercard",
};

/**
 * Whether `userId` may pay through `provider`. A test-mode payment credits a
 * REAL wallet (dev and prod share one database) that can be cashed out at an
 * agent, so in production test mode is limited to PAYMENTS_TEST_USER_IDS.
 */
export function providerAllowedFor(provider: PaymentProvider, userId: string): boolean {
  return !provider.testMode() || env.NODE_ENV !== "production" || env.PAYMENTS_TEST_USER_IDS.includes(userId);
}

/** The provider `userId` can pay `method` through right now, or null. */
export function providerForUser(method: MethodId, userId: string): PaymentProvider | null {
  const p = providerForMethod(method);
  return p && providerAllowedFor(p, userId) ? p : null;
}

/** Methods `userId` can be offered right now, in a stable order. */
export function enabledMethods(userId: string) {
  return METHOD_IDS.flatMap((id) => {
    const p = providerForUser(id, userId);
    if (!p) return [];
    return [
      {
        id,
        provider: p.id,
        label: METHOD_LABELS[id],
        test_mode: p.testMode(),
        min_amount: p.minAmount ?? null,
        currency: p.chargeCurrency?.() ?? "DZD",
        dzd_rate: p.dzdRate?.() ?? null,
      },
    ];
  });
}
