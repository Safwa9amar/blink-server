// The pricing catalog: every configurable fee/rate, its value schema (with
// bounds), group, which scopes an override may target, and the seed — today's
// hard-coded constant, so an empty/unreachable DB prices exactly as before.
// Spec: blink/docs/superpowers/specs/2026-10-18-pricing-config-design.md.
// Amounts are DZD; rates are fractions (0.05 = 5%).
// Zone pricing (specs/2026-10-29-zone-pricing-design.md) adds the fare formula,
// the drop-off surcharge, the service-area switch and the unzoned tier, and lets
// an override target a drawn zone or a tier.
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
  "fare_formula",
  "dropoff_surcharge",
  "service_area",
  "zone_defaults",
] as const;
export type PricingKey = (typeof PRICING_KEYS)[number];

export const isPricingKey = (k: string): k is PricingKey => (PRICING_KEYS as readonly string[]).includes(k);

// ─── Field specs: the single source for the Zod bounds, the precision rule and
// the `fields` metadata the dashboard renders its inputs from. ─────────────────
// bool / choice / tier carry no numeric bounds (min = max = step = 0 for choice
// and tier, 0..1 for bool); `options` lists the allowed values (tier: filled
// with the live tier codes by the catalog endpoint).
export type FieldUnit = "da" | "rate" | "km" | "multiplier" | "kmh" | "min" | "bool" | "choice" | "tier";
export type FieldSpec = { unit: FieldUnit; min: number; max: number; step: number; options?: string[] };
export type PricingField = FieldSpec & { path: string };

const DECIMALS: Record<FieldUnit, number> = { da: 2, rate: 4, km: 1, multiplier: 2, kmh: 0, min: 0, bool: 0, choice: 0, tier: 0 };
const da = (max: number, min = 0): FieldSpec => ({ unit: "da", min, max, step: 0.01 });
const rateOf = (max: number): FieldSpec => ({ unit: "rate", min: 0, max, step: 0.0001 });
const km = (max: number, min = 0): FieldSpec => ({ unit: "km", min, max, step: 0.1 });
const multiplier = (min: number, max: number): FieldSpec => ({ unit: "multiplier", min, max, step: 0.01 });
const kmh = (min: number, max: number): FieldSpec => ({ unit: "kmh", min, max, step: 1 });
const minutes = (max: number): FieldSpec => ({ unit: "min", min: 0, max, step: 1 });
const flag: FieldSpec = { unit: "bool", min: 0, max: 1, step: 1 };
const choiceOf = (options: string[]): FieldSpec => ({ unit: "choice", min: 0, max: 0, step: 0, options });
const tierField: FieldSpec = { unit: "tier", min: 0, max: 0, step: 0, options: [] };

/** A tier code: lower-case slug, 2–24 chars. */
export const TIER_CODE_RE = /^[a-z][a-z0-9_]{1,23}$/;
export const ROUNDING_MODES = ["up", "nearest", "down"] as const;

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
const whole = (f: FieldSpec) => z.number().int().min(f.min).max(f.max);

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
  perMinute: da(1_000),
  roadFactor: multiplier(1, 3),
  roundingStep: { unit: "da", min: 1, max: 100, step: 1 } as FieldSpec,
  roundingMode: choiceOf([...ROUNDING_MODES]),
  minFare: da(10_000),
  maxFare: da(100_000),
  minRideKm: km(10),
  speed: kmh(5, 120),
  stopMinutes: minutes(60),
  boardingMinutes: minutes(30),
  surcharge: da(5_000),
};

/** Today's constants for the formula (courier-pricing.ts / ride-pricing.ts / fare.ts). */
const FORMULA_SEED = {
  road_factor: 1.3,
  rounding_step: 10,
  rounding_mode: "up" as (typeof ROUNDING_MODES)[number],
  min_fare: 0,
  max_fare: 0,
  min_ride_km: 0.3,
  speed_kmh: { bicycle: 14, motorcycle: 28 },
  stop_minutes: 3,
  boarding_minutes: 2,
};

const rate = (f: FieldSpec) => z.object({ rate: num(f) }).strict();
const amount = (f: FieldSpec) => z.object({ amount: num(f) }).strict();

const fareLeg = z
  .object({
    base: num(SPEC.base),
    included_km: num(SPEC.includedKm),
    per_km: num(SPEC.perKm),
    max_km: num(SPEC.maxKm),
    // Added by zone pricing: rows stored before it have none, so default it.
    per_minute: num(SPEC.perMinute).default(0),
  })
  .strict();

