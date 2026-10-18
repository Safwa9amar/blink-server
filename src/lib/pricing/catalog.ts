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

// ─── Field specs: the single source for the Zod bounds, the precision rule and
// the `fields` metadata the dashboard renders its inputs from. ─────────────────
export type FieldUnit = "da" | "rate" | "km" | "multiplier";
export type FieldSpec = { unit: FieldUnit; min: number; max: number; step: number };
export type PricingField = FieldSpec & { path: string };

const DECIMALS: Record<FieldUnit, number> = { da: 2, rate: 4, km: 1, multiplier: 2 };
const da = (max: number, min = 0): FieldSpec => ({ unit: "da", min, max, step: 0.01 });
const rateOf = (max: number): FieldSpec => ({ unit: "rate", min: 0, max, step: 0.0001 });
const km = (max: number, min = 0): FieldSpec => ({ unit: "km", min, max, step: 0.1 });
const multiplier = (min: number, max: number): FieldSpec => ({ unit: "multiplier", min, max, step: 0.01 });

/** True when `n` has at most `decimals` decimal places (float-tolerant). */
export function hasAtMostDecimals(n: number, decimals: number): boolean {
  const f = 10 ** decimals;
  return Math.abs(n * f - Math.round(n * f)) < 1e-6;
}

const num = (f: FieldSpec) =>
  z
    .number()
    .min(f.min)
    .max(f.max)
    .refine((n) => hasAtMostDecimals(n, DECIMALS[f.unit]), { message: `At most ${DECIMALS[f.unit]} decimals` });

const SPEC = {
  serviceFee: da(1_000),
  base: da(10_000),
  includedKm: km(100),
  perKm: da(1_000),
  maxKm: km(500, 1),
  extraStop: da(1_000),
  multiplier: multiplier(0.5, 2),
  riderCommission: rateOf(0.5),
  merchantCommission: rateOf(0.5),
  cashFee: rateOf(0.1),
  platformShare: rateOf(1),
  cancelPenalty: da(5_000),
  stampDuty: rateOf(0.2),
  agentTax: rateOf(0.2),
  duesFee: rateOf(0.05),
};

const rate = (f: FieldSpec) => z.object({ rate: num(f) }).strict();
const amount = (f: FieldSpec) => z.object({ amount: num(f) }).strict();

const fareLeg = z
  .object({
    base: num(SPEC.base),
    included_km: num(SPEC.includedKm),
    per_km: num(SPEC.perKm),
    max_km: num(SPEC.maxKm),
  })
  .strict();

const legFields = (prefix: string): PricingField[] => [
  { path: `${prefix}.base`, ...SPEC.base },
  { path: `${prefix}.included_km`, ...SPEC.includedKm },
  { path: `${prefix}.per_km`, ...SPEC.perKm },
  { path: `${prefix}.max_km`, ...SPEC.maxKm },
];

export const PRICING_SCHEMAS = {
  service_fee: amount(SPEC.serviceFee),
  courier_fare: z
    .object({ bicycle: fareLeg, motorcycle: fareLeg, extra_stop_fee: num(SPEC.extraStop) })
    .strict(),
  ride_fare: z.object({ motorcycle: fareLeg }).strict(),
  fare_multiplier: z.object({ multiplier: num(SPEC.multiplier) }).strict(),
  rider_commission_rate: rate(SPEC.riderCommission),
  merchant_commission_rate: rate(SPEC.merchantCommission),
  blink_cash_fee_rate: rate(SPEC.cashFee),
  agent_platform_share: rate(SPEC.platformShare),
  rider_cancel_penalty: amount(SPEC.cancelPenalty),
  stamp_duty_rate: rate(SPEC.stampDuty),
  agent_tax_rate: rate(SPEC.agentTax),
  dues_payment_fee_rate: rate(SPEC.duesFee),
} as const satisfies Record<PricingKey, z.ZodType>;

/** Per-key editable fields (dot paths into the value) — what the dashboard renders inputs from. */
export const PRICING_FIELDS: Record<PricingKey, PricingField[]> = {
  service_fee: [{ path: "amount", ...SPEC.serviceFee }],
  courier_fare: [...legFields("bicycle"), ...legFields("motorcycle"), { path: "extra_stop_fee", ...SPEC.extraStop }],
  ride_fare: legFields("motorcycle"),
  fare_multiplier: [{ path: "multiplier", ...SPEC.multiplier }],
  rider_commission_rate: [{ path: "rate", ...SPEC.riderCommission }],
  merchant_commission_rate: [{ path: "rate", ...SPEC.merchantCommission }],
  blink_cash_fee_rate: [{ path: "rate", ...SPEC.cashFee }],
  agent_platform_share: [{ path: "rate", ...SPEC.platformShare }],
  rider_cancel_penalty: [{ path: "amount", ...SPEC.cancelPenalty }],
  stamp_duty_rate: [{ path: "rate", ...SPEC.stampDuty }],
  agent_tax_rate: [{ path: "rate", ...SPEC.agentTax }],
  dues_payment_fee_rate: [{ path: "rate", ...SPEC.duesFee }],
};

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

/** A wilaya code as stored: "1" … "58" (no leading zeros). */
export const isWilayaCode = (v: string) => /^[1-9]\d?$/.test(v) && Number(v) <= 58;

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
  if (scope.wilaya_code != null) {
    if (!allowed.wilaya) return `${key} can't be scoped by wilaya`;
    if (!isWilayaCode(scope.wilaya_code)) return "wilaya_code must be one of 1 to 58";
  }
  if (scope.merchant_id != null && !allowed.merchant) return `${key} can't be scoped to a merchant`;
  if (scope.agent_id != null && !allowed.agent) return `${key} can't be scoped to an agent`;
  if (scope.merchant_id != null && scope.agent_id != null) return "An override targets a merchant or an agent, not both";
  return null;
}
