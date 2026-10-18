// The configured fare rates + manual multiplier for a courier / ride at a
// pickup point, plus the `pricing_applied` snapshot to store on the order.
// Quote and create both go through here so the fare shown is the fare charged.
import { wilayaAt } from "../geo/wilaya";
import { getPrices, type PricingValue } from "./index";

export type FareConfig<K extends "courier_fare" | "ride_fare"> = {
  rates: PricingValue<K>;
  multiplier: number;
  /** `{ [key]: overrideId | null }` — store as `orders.pricing_applied`. */
  applied: Record<string, string | null>;
};

async function fareConfig<K extends "courier_fare" | "ride_fare">(
  key: K,
  service: "courier" | "ride",
  pickup: { lat: number; lng: number }
): Promise<FareConfig<K>> {
  const wilaya = wilayaAt(pickup.lat, pickup.lng);
  const p = await getPrices([key, "fare_multiplier"] as const, { service, wilaya });
  return {
    rates: p[key].value as PricingValue<K>,
    multiplier: p.fare_multiplier.value.multiplier,
    applied: { [key]: p[key].overrideId, fare_multiplier: p.fare_multiplier.overrideId },
  };
}

export const courierFareConfig = (pickup: { lat: number; lng: number }) => fareConfig("courier_fare", "courier", pickup);
export const rideFareConfig = (pickup: { lat: number; lng: number }) => fareConfig("ride_fare", "ride", pickup);