const fareFormula = z
  .object({
    road_factor: num(SPEC.roadFactor).default(FORMULA_SEED.road_factor),
    rounding_step: whole(SPEC.roundingStep).default(FORMULA_SEED.rounding_step),
    rounding_mode: z.enum(ROUNDING_MODES).default(FORMULA_SEED.rounding_mode),
    min_fare: num(SPEC.minFare).default(FORMULA_SEED.min_fare),
    max_fare: num(SPEC.maxFare).default(FORMULA_SEED.max_fare),
    min_ride_km: num(SPEC.minRideKm).default(FORMULA_SEED.min_ride_km),
    speed_kmh: z
      .object({
        bicycle: whole(SPEC.speed).default(FORMULA_SEED.speed_kmh.bicycle),
        motorcycle: whole(SPEC.speed).default(FORMULA_SEED.speed_kmh.motorcycle),
      })
      .strict()
      .default(FORMULA_SEED.speed_kmh),
    stop_minutes: whole(SPEC.stopMinutes).default(FORMULA_SEED.stop_minutes),
    boarding_minutes: whole(SPEC.boardingMinutes).default(FORMULA_SEED.boarding_minutes),
  })
  .strict()
  .refine((v) => v.max_fare === 0 || v.max_fare >= v.min_fare, { message: "max_fare must be 0 (off) or at least min_fare", path: ["max_fare"] });

const legFields = (prefix: string): PricingField[] => [
  { path: `${prefix}.base`, ...SPEC.base },
  { path: `${prefix}.included_km`, ...SPEC.includedKm },
  { path: `${prefix}.per_km`, ...SPEC.perKm },
  { path: `${prefix}.max_km`, ...SPEC.maxKm },
  { path: `${prefix}.per_minute`, ...SPEC.perMinute },
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
  fare_formula: fareFormula,
  dropoff_surcharge: z
    .object({ amount: num(SPEC.surcharge).default(0), only_when_tier_changes: z.boolean().default(true) })
    .strict(),
  service_area: z.object({ enabled: z.boolean().default(true) }).strict(),
  zone_defaults: z.object({ unzoned_tier: z.string().regex(TIER_CODE_RE).default("rural") }).strict(),
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
  fare_formula: [
    { path: "road_factor", ...SPEC.roadFactor },
    { path: "rounding_step", ...SPEC.roundingStep },
    { path: "rounding_mode", ...SPEC.roundingMode },
    { path: "min_fare", ...SPEC.minFare },
    { path: "max_fare", ...SPEC.maxFare },
    { path: "min_ride_km", ...SPEC.minRideKm },
    { path: "speed_kmh.bicycle", ...SPEC.speed },
    { path: "speed_kmh.motorcycle", ...SPEC.speed },
    { path: "stop_minutes", ...SPEC.stopMinutes },
    { path: "boarding_minutes", ...SPEC.boardingMinutes },
  ],
  dropoff_surcharge: [
    { path: "amount", ...SPEC.surcharge },
    { path: "only_when_tier_changes", ...flag },
  ],
  service_area: [{ path: "enabled", ...flag }],
  zone_defaults: [{ path: "unzoned_tier", ...tierField }],
};

export type PricingValue<K extends PricingKey> = z.infer<(typeof PRICING_SCHEMAS)[K]>;

export type PricingGroup = "customer" | "partner" | "tax" | "formula" | "zones";

export type PricingScopes = {
  /** Allowed `service` values; null = the key has no service scope. */
  service: string[] | null;
  wilaya: boolean;
  merchant: boolean;
  agent: boolean;
  /** An override may target one drawn zone (never together with wilaya or tier). */
  zone: boolean;
  /** An override may target a tier (may combine with wilaya). */
  tier: boolean;
};

const ORDER_SERVICES = ["merchant", "shopper"];
const ALL_SERVICES = ["merchant", "shopper", "courier", "ride"];
const FARE_SERVICES = ["courier", "ride"];
const noScope: PricingScopes = { service: null, wilaya: false, merchant: false, agent: false, zone: false, tier: false };
/** wilaya + zone + tier scopes (no partner). */
const placed = (service: string[] | null): PricingScopes => ({ service, wilaya: true, merchant: false, agent: false, zone: true, tier: true });

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
  fare_formula: "formula",
  dropoff_surcharge: "customer",
  service_area: "zones",
  zone_defaults: "zones",
};

