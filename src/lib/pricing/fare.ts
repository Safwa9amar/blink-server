// Pure fare arithmetic over a configured rate leg (courier_fare / ride_fare),
// shared by the quote/create flows and the staff preview. The order of
// operations is fixed (spec 2026-10-29-zone-pricing-design.md) and every
// constant comes from the resolved `fare_formula`:
//   raw    = base + metres beyond the included km + drive minutes × per_minute
//            + extra stops + drop-off surcharge
//   scaled = raw × fare_multiplier        (float noise removed)
//   clamp  = max(min_fare, min(scaled, max_fare))   (max_fare 0 = off)
//   fare   = round_to(clamp, rounding_step, rounding_mode)
// With the seed formula this is exactly today's "round up to 10 DA".
import { PRICING_SEEDS, type PricingValue } from "./catalog";

/** One vehicle's rate (the value shape of courier_fare.bicycle, ride_fare.motorcycle, …). */
export type FareLeg = { base: number; included_km: number; per_km: number; max_km: number; per_minute?: number };
export type FareFormula = PricingValue<"fare_formula">;

export const SEED_FORMULA: FareFormula = PRICING_SEEDS.fare_formula;

export type FareStep = "base" | "distance" | "time" | "extra_stops" | "dropoff_surcharge" | "multiplier" | "clamp" | "rounding";
export type FareBreakdown = { fare: number; steps: { step: FareStep; amount: number }[] };

/** Round to the nearest micro-unit: 200 × 1.1 = 220.00000000000003 must not ceil to 230. */
const clean = (n: number) => Math.round(n * 1e6) / 1e6;

/** Round `x` to a multiple of `step`: up = ceil, down = floor, nearest = round. */
export function roundTo(x: number, step: number, mode: FareFormula["rounding_mode"]) {
  const q = clean(x / step);
  const n = mode === "up" ? Math.ceil(q) : mode === "down" ? Math.floor(q) : Math.round(q);
  return clean(n * step);
}

/** Minutes behind the wheel for `km` at `speedKmh` (a duration, not a price). */
export const driveMinutes = (km: number, speedKmh: number) => (km / speedKmh) * 60;

export type FareOpts = {
  stops?: number;
  extraStopFee?: number;
  multiplier?: number;
  formula?: FareFormula;
  /** Drop-off surcharge in DA (already resolved against the pickup/drop-off tiers). */
  surcharge?: number;
  /** The vehicle's speed (formula.speed_kmh[vehicle]); only needed when per_minute > 0. */
  speedKmh?: number;
};

/** The fare plus each step's contribution; the steps sum to the fare. */
export function fareBreakdown(leg: FareLeg, km: number, opts: FareOpts = {}): FareBreakdown {
  const { stops = 1, extraStopFee = 0, multiplier = 1, formula = SEED_FORMULA, surcharge = 0 } = opts;
  const base = leg.base;
  const distance = Math.max(0, km - leg.included_km) * leg.per_km;
  const perMinute = leg.per_minute ?? 0;
  const time = perMinute > 0 && opts.speedKmh ? driveMinutes(km, opts.speedKmh) * perMinute : 0;
  const extraStops = Math.max(0, stops - 1) * extraStopFee;
  const raw = base + distance + time + extraStops + surcharge;
  const scaled = clean(raw * multiplier);
  const clamped = Math.max(formula.min_fare, formula.max_fare > 0 ? Math.min(scaled, formula.max_fare) : scaled);
  const fare = roundTo(clamped, formula.rounding_step, formula.rounding_mode);
  return {
    fare,
    steps: [
      { step: "base", amount: clean(base) },
      { step: "distance", amount: clean(distance) },
      { step: "time", amount: clean(time) },
      { step: "extra_stops", amount: clean(extraStops) },
      { step: "dropoff_surcharge", amount: clean(surcharge) },
      { step: "multiplier", amount: clean(scaled - raw) },
      { step: "clamp", amount: clean(clamped - scaled) },
      { step: "rounding", amount: clean(fare - clamped) },
    ],
  };
}

export const legFare = (leg: FareLeg, km: number, opts: FareOpts = {}) => fareBreakdown(leg, km, opts).fare;

/**
 * The drop-off surcharge that applies to a trip: the configured amount, or 0
 * when it only applies on a tier change and the two places share a tier.
 */
export function surchargeFor(
  rule: PricingValue<"dropoff_surcharge">,
  pickupTier: string | null,
  dropoffTier: string | null
): number {
  if (rule.amount <= 0) return 0;
  if (rule.only_when_tier_changes && pickupTier === dropoffTier) return 0;
  return rule.amount;
}
