// Worked examples for the staff cockpit: one concrete "what does this fee do"
// number per pricing key, computed with the same functions the flows use so the
// rounding matches (fares ceil to 10 DA, cash fee Math.round, dues round2, …).
import { tripPayout } from "../cash-jobs";
import { round2, splitFee } from "../agent-split";
import { PRICING_SCHEMAS, PRICING_SEEDS, type PricingKey, type PricingValue } from "./catalog";
import { legFare } from "./fare";

export type FeeExample =
  | { kind: "per_checkout"; output: number }
  | { kind: "trip_km"; vehicle: "motorcycle" | "bicycle"; km: number; output: number }
  | { kind: "multiplier"; km: number; input: number; output: number }
  | { kind: "rate_on_amount"; input: number; output: number }
  | { kind: "agent_split"; input: number; output: number }
  | { kind: "amount"; output: number };

/** Other effective values an example may need (missing ones fall back to the seed). */
export type ExampleValues = { [K in PricingKey]?: PricingValue<K> };

export const EXAMPLE_KM = 5;
const RIDER_FARE = 400;
const MERCHANT_SALE = 10_000;
const CASH_AMOUNT = 1_000;
const AGENT_FEE = 100;
const AGENT_TAX_BASE = 80;

export function feeExample(key: PricingKey, value: unknown, values: ExampleValues = {}): FeeExample | null {
  const parsed = PRICING_SCHEMAS[key].safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data as any;
  const other = <K extends PricingKey>(k: K): PricingValue<K> => (values[k] ?? PRICING_SEEDS[k]) as PricingValue<K>;

  switch (key) {
    case "service_fee":
      return { kind: "per_checkout", output: v.amount };
    case "courier_fare":
      return {
        kind: "trip_km",
        vehicle: "motorcycle",
        km: EXAMPLE_KM,
        output: legFare(v.motorcycle, EXAMPLE_KM, {
          extraStopFee: v.extra_stop_fee,
          multiplier: other("fare_multiplier").multiplier,
          formula: other("fare_formula"),
          speedKmh: other("fare_formula").speed_kmh.motorcycle,
        }),
      };
    case "ride_fare":
      return {
        kind: "trip_km",
        vehicle: "motorcycle",
        km: EXAMPLE_KM,
        output: legFare(v.motorcycle, EXAMPLE_KM, {
          multiplier: other("fare_multiplier").multiplier,
          formula: other("fare_formula"),
          speedKmh: other("fare_formula").speed_kmh.motorcycle,
        }),
      };
    case "fare_multiplier": {
      const leg = other("ride_fare").motorcycle;
      return {
        kind: "multiplier",
        km: EXAMPLE_KM,
        input: legFare(leg, EXAMPLE_KM),
        output: legFare(leg, EXAMPLE_KM, { multiplier: v.multiplier }),
      };
    }
    case "rider_commission_rate":
      return { kind: "rate_on_amount", input: RIDER_FARE, output: RIDER_FARE - tripPayout(RIDER_FARE, v.rate).net_payout };
    case "merchant_commission_rate":
    case "stamp_duty_rate":
      return { kind: "rate_on_amount", input: MERCHANT_SALE, output: round2(MERCHANT_SALE * v.rate) };
    case "blink_cash_fee_rate":
      return { kind: "rate_on_amount", input: CASH_AMOUNT, output: Math.round(CASH_AMOUNT * v.rate) };
    case "dues_payment_fee_rate":
      return { kind: "rate_on_amount", input: MERCHANT_SALE, output: round2(MERCHANT_SALE * v.rate) };
    case "agent_tax_rate":
      return { kind: "rate_on_amount", input: AGENT_TAX_BASE, output: round2(AGENT_TAX_BASE * v.rate) };
    case "agent_platform_share":
      return {
        kind: "agent_split",
        input: AGENT_FEE,
        output: splitFee(AGENT_FEE, { platform: v.rate, tax: other("agent_tax_rate").rate }).net,
      };
    case "rider_cancel_penalty":
    case "dropoff_surcharge":
      return { kind: "amount", output: v.amount };
    case "fare_formula": {
      // A 5 km motorcycle courier under this formula (the Formula tab shows the full breakdown).
      const c = other("courier_fare");
      return {
        kind: "trip_km",
        vehicle: "motorcycle",
        km: EXAMPLE_KM,
        output: legFare(c.motorcycle, EXAMPLE_KM, {
          extraStopFee: c.extra_stop_fee,
          multiplier: other("fare_multiplier").multiplier,
          formula: v,
          speedKmh: v.speed_kmh.motorcycle,
        }),
      };
    }
    case "service_area":
    case "zone_defaults":
      return null;
  }
}
