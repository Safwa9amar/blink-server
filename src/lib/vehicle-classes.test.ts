import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickOfferRecipients } from "./offer-recipients";
import { priceStoreOrder, type CustomerPack } from "./pack-pricing";
import { fieldsFor, legClassError, PRICING_SCHEMAS, PRICING_SEEDS } from "./pricing/catalog";
import type { OverrideLike } from "./pricing/resolve";
import { clampDeliveryFee, deliveryFeeChanged, priceStoreDelivery } from "./pricing/store-delivery";
import {
  canTake,
  classesFor,
  resolveClassLeg,
  resolveClassLegs,
  VEHICLE_CLASS_SEEDS,
  type VehicleClass,
} from "./pricing/vehicle-classes";
import { quoteRide } from "./ride-pricing";
import { quoteRoute } from "./courier-pricing";
import { riderCanTake } from "./courier";
import { rideRiderProblem } from "./ride";

const leg = (base: number, per_km = 40, max_km = 40) => ({ base, included_km: 3, per_km, max_km, per_minute: 0 });
const ov = (id: string, key: string, value: unknown, over: Partial<OverrideLike> = {}): OverrideLike => ({
  id, key, service: null, wilaya_code: null, merchant_id: null, agent_id: null, zone_id: null, tier: null,
  value, starts_at: null, ends_at: null, created_at: "2026-10-01T00:00:00Z", ...over,
});
const defaults: Record<string, unknown> = { ...PRICING_SEEDS };
const classes: VehicleClass[] = VEHICLE_CLASS_SEEDS.map((c) => ({ ...c }));
const comfortOn = classes.map((c) => (c.code === "motorcycle_comfort" ? { ...c, enabled: true } : c));

describe("stored fare values keep parsing (today's prices stay)", () => {
  it("legacy courier_fare / ride_fare shapes parse unchanged, legs default per_minute", () => {
    const courier = {
      bicycle: { base: 140, included_km: 2, per_km: 35, max_km: 10 },
      motorcycle: { base: 250, included_km: 3, per_km: 40, max_km: 40 },
      extra_stop_fee: 60,
    };
    const c = PRICING_SCHEMAS.courier_fare.safeParse(courier);
    assert.ok(c.success);
    if (c.success) {
      assert.equal(c.data.extra_stop_fee, 60);
      assert.equal(c.data.motorcycle.per_minute, 0);
    }
    const r = PRICING_SCHEMAS.ride_fare.safeParse({ motorcycle: { base: 200, included_km: 3, per_km: 40, max_km: 40 } });
    assert.ok(r.success);
    assert.ok(PRICING_SCHEMAS.store_delivery.safeParse(PRICING_SEEDS.store_delivery).success);
  });

  it("rejects a malformed leg or a non-class key", () => {
    assert.equal(PRICING_SCHEMAS.ride_fare.safeParse({ motorcycle: { base: -1, included_km: 3, per_km: 40, max_km: 40 } }).success, false);
    assert.equal(PRICING_SCHEMAS.ride_fare.safeParse({ "Bad Key": leg(1) }).success, false);
  });

  it("store_delivery seed is merchant mode with no clamp; comfort is seeded disabled", () => {
    assert.equal(PRICING_SEEDS.store_delivery.mode, "merchant");
    assert.equal(PRICING_SEEDS.store_delivery.min_fee, 0);
    assert.equal(PRICING_SEEDS.store_delivery.max_fee, 0);
    assert.equal(VEHICLE_CLASS_SEEDS.find((c) => c.code === "motorcycle_comfort")!.enabled, false);
  });

  it("quotes are unchanged: one ride option (motorcycle), courier bicycle + motorcycle", () => {
    const a = { lat: 36.7731, lng: 3.0596 };
    const b = { lat: 36.7445, lng: 3.0283 };
    const legs = resolveClassLegs(defaults, [], "ride_fare", classes, {});
    assert.deepEqual(legs.map((l) => l.cls.code), ["motorcycle"]);
    assert.deepEqual(quoteRide(a, b, PRICING_SEEDS.ride_fare, 1, { classes: legs }).options.map((o) => o.vehicle_type), ["motorcycle"]);
    const cl = resolveClassLegs(defaults, [], "courier_fare", classes, {});
    assert.deepEqual(quoteRoute(a, [b], PRICING_SEEDS.courier_fare, 1, { classes: cl }).options.map((o) => o.vehicle_type), ["bicycle", "motorcycle"]);
  });

  it("enabling comfort adds a ride option with its own fare", () => {
    const legs = resolveClassLegs(defaults, [], "ride_fare", comfortOn, {});
    const q = quoteRide({ lat: 36.7731, lng: 3.0596 }, { lat: 36.7213, lng: 3.1834 }, PRICING_SEEDS.ride_fare, 1, { classes: legs });
    assert.deepEqual(q.options.map((o) => o.vehicle_type), ["motorcycle", "motorcycle_comfort"]);
    assert.ok(q.options[1].fare > q.options[0].fare);
    assert.equal(q.options[1].base_vehicle, "motorcycle");
  });
});

