// The DB-backed part of store delivery pricing (rules: store-delivery.ts):
// resolves store_delivery / fare_formula / fare_multiplier at the store place and
// the drop-off surcharge at the customer place. POST /orders/quote and
// POST /orders both call quoteStoreDelivery, so the fee shown is the fee charged.
import { haversineKm } from "../courier-pricing";
import { surchargeFor } from "./fare";
import { storeContextOf } from "./fees";
import { getClassLegs, getPrice, getPrices, placeContext, pricingPlace, type PricingContext, type PricingPlace } from "./index";
import { priceStoreDelivery, type StoreDeliveryQuote } from "./store-delivery";

type LatLng = { lat: number; lng: number };
const round1 = (n: number) => Math.round(n * 10) / 10;

export type StoreDeliveryResult = StoreDeliveryQuote & {
  /** The configured mode (store payloads' `delivery_fee_mode`). */
  configuredMode: "merchant" | "distance";
  /** `{ key: overrideId }` to merge into `orders.pricing_applied`. */
  applied: Record<string, string | null>;
};

/**
 * The delivery fee of a store order. `ctx` = orderPricingContext (the store
 * place, merchant and service); `customer` = where it's delivered (null → the
 * merchant fee). Distance mode also resolves fare_formula / fare_multiplier at
 * the store place and the drop-off surcharge at the customer place.
 */
export async function quoteStoreDelivery(input: {
  ctx: PricingContext & { place: PricingPlace | null };
  merchantFee: number;
  store: LatLng | null;
  customer: LatLng | null;
}): Promise<StoreDeliveryResult> {
  const { place, ...ctx } = input.ctx;
  const rule = await getPrice("store_delivery", ctx);
  const configuredMode = rule.value.mode;
  const applied: Record<string, string | null> = { store_delivery: rule.overrideId };

  if (configuredMode !== "distance" || !input.customer || !input.store) {
    // Distance mode without a customer (or store) point prices as the merchant fee, flagged as a fallback.
    const q = priceStoreDelivery({ rule: rule.value, merchantFee: input.merchantFee, km: null, legs: [] });
    return { ...q, configuredMode, applied };
  }

  const [p, legs, customerPlace] = await Promise.all([
    getPrices(["fare_multiplier", "fare_formula"] as const, ctx),
    getClassLegs("store_delivery", ctx),
    pricingPlace(input.customer),
  ]);
  const surchargeRule = await getPrice("dropoff_surcharge", { service: ctx.service, ...placeContext(customerPlace) });
  const formula = p.fare_formula.value;
  const km = round1(haversineKm(input.store, input.customer) * formula.road_factor);
  const q = priceStoreDelivery({
    rule: rule.value,
    merchantFee: input.merchantFee,
    km,
    legs,
    multiplier: p.fare_multiplier.value.multiplier,
    formula,
    surcharge: surchargeFor(surchargeRule.value, place?.tier ?? null, customerPlace.tier),
  });
  if (q.mode === "distance") {
    const chosen = legs.find((l) => l.cls.code === q.vehicle);
    applied.store_delivery = chosen?.overrideId ?? rule.overrideId;
    applied.fare_multiplier = p.fare_multiplier.overrideId;
    applied.fare_formula = p.fare_formula.overrideId;
    applied.dropoff_surcharge = surchargeRule.overrideId;
  }
  return { ...q, configuredMode, applied };
}

/** The configured delivery mode of several stores (customer-facing store payloads), one cache read each. */
export async function storeDeliveryModes(
  stores: { id: string; owner_id?: string | null; wilaya?: string | null; latitude?: number | string | null; longitude?: number | string | null }[]
): Promise<Map<string, "merchant" | "distance">> {
  const out = new Map<string, "merchant" | "distance">();
  await Promise.all(
    stores.map(async (s) => {
      const { place: _place, ...ctx } = await storeContextOf(s, "merchant", null);
      out.set(s.id, (await getPrice("store_delivery", ctx)).value.mode);
    })
  );
  return out;
}
