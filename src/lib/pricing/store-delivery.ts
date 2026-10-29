// Marketplace delivery fee by zone (Addendum 1, per class in Addendum 2). The
// `store_delivery` key says how a store order's delivery fee is decided:
//  - "merchant": the store's own `stores.delivery_fee`;
//  - "distance": the fare formula over the store → customer trip, priced per
//    store vehicle class (the cheapest class whose max_km covers the trip).
// min_fee / max_fee clamp both modes. The customer never sees a vehicle: the
// chosen class only decides which riders the order is offered to
// (`orders.vehicle_type`). Quote and create both go through quoteStoreDelivery
// (store-quote.ts); this file is the pure part.
import { fareBreakdown, SEED_FORMULA, type FareFormula, type FareStep } from "./fare";
import type { PricingValue } from "./catalog";
import type { ClassLeg } from "./vehicle-classes";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type StoreDeliveryRule = Pick<PricingValue<"store_delivery">, "mode" | "min_fee" | "max_fee">;

export type StoreDeliveryQuote = {
  /** What the customer is charged (before any free-pack waiver); also the rider's fare. */
  fee: number;
  /** The mode actually used: distance falls back to merchant without a customer point / any priced class. */
  mode: "merchant" | "distance";
  /** The class that prices (and will serve) the order — distance mode only, else null. */
  vehicle: string | null;
  km: number | null;
  /** The formula's steps (distance mode), before the min/max clamp. */
  breakdown?: { step: FareStep; amount: number }[];
  /** Why distance mode priced as merchant. */
  fallback?: "no_customer_point" | "no_class";
};

/** The min/max clamp, shared by both modes (max_fee 0 = off). */
export const clampDeliveryFee = (fee: number, rule: Pick<StoreDeliveryRule, "min_fee" | "max_fee">) =>
  round2(Math.max(rule.min_fee, rule.max_fee > 0 ? Math.min(fee, rule.max_fee) : fee));

/** Is the quoted fee the customer saw no longer the fee? (tolerant of float noise) */
export const deliveryFeeChanged = (expected: number | null | undefined, actual: number) =>
  expected != null && Math.abs(expected - actual) >= 0.005;

/**
 * Pure pricing of one store order's delivery. `km` = the store → customer road
 * km (null when the customer point is unknown); `legs` = the enabled store
 * classes that have a price here.
 */
export function priceStoreDelivery(input: {
  rule: StoreDeliveryRule;
  merchantFee: number;
  km: number | null;
  legs: ClassLeg[];
  multiplier?: number;
  formula?: FareFormula;
  surcharge?: number;
}): StoreDeliveryQuote {
  const { rule, merchantFee, km, legs } = input;
  const merchant = (fallback?: StoreDeliveryQuote["fallback"]): StoreDeliveryQuote => ({
    fee: clampDeliveryFee(merchantFee, rule),
    mode: "merchant",
    vehicle: null,
    km: null,
    ...(fallback ? { fallback } : {}),
  });
  if (rule.mode !== "distance") return merchant();
  if (km == null) return merchant("no_customer_point");
  if (!legs.length) return merchant("no_class");

  const formula = input.formula ?? SEED_FORMULA;
  const priced = legs.map((l) => ({
    l,
    b: fareBreakdown(l.leg, km, {
      multiplier: input.multiplier ?? 1,
      formula,
      surcharge: input.surcharge ?? 0,
      speedKmh: formula.speed_kmh[l.cls.base_vehicle],
    }),
  }));
  // Legs arrive in sort_order, so a strict `<` keeps the earlier class on ties.
  const covering = priced.filter((p) => km <= p.l.leg.max_km);
  let pick = covering[0];
  for (const p of covering) if (p.b.fare < pick.b.fare) pick = p;
  // No class covers the trip: the widest one still takes it (priced as usual).
  if (!pick) {
    pick = priced[0];
    for (const p of priced) if (p.l.leg.max_km > pick.l.leg.max_km) pick = p;
  }
  return {
    fee: clampDeliveryFee(pick.b.fare, rule),
    mode: "distance",
    vehicle: pick.l.cls.code,
    km,
    breakdown: pick.b.steps,
  };
}