export const PRICING_SCOPES: Record<PricingKey, PricingScopes> = {
  service_fee: placed(ORDER_SERVICES),
  courier_fare: placed(null),
  ride_fare: placed(null),
  fare_multiplier: placed(FARE_SERVICES),
  rider_commission_rate: placed(ALL_SERVICES),
  merchant_commission_rate: { ...placed(null), merchant: true },
  blink_cash_fee_rate: { service: ["deposit", "withdrawal"], wilaya: true, merchant: false, agent: false, zone: false, tier: false },
  agent_platform_share: { service: null, wilaya: true, merchant: false, agent: true, zone: false, tier: false },
  rider_cancel_penalty: { ...noScope, service: ALL_SERVICES },
  stamp_duty_rate: noScope,
  agent_tax_rate: noScope,
  dues_payment_fee_rate: noScope,
  fare_formula: placed(FARE_SERVICES),
  dropoff_surcharge: placed(FARE_SERVICES),
  service_area: placed(FARE_SERVICES),
  zone_defaults: { ...noScope, wilaya: true },
};

/** Display hint for the dashboard: how to render/edit a key's value. */
export type PricingUnit = "da" | "percent" | "multiplier" | "fare" | "formula" | "surcharge" | "toggle" | "tier";
export const PRICING_UNITS: Record<PricingKey, PricingUnit> = {
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
  fare_formula: "formula",
  dropoff_surcharge: "surcharge",
  service_area: "toggle",
  zone_defaults: "tier",
};

/** Today's constants (lib/service-fee.ts, courier-pricing.ts, ride-pricing.ts, cash-jobs.ts, …). */
export const PRICING_SEEDS: { [K in PricingKey]: PricingValue<K> } = {
  service_fee: { amount: 1.5 },
  courier_fare: {
    bicycle: { base: 140, included_km: 2, per_km: 35, max_km: 10, per_minute: 0 },
    motorcycle: { base: 250, included_km: 3, per_km: 40, max_km: 40, per_minute: 0 },
    extra_stop_fee: 60,
  },
  ride_fare: { motorcycle: { base: 200, included_km: 3, per_km: 40, max_km: 40, per_minute: 0 } },
  fare_multiplier: { multiplier: 1 },
  rider_commission_rate: { rate: 0.15 },
  merchant_commission_rate: { rate: 0.05 },
  blink_cash_fee_rate: { rate: 0.02 },
  agent_platform_share: { rate: 0.2 },
  rider_cancel_penalty: { amount: 200 },
  stamp_duty_rate: { rate: 0.01 },
  agent_tax_rate: { rate: 0.01 },
  dues_payment_fee_rate: { rate: 0.002 },
  fare_formula: FORMULA_SEED,
  dropoff_surcharge: { amount: 0, only_when_tier_changes: true },
  service_area: { enabled: true },
  zone_defaults: { unzoned_tier: "rural" },
};

/** The tiers seeded by the migration (the runtime snapshot uses them when the DB is unreachable). */
export const TIER_SEEDS = [
  { code: "urban", names: { en: "Urban", fr: "Urbain", ar: "حضري" }, color: "#2563EB", sort_order: 1 },
  { code: "town", names: { en: "Town", fr: "Ville moyenne", ar: "بلدة" }, color: "#16A34A", sort_order: 2 },
  { code: "rural", names: { en: "Rural", fr: "Rural", ar: "ريفي" }, color: "#D97706", sort_order: 3 },
] as const;

/** A wilaya code as stored: "1" … "58" (no leading zeros). */
export const isWilayaCode = (v: string) => /^[1-9]\d?$/.test(v) && Number(v) <= 58;

/**
 * Check an override's scope against the key's allowed scopes. Returns an error
 * message, or null when fine. (A partner can be a merchant OR an agent, never both.)
 */
export function scopeError(
  key: PricingKey,
  scope: {
    service?: string | null;
    wilaya_code?: string | null;
    merchant_id?: string | null;
    agent_id?: string | null;
    zone_id?: string | null;
    tier?: string | null;
  }
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
  if (scope.zone_id != null) {
    if (!allowed.zone) return `${key} can't be scoped by zone`;
    // A zone already implies its wilaya and tier.
    if (scope.wilaya_code != null) return "A zone override can't also target a wilaya";
    if (scope.tier != null) return "A zone override can't also target a tier";
  }
  if (scope.tier != null) {
    if (!allowed.tier) return `${key} can't be scoped by tier`;
    if (!TIER_CODE_RE.test(scope.tier)) return "tier must be a tier code";
  }
  return null;
}
