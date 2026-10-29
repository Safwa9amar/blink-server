// Pure arithmetic behind POST /pricing/admin/simulate: given the effective
// prices, split one transaction into who gets what. Uses the flows' own helpers
// (legFare / tripPayout / splitFee) so rounding matches. Lines sum to payer_total
// for store/courier/ride and to the fee for deposit/withdrawal.
import { round2, splitFee } from "../agent-split";
import { tripPayout } from "../cash-jobs";
import type { PricingValue } from "./catalog";
import { fareBreakdown, SEED_FORMULA, type FareStep } from "./fare";
import { legsFromValue, VEHICLE_CLASS_SEEDS, type ClassLeg, type VehicleClass } from "./vehicle-classes";

export type Scenario = "store" | "courier" | "ride" | "deposit" | "withdrawal";
export type Party = "merchant" | "rider" | "agent" | "blink" | "tax";
export type Label =
  | "merchant_keeps" | "rider_keeps" | "agent_keeps" | "service_fee" | "merchant_commission"
  | "rider_commission" | "platform_share" | "stamp_duty" | "agent_tax";
export type SimLine = { party: Party; label: Label; amount: number };

export type SimInputs = {
  subtotal?: number;
  delivery_fee?: number;
  km?: number;
  stops?: number;
  /** Any vehicle class code (default motorcycle). */
  vehicle?: string;
  amount?: number;
  /** Courier / ride: drop-off surcharge already resolved for the trip (DA). */
  surcharge?: number;
  /** Courier / ride: false = the pickup is outside the service area. */
  in_service_area?: boolean;
  /** Ride: straight-line km, for the `min_ride_km` check. */
  straight_km?: number;
};

/** The effective values a scenario needs (only the ones it uses are read). */
export type SimPrices = {
  /** Per-class legs already resolved for the context (getClassLegs); else read from the courier_fare / ride_fare value. */
  legs?: ClassLeg[];
  /** Classes used to read legs from the value when `legs` is absent (default: the seed classes). */
  vehicle_classes?: VehicleClass[];
  service_fee?: PricingValue<"service_fee">;
  courier_fare?: PricingValue<"courier_fare">;
  ride_fare?: PricingValue<"ride_fare">;
  fare_multiplier?: PricingValue<"fare_multiplier">;
  fare_formula?: PricingValue<"fare_formula">;
  service_area?: PricingValue<"service_area">;
  rider_commission_rate?: PricingValue<"rider_commission_rate">;
  merchant_commission_rate?: PricingValue<"merchant_commission_rate">;
  stamp_duty_rate?: PricingValue<"stamp_duty_rate">;
  blink_cash_fee_rate?: PricingValue<"blink_cash_fee_rate">;
  agent_platform_share?: PricingValue<"agent_platform_share">;
  agent_tax_rate?: PricingValue<"agent_tax_rate">;
  store_delivery?: PricingValue<"store_delivery">;
};

export type SimUnavailable = "too_far" | "too_close" | "out_of_service_area";
export type SimResult = {
  payer_total: number;
  lines: SimLine[];
  unavailable: SimUnavailable | null;
  /** Courier / ride: the fare's steps (base … rounding); they sum to payer_total. */
  breakdown?: { step: FareStep; amount: number }[];
};

export const SIM_DEFAULTS = { subtotal: 2_000, delivery_fee: 200, km: 5, stops: 1, vehicle: "motorcycle", amount: 1_000 } as const;

export function simulate(scenario: Scenario, inputs: SimInputs, p: SimPrices): SimResult {
  const km = inputs.km ?? SIM_DEFAULTS.km;
  const amount = inputs.amount ?? SIM_DEFAULTS.amount;

  if (scenario === "store") {
    const subtotal = inputs.subtotal ?? SIM_DEFAULTS.subtotal;
    const delivery = inputs.delivery_fee ?? SIM_DEFAULTS.delivery_fee;
    const service = p.service_fee!.amount;
    const commission = round2(subtotal * p.merchant_commission_rate!.rate);
    const stamp = round2(subtotal * p.stamp_duty_rate!.rate);
    const riderKeeps = tripPayout(delivery, p.rider_commission_rate!.rate).net_payout;
    const lines: SimLine[] = [
      { party: "merchant", label: "merchant_keeps", amount: round2(subtotal - commission - stamp) },
      { party: "rider", label: "rider_keeps", amount: riderKeeps },
      { party: "blink", label: "service_fee", amount: service },
      { party: "blink", label: "merchant_commission", amount: commission },
      { party: "blink", label: "rider_commission", amount: round2(delivery - riderKeeps) },
      { party: "tax", label: "stamp_duty", amount: stamp },
    ];
    return { payer_total: round2(subtotal + delivery + service), lines, unavailable: null };
  }

  if (scenario === "courier" || scenario === "ride") {
    const vehicle = inputs.vehicle ?? SIM_DEFAULTS.vehicle;
    const multiplier = p.fare_multiplier!.multiplier;
    const key = scenario === "ride" ? "ride_fare" : "courier_fare";
    const legs = p.legs ?? legsFromValue(key, p[key], p.vehicle_classes ?? VEHICLE_CLASS_SEEDS, { enabledOnly: false });
    const entry = legs.find((l) => l.cls.code === vehicle);
    const formula = p.fare_formula ?? SEED_FORMULA;
    const none = (unavailable: SimUnavailable): SimResult => ({ payer_total: 0, lines: [], unavailable, breakdown: [] });
    // A class with no price here can't take the trip.
    if (!entry) return none("too_far");
    const rates = entry.leg;
    const base = entry.cls.base_vehicle;
    if (inputs.in_service_area === false) return none("out_of_service_area");
    if (scenario === "ride" && inputs.straight_km != null && inputs.straight_km < formula.min_ride_km) return none("too_close");
    if (km > rates.max_km) return none("too_far");
    const { fare, steps } = fareBreakdown(rates, km, {
      stops: scenario === "courier" ? inputs.stops ?? SIM_DEFAULTS.stops : 1,
      extraStopFee: scenario === "courier" ? p.courier_fare!.extra_stop_fee : 0,
      multiplier,
      formula,
      surcharge: inputs.surcharge,
      speedKmh: formula.speed_kmh[base],
    });
    const riderKeeps = tripPayout(fare, p.rider_commission_rate!.rate).net_payout;
    return {
      payer_total: fare,
      lines: [
        { party: "rider", label: "rider_keeps", amount: riderKeeps },
        { party: "blink", label: "rider_commission", amount: round2(fare - riderKeeps) },
      ],
      unavailable: null,
      breakdown: steps,
    };
  }

  // deposit / withdrawal
  const fee = Math.round(amount * p.blink_cash_fee_rate!.rate);
  const split = splitFee(fee, { platform: p.agent_platform_share!.rate, tax: p.agent_tax_rate!.rate });
  return {
    payer_total: scenario === "deposit" ? amount + fee : amount - fee,
    lines: [
      { party: "blink", label: "platform_share", amount: split.platform },
      { party: "tax", label: "agent_tax", amount: split.tax },
      { party: "agent", label: "agent_keeps", amount: split.net },
    ],
    unavailable: null,
  };
}
