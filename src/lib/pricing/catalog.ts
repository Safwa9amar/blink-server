// The pricing catalog: every configurable fee/rate, its value schema (with
// bounds), group, which scopes an override may target, and the seed — today's
// hard-coded constant, so an empty/unreachable DB prices exactly as before.
// Spec: blink/docs/superpowers/specs/2026-10-18-pricing-config-design.md.
// Amounts are DZD; rates are fractions (0.05 = 5%).
import { z } from "@hono/zod-openapi";

export const PRICING_KEYS = [
  "service_fee",
  "courier_fare",
  "ride_fare",
  "fare_multiplier",
  "rider_commission_rate",
  "merchant_commission_rate",
  "blink_cash_fee_rate",
  "agent_platform_share",
  "rider_cancel_penalty",
  "stamp_duty_rate",
  "agent_tax_rate",
  "dues_payment_fee_rate",
] as const;
export type PricingKey = (typeof PRICING_KEYS)[number];

export const isPricingKey = (k: string): k is PricingKey => (PRICING_KEYS as readonly string[]).includes(k);

const rate = (max: number) => z.object({ rate: z.number().min(0).max(max) }).strict();
const amount = (max: number) => z.object({ amount: z.number().min(0).max(max) }).strict();

const fareLeg = z
  .object({
    base: z.number().min(0).max(10_000),
    included_km: z.number().min(0).max(100),
    per_km: z.number().min(0).max(1_000),
    max_km: z.number().min(1).max(500),
  })
  .strict();

export const PRICING_SCHEMAS = {
  service_fee: amount(1_000),
  courier_fare: z
    .object({ bicycle: fareLeg, motorcycle: fareLeg, extra_stop_fee: z.number().min(0).max(1_000) })
    .strict(),
  ride_fare: z.object({ motorcycle: fareLeg }).strict(),
  fare_multiplier: z.object({ multiplier: z.number().min(0.5).max(2) }).strict(),
  rider_commission_rate: rate(0.5),
  merchant_commission_rate: rate(0.5),
  blink_cash_fee_rate: rate(0.1),
  agent_platform_share: rate(1),
  rider_cancel_penalty: amount(5_000),
  stamp_duty_rate: rate(0.2),
  agent_tax_rate: rate(0.2),
  dues_payment_fee_rate: rate(0.05),
} as const satisfies Record<PricingKey, z.ZodType>;

export type PricingValue<K extends PricingKey> = z.infer<(typeof PRICING_SCHEMAS)[K]>;

export type PricingGroup = "customer" | "partner" | "tax";

export type PricingScopes = {
  /** Allowed `service` values; null = the key has no service scope. */
  service: string[] | null;
  wilaya: boolean;
  merchant: boolean;
  agent: boolean;
};

const ORDER_SERVICES = ["merchant", "shopper"];
const ALL_SERVICES = ["merchant", "shopper", "courier", "ride"];
const noScope: PricingScopes = { service: null, wilaya: false, merchant: false, agent: false };

export const PRICING_GROUPS: Record<PricingKey, PricingGroup> = {
  service_fee: "customer",
  courier_fare: "customer",
  ride_fare: "customer",
  fare_multiplier: "customer",
  rider_commission_rate: "partner",
  merchant_commission_rate: "partner",
  blink_cash_fee_rate: "partner",
  agent_platform_share: "partner",
  rider_cancel_penalty: "partner",
  stamp_duty_rate: "tax",
  agent_tax_rate: "tax",
  dues_payment_fee_rate: "tax",
};

export const PRICING_SCOPES: Record<PricingKey, PricingScopes> = {
  service_fee: { service: ORDER_SERVICES, wilaya: true, merchant: false, agent: false },
  courier_fare: { service: null, wilaya: true, merchant: false, agent: false },
  ride_fare: { service: null, wilaya: true, merchant: false, agent: false },
  fare_multiplier: { service: ["courier", "ride"], wilaya: true, merchant: false, agent: false },
  rider_commission_rate: { service: ALL_SERVICES, wilaya: true, merchant: false, agent: false },
  merchant_commission_rate: { service: null, wilaya: true, merchant: true, agent: false },
  blink_cash_fee_rate: { service: ["deposit", "withdrawal"], wilaya: true, merchant: false, agent: false },
  agent_platform_share: { service: null, wilaya: true, merchant: false, agent: true },
  rider_cancel_penalty: { service: ALL_SERVICES, wilaya: false, merchant: false, agent: false },
  stamp_duty_rate: noScope,
  agent_tax_rate: noScope,
  dues_payment_fee_rate: noScope,
};

/** Display hint for the dashboard: how to render/edit a key's value. */
export const PRICING_UNITS: Record<PricingKey, "da" | "percent" | "multiplier" | "fare"> = {
  service_fee: "da",
  courier_fare: "fare",
  ride_fare: "fare",
  fare_multiplier: "multiplier",
  rider_commission_rate: "percent",
  merchant_commission_rate: "percent",
  blink_cash_fee_rate: "percent",
  agent_platform_share: "percent",
  rider_cancel_penalty: "da",
  stamp_duty_rate: "percent",
  agent_tax_rate: "percent",
  dues_payment_fee_rate: "percent",
};

/** Today's constants (lib/service-fee.ts, courier-pricing.ts, ride-pricing.ts, cash-jobs.ts, …). */
export const PRICING_SEEDS: { [K in PricingKey]: PricingValue<K> } = {
  service_fee: { amount: 1.5 },
  courier_fare: {
    bicycle: { base: 140, included_km: 2, per_km: 35, max_km: 10 },
    motorcycle: { base: 250, included_km: 3, per_km: 40, max_km: 40 },
    extra_stop_fee: 60,
  },
  ride_fare: { motorcycle: { base: 200, included_km: 3, per_km: 40, max_km: 40 } },
  fare_multiplier: { multiplier: 1 },
  rider_commission_rate: { rate: 0.15 },
  merchant_commission_rate: { rate: 0.05 },
  blink_cash_fee_rate: { rate: 0.02 },
  agent_platform_share: { rate: 0.2 },
  rider_cancel_penalty: { amount: 200 },
  stamp_duty_rate: { rate: 0.01 },
  agent_tax_rate: { rate: 0.01 },
  dues_payment_fee_rate: { rate: 0.002 },
};

/**
 * Check an override's scope against the key's allowed scopes. Returns an error
 * message, or null when fine. (A partner can be a merchant OR an agent, never both.)
 */
export function scopeError(
  key: PricingKey,
  scope: { service?: string | null; wilaya_code?: string | null; merchant_id?: string | null; agent_id?: string | null }
): string | null {
  const allowed = PRICING_SCOPES[key];
  if (scope.service != null) {
    if (!allowed.service) return `${key} can't be scoped by service`;
    if (!allowed.service.includes(scope.service)) return `${key} service must be one of ${allowed.service.join(", ")}`;
  }
  if (scope.wilaya_code != null && !allowed.wilaya) return `${key} can't be scoped by wilaya`;
  if (scope.merchant_id != null && !allowed.merchant) return `${key} can't be scoped to a merchant`;
  if (scope.agent_id != null && !allowed.agent) return `${key} can't be scoped to an agent`;
  if (scope.merchant_id != null && scope.agent_id != null) return "An override targets a merchant or an agent, not both";
  return null;
}
