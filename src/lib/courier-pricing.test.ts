import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  courierDuration,
  courierFare,
  haversineKm,
  pickupEtaMinutes,
  quoteRoute,
  routeKm,
} from "./courier-pricing";
import { PRICING_SEEDS } from "./pricing/catalog";

const RATES = PRICING_SEEDS.courier_fare;
const EXTRA_STOP_FEE = RATES.extra_stop_fee;

// Algiers: Grande Poste → Hydra is ~4.3 km as the crow flies.
const GRANDE_POSTE = { lat: 36.7731, lng: 3.0596 };
const HYDRA = { lat: 36.7445, lng: 3.0283 };
const BAB_EZZOUAR = { lat: 36.7213, lng: 3.1834 };

describe("haversineKm / routeKm", () => {
  it("measures great-circle km", () => {
    const km = haversineKm(GRANDE_POSTE, HYDRA);
    assert.ok(km > 4 && km < 4.6, `got ${km}`);
    assert.equal(haversineKm(HYDRA, HYDRA), 0);
  });

  it("sums the legs in order and applies the road factor", () => {
    const direct = routeKm(GRANDE_POSTE, [BAB_EZZOUAR]);
    const viaHydra = routeKm(GRANDE_POSTE, [HYDRA, BAB_EZZOUAR]);
    assert.ok(viaHydra > direct);
    const legs = haversineKm(GRANDE_POSTE, HYDRA) + haversineKm(HYDRA, BAB_EZZOUAR);
    assert.equal(viaHydra, Math.round(legs * 1.3 * 10) / 10);
  });
});

describe("courierFare", () => {
  it("charges the base fare within the included distance", () => {
    assert.equal(courierFare("bicycle", 0, 1, RATES), RATES.bicycle.base);
    assert.equal(courierFare("bicycle", RATES.bicycle.included_km, 1, RATES), RATES.bicycle.base);
    assert.equal(courierFare("motorcycle", 1, 1, RATES), RATES.motorcycle.base);
  });

  it("adds per-km beyond the included distance, rounded up to 10 DZD", () => {
    // bicycle: 140 + (5 - 2) * 35 = 245 → 250
    assert.equal(courierFare("bicycle", 5, 1, RATES), 250);
    // motorcycle: 250 + (10 - 3) * 40 = 530
    assert.equal(courierFare("motorcycle", 10, 1, RATES), 530);
  });

  it("adds a fee per drop-off after the first", () => {
    assert.equal(courierFare("motorcycle", 1, 3, RATES), RATES.motorcycle.base + 2 * EXTRA_STOP_FEE);
  });

  it("never drops below the base", () => {
    assert.equal(courierFare("motorcycle", 0, 0, RATES), RATES.motorcycle.base);
  });
});

describe("fare_multiplier", () => {
  it("scales the raw fare before rounding up to 10 DZD", () => {
    // motorcycle 10 km: 530 raw; x1.2 = 636 -> 640
    assert.equal(courierFare("motorcycle", 10, 1, RATES, 1.2), 640);
    // with an extra stop: (250 + 60) * 0.9 = 279 -> 280
    assert.equal(courierFare("motorcycle", 1, 2, RATES, 0.9), 280);
    assert.equal(courierFare("motorcycle", 10, 1, RATES, 1), 530);
  });

  it("applies to every quoted option and uses the configured rates", () => {
    const { options } = quoteRoute(GRANDE_POSTE, [HYDRA], RATES, 1.5);
    for (const o of options) {
      assert.equal(o.fare, courierFare(o.vehicle_type, routeKm(GRANDE_POSTE, [HYDRA]), 1, RATES, 1.5));
    }
    const pricier = { ...RATES, motorcycle: { ...RATES.motorcycle, base: 300 } };
    assert.equal(courierFare("motorcycle", 1, 1, pricier), 300);
  });
});

describe("quoteRoute", () => {
  it("prices every vehicle and marks routes too long for a bicycle", () => {
    const far = { lat: 36.7, lng: 3.21 }; // ~20 km road
    const { distance_km, options } = quoteRoute(GRANDE_POSTE, [far], RATES);
    assert.ok(distance_km > RATES.bicycle.max_km);
    const bike = options.find((o) => o.vehicle_type === "bicycle")!;
    const moto = options.find((o) => o.vehicle_type === "motorcycle")!;
    assert.equal(bike.available, false);
    assert.equal(moto.available, true);
    assert.ok(moto.duration_minutes < bike.duration_minutes);
  });

  it("matches courierFare for the same route", () => {
    const { distance_km, options } = quoteRoute(GRANDE_POSTE, [HYDRA, BAB_EZZOUAR], RATES);
    for (const o of options) {
      assert.equal(o.fare, courierFare(o.vehicle_type, distance_km, 2, RATES));
      assert.equal(o.duration_minutes, courierDuration(o.vehicle_type, distance_km, 2));
    }
  });
});

describe("pickupEtaMinutes", () => {
  it("is null without a known rider", () => {
    assert.equal(pickupEtaMinutes("bicycle", null), null);
  });

  it("is at least 2 minutes and faster on a motorcycle", () => {
    assert.equal(pickupEtaMinutes("motorcycle", 0), 2);
    const bike = pickupEtaMinutes("bicycle", 3)!;
    const moto = pickupEtaMinutes("motorcycle", 3)!;
    assert.ok(moto < bike);
  });
});
