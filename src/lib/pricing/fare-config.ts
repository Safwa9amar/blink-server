// The configured fare rates, formula, multiplier, drop-off surcharge and
// service-area switch for a courier / ride, resolved at the PICKUP place
// (surcharge at the DROP-OFF place), plus the `pricing_applied` snapshot to
// store on the order. Quote and create both go through here so the fare shown
// is the fare charged.
import { getClassLegs, getPrice, getPrices, placeContext, pricingPlace, type ClassLeg, type PricingPlace, type PricingValue } from "./index";
import { surchargeFor, type FareFormula } from "./fare";

type LatLng = { lat: number; lng: number };

export type FareConfig<K extends "courier_fare" | "ride_fare"> = {
  /** The best-matching value: its non-leg fields (extra_stop_fee); legs are per class in `legs`. */
  rates: PricingValue<K>;
  /** Enabled classes serving the service with a price here, in display order. */
  legs: ClassLeg[];
  multiplier: number;
  formula: FareFormula;
  /** Drop-off surcharge in DA that applies to this trip (0 when none / same tier). */
  surcharge: number;
  /** false = `service_area` is off for the pickup: quotes are unavailable, creates 400 out_of_service_area. */
  enabled: boolean;
  /** Where the trip starts / ends for pricing. */
  place: PricingPlace;
  dropoffPlace: PricingPlace;
  /** `{ [key]: overrideId | null }` — store as `orders.pricing_applied`. */
  applied: Record<string, string | null>;
  /** `applied` with the fare key pointing at the override that supplied class `code`'s leg. */
  appliedFor: (code: string) => Record<string, string | null>;
};

async function fareConfig<K extends "courier_fare" | "ride_fare">(
  key: K,
  service: "courier" | "ride",
  pickup: LatLng,
  dropoff: LatLng = pickup
): Promise<FareConfig<K>> {
  const [place, dropoffPlace] = await Promise.all([pricingPlace(pickup), pricingPlace(dropoff)]);
  const ctx = { service, ...placeContext(place) };
  const [p, legs, rule] = await Promise.all([
    getPrices([key, "fare_multiplier", "fare_formula", "service_area"] as const, ctx),
    getClassLegs(key, ctx),
    // The surcharge is a property of where the rider drops off.
    getPrice("dropoff_surcharge", { service, ...placeContext(dropoffPlace) }),
  ]);
  const applied: Record<string, string | null> = {
    [key]: p[key].overrideId,
    fare_multiplier: p.fare_multiplier.overrideId,
    fare_formula: p.fare_formula.overrideId,
    service_area: p.service_area.overrideId,
    dropoff_surcharge: rule.overrideId,
  };
  if (place.unzoned) applied.zone_defaults = place.unzonedOverrideId;
  return {
    rates: p[key].value as PricingValue<K>,
    legs,
    appliedFor: (code) => ({ ...applied, [key]: legs.find((l) => l.cls.code === code)?.overrideId ?? applied[key] }),
    multiplier: p.fare_multiplier.value.multiplier,
    formula: p.fare_formula.value,
    surcharge: surchargeFor(rule.value, place.tier, dropoffPlace.tier),
    enabled: p.service_area.value.enabled,
    place,
    dropoffPlace,
    applied,
  };
}

/** `dropoff` = the LAST drop-off for a multi-stop courier route. */
export const courierFareConfig = (pickup: LatLng, dropoff?: LatLng) => fareConfig("courier_fare", "courier", pickup, dropoff);
export const rideFareConfig = (pickup: LatLng, dropoff?: LatLng) => fareConfig("ride_fare", "ride", pickup, dropoff);

/** The columns that record the pricing place on an order. */
export const placeColumns = (place: PricingPlace) => ({ pricing_zone_id: place.zoneId, pricing_tier: place.tier });