describe("per-class leg resolution", () => {
  const withMoto = ov("o-moto", "ride_fare", { motorcycle: leg(220) }, { wilaya_code: "16" });
  const ctx = { service: "ride", wilaya: "16" };

  it("an override without the class falls back to the default, then the seed", () => {
    // The wilaya override only prices motorcycle: comfort comes from the default / seed.
    const moto = resolveClassLeg(defaults, [withMoto], "ride_fare", "motorcycle", ctx)!;
    assert.equal(moto.leg.base, 220);
    assert.equal(moto.overrideId, "o-moto");
    // A stored (pre-classes) default holds motorcycle only: comfort falls to the code seed.
    const stored = { ...defaults, ride_fare: { motorcycle: leg(200) } };
    const comfort = resolveClassLeg(stored, [withMoto], "ride_fare", "motorcycle_comfort", ctx)!;
    assert.equal(comfort.leg.base, 300);
    assert.equal(comfort.overrideId, null);
    assert.equal(comfort.source, "seed");
    // A stored default with the class beats the seed.
    const d = { ...defaults, ride_fare: { motorcycle: leg(200), motorcycle_comfort: leg(333) } };
    assert.equal(resolveClassLeg(d, [], "ride_fare", "motorcycle_comfort", ctx)!.source, "default");
  });

  it("the best-scoring override that HAS the class wins, not the best override overall", () => {
    const zoneOnlyMoto = ov("z", "ride_fare", { motorcycle: leg(180) }, { tier: "urban", wilaya_code: "16" });
    const wilayaComfort = ov("w", "ride_fare", { motorcycle_comfort: leg(400) }, { wilaya_code: "16" });
    const c = { service: "ride", wilaya: "16", tier: "urban" };
    assert.equal(resolveClassLeg(defaults, [zoneOnlyMoto, wilayaComfort], "ride_fare", "motorcycle_comfort", c)!.overrideId, "w");
    assert.equal(resolveClassLeg(defaults, [zoneOnlyMoto, wilayaComfort], "ride_fare", "motorcycle", c)!.overrideId, "z");
  });

  it("a class with no leg anywhere has no price; archived / disabled / non-serving classes are not quoted", () => {
    assert.equal(resolveClassLeg(defaults, [], "ride_fare", "bicycle", ctx), null);
    const archived = classes.map((c) => (c.code === "motorcycle" ? { ...c, archived: true } : c));
    assert.deepEqual(classesFor(archived, "ride").map((c) => c.code), []);
    assert.deepEqual(classesFor(classes, "ride").map((c) => c.code), ["motorcycle"]);
    assert.deepEqual(classesFor(classes, "ride", false).map((c) => c.code), ["motorcycle", "motorcycle_comfort"]);
    assert.deepEqual(classesFor(classes, "store").map((c) => c.code), ["bicycle", "motorcycle"]);
    // an archived class's leg stored in an override is simply never asked for
    const stale = ov("s", "ride_fare", { motorcycle: leg(220), gone_class: leg(1) });
    assert.deepEqual(resolveClassLegs(defaults, [stale], "ride_fare", classes, {}).map((l) => l.cls.code), ["motorcycle"]);
  });

  it("a leg for a class that doesn't serve the key's service is rejected at save", () => {
    assert.equal(legClassError("ride_fare", { motorcycle: leg(1), motorcycle_comfort: leg(1) }, classes), null);
    assert.match(legClassError("ride_fare", { bicycle: leg(1) }, classes) ?? "", /doesn't serve ride/);
    assert.match(legClassError("courier_fare", { extra_stop_fee: 60, motorcycle_comfort: leg(1) }, classes) ?? "", /doesn't serve courier/);
    assert.match(legClassError("store_delivery", { mode: "merchant", ghost: leg(1) }, classes) ?? "", /isn't a live vehicle class/);
    assert.equal(legClassError("service_fee", { amount: 1 }, classes), null);
  });
});

describe("canTake matrix", () => {
  const rider = (vehicleType: string | null, vehicleClass: string | null = null) => ({ vehicleType, vehicleClass });

  it("an exclusive class needs a rider of that class", () => {
    assert.equal(canTake("motorcycle_comfort", rider("motorcycle", "motorcycle_comfort"), classes), true);
    assert.equal(canTake("motorcycle_comfort", rider("motorcycle"), classes), false);
    assert.equal(canTake("motorcycle_comfort", rider("motorcycle", "motorcycle"), classes), false);
    assert.equal(canTake("motorcycle_comfort", rider("bicycle"), classes), false);
  });

  it("a comfort rider also takes ordinary motorcycle jobs; a bicycle job takes anyone", () => {
    assert.equal(canTake("motorcycle", rider("motorcycle", "motorcycle_comfort"), classes), true);
    assert.equal(canTake("motorcycle", rider("bicycle"), classes), false);
    assert.equal(canTake("bicycle", rider("motorcycle"), classes), true);
    assert.equal(canTake("bicycle", rider("bicycle"), classes), true);
  });

  it("legacy values behave exactly as before", () => {
    for (const [job, r, want] of [
      [null, "bicycle", true], [null, null, true], ["bicycle", "bicycle", true], ["bicycle", "motorcycle", true],
      ["motorcycle", "motorcycle", true], ["motorcycle", "bicycle", false], ["motorcycle", null, true], ["bicycle", null, true],
    ] as const) {
      assert.equal(riderCanTake(job, r), want, `${job} / ${r}`);
    }
    // rides stay strict: motorcycle only, an unknown vehicle is refused
    assert.equal(rideRiderProblem({ vehicle_type: "motorcycle", ride: {} }, { vehicleType: null, gender: null }), "vehicle");
    assert.equal(rideRiderProblem({ ride: {} }, { vehicleType: "motorcycle", gender: null }), null);
  });

  it("a ride for comfort only reaches comfort riders", () => {
    const o = { type: "ride", vehicle_type: "motorcycle_comfort", ride: {} };
    assert.equal(rideRiderProblem(o, { vehicleType: "motorcycle", vehicleClass: "motorcycle_comfort", gender: null }, classes), null);
    assert.equal(rideRiderProblem(o, { vehicleType: "motorcycle", vehicleClass: null, gender: null }, classes), "vehicle");
    const near = [
      { id: "plain", lat: 0, lng: 0, vehicleType: "motorcycle", vehicleClass: null },
      { id: "comfy", lat: 0, lng: 0, vehicleType: "motorcycle", vehicleClass: "motorcycle_comfort" },
    ];
    const ids = pickOfferRecipients({ members: [{ id: "o", customer_id: "c", ...o }], near, skip: new Set(), busy: new Set(), classes });
    assert.deepEqual(ids, ["comfy"]);
  });

  it("a distance-mode store order carries a class; merchant mode (null) goes to anyone", () => {
    const near = [
      { id: "bike", lat: 0, lng: 0, vehicleType: "bicycle" },
      { id: "moto", lat: 0, lng: 0, vehicleType: "motorcycle" },
    ];
    const pick = (vehicle_type: string | null) =>
      pickOfferRecipients({ members: [{ id: "o", type: "merchant", customer_id: "c", vehicle_type }], near, skip: new Set(), busy: new Set() });
    assert.deepEqual(pick(null), ["bike", "moto"]);
    assert.deepEqual(pick("bicycle"), ["bike", "moto"]);
    assert.deepEqual(pick("motorcycle"), ["moto"]);
  });
});

describe("store delivery", () => {
  const storeLegs = resolveClassLegs(defaults, [], "store_delivery", classes, { service: "merchant" });
  const base = { rule: { mode: "distance" as const, min_fee: 0, max_fee: 0 }, merchantFee: 200, legs: storeLegs };

  it("merchant mode charges the store's fee, clamped; seed = no clamp", () => {
    const m = { mode: "merchant" as const, min_fee: 0, max_fee: 0 };
    assert.deepEqual(priceStoreDelivery({ ...base, rule: m, km: 5 }), { fee: 200, mode: "merchant", vehicle: null, km: null });
    assert.equal(priceStoreDelivery({ ...base, rule: { ...m, min_fee: 300 }, km: 5 }).fee, 300);
    assert.equal(priceStoreDelivery({ ...base, rule: { ...m, max_fee: 150 }, km: 5 }).fee, 150);
    assert.equal(clampDeliveryFee(99, { min_fee: 120, max_fee: 0 }), 120);
  });

  it("distance mode picks the cheapest class whose max_km covers the trip", () => {
    // bicycle: 140 + (5-2)*35 = 245 -> 250; motorcycle: 250 + 2*40 = 330
    const q = priceStoreDelivery({ ...base, km: 5 });
    assert.equal(q.mode, "distance");
    assert.equal(q.vehicle, "bicycle");
    assert.equal(q.fee, 250);
    assert.ok(q.breakdown && q.breakdown.length > 0);
    // 15 km: bicycle max is 10 -> only the motorcycle covers it
    const far = priceStoreDelivery({ ...base, km: 15 });
    assert.equal(far.vehicle, "motorcycle");
    assert.equal(far.fee, 250 + 12 * 40);
  });

  it("ties go to the display order; none covering falls back to the widest class", () => {
    const same = storeLegs.map((l) => ({ ...l, leg: leg(200, 40, 40) }));
    assert.equal(priceStoreDelivery({ ...base, legs: same, km: 5 }).vehicle, "bicycle");
    // 60 km: nobody covers it (max 10 / 40): motorcycle has the largest max_km
    const none = priceStoreDelivery({ ...base, km: 60 });
    assert.equal(none.vehicle, "motorcycle");
    assert.equal(none.mode, "distance");
  });

  it("the clamp applies to the distance fee too", () => {
    assert.equal(priceStoreDelivery({ ...base, rule: { mode: "distance", min_fee: 0, max_fee: 200 }, km: 5 }).fee, 200);
    assert.equal(priceStoreDelivery({ ...base, rule: { mode: "distance", min_fee: 400, max_fee: 0 }, km: 5 }).fee, 400);
  });

  it("no customer point (or no priced class) falls back to the merchant fee", () => {
    const q = priceStoreDelivery({ ...base, km: null });
    assert.equal(q.mode, "merchant");
    assert.equal(q.fee, 200);
    assert.equal(q.vehicle, null);
    assert.equal(q.fallback, "no_customer_point");
    assert.equal(priceStoreDelivery({ ...base, legs: [], km: 5 }).fallback, "no_class");
  });

  it("surcharge and multiplier feed the formula", () => {
    const plain = priceStoreDelivery({ ...base, km: 5 }).fee;
    assert.ok(priceStoreDelivery({ ...base, km: 5, surcharge: 100 }).fee > plain);
    assert.ok(priceStoreDelivery({ ...base, km: 5, multiplier: 1.5 }).fee > plain);
  });

  it("a free-delivery pack waives the computed fee; the rider's fare stays the fee", () => {
    const pack = {
      id: "p1", store_id: "s", name: "Pack", description: null, image: null, discount_percent: 0, free_delivery: true,
      item_count: 1, original_price: 100, price: 100, savings: 0, items: [],
    } as CustomerPack;
    const fee = priceStoreDelivery({ ...base, km: 5 }).fee;
    const priced = priceStoreOrder([{ name: "Pack", quantity: 1, unit_price: 100, pack_id: "p1" }], [pack], fee);
    assert.ok(priced.ok);
    if (priced.ok) {
      assert.equal(priced.delivery_fee, fee);
      assert.equal(priced.delivery_waived, fee);
    }
  });

  it("expected_delivery_fee: absent never conflicts, a different fee does (409 price_changed)", () => {
    assert.equal(deliveryFeeChanged(undefined, 250), false);
    assert.equal(deliveryFeeChanged(250, 250), false);
    assert.equal(deliveryFeeChanged(250.001, 250), false);
    assert.equal(deliveryFeeChanged(250, 260), true);
  });
});

describe("catalog fields per class", () => {
  it("generates leg fields per live class serving the service, each carrying `class`", () => {
    const ride = fieldsFor("ride_fare", comfortOn);
    assert.deepEqual(
      ride.map((f) => f.path),
      ["motorcycle", "motorcycle_comfort"].flatMap((c) => ["base", "included_km", "per_km", "max_km", "per_minute"].map((p) => `${c}.${p}`))
    );
    assert.ok(ride.every((f) => f.class === f.path.split(".")[0]));
    const courier = fieldsFor("courier_fare", comfortOn).map((f) => f.path);
    assert.ok(courier.includes("extra_stop_fee") && courier.includes("bicycle.base") && !courier.some((p) => p.startsWith("motorcycle_comfort")));
    const store = fieldsFor("store_delivery", classes);
    assert.deepEqual(store.slice(0, 3).map((f) => f.path), ["mode", "min_fee", "max_fee"]);
    assert.equal(store.find((f) => f.path === "mode")!.unit, "choice");
    assert.equal(store.find((f) => f.path === "motorcycle.per_km")!.class, "motorcycle");
    assert.deepEqual(fieldsFor("service_fee", classes).map((f) => f.path), ["amount"]);
  });
});
