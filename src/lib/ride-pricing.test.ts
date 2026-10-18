import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { haversineKm } from "./courier-pricing";
import {
  MIN_RIDE_KM,
  quoteRide,
  rideDuration,
  rideFare,
  rideKm,
  ridePickupEtaMinutes,
  rideRouteError,
} from "./ride-pricing";
import { PRICING_SEEDS } from "./pricing/catalog";

const RATES = PRICING_SEEDS.ride_fare;

// Algiers: Grande Poste → Hydra is ~4.3 km as the crow flies.
const GRANDE_POSTE = { lat: 36.7731, lng: 3.0596 };
const HYDRA = { lat: 36.7445, lng: 3.0283 };
const BLIDA = { lat: 36.47, lng: 2.83 }; // ~40 km straight → > 40 km road
const NEXT_DOOR = { lat: 36.7741, lng: 3.0596 }; // ~110 m

describe("rideKm", () => {
  it("applies the road factor to the straight line", () => {
    const km = rideKm(GRANDE_POSTE, HYDRA);
    assert.equal(km, Math.round(haversineKm(GRANDE_POSTE, HYDRA) * 1.3 * 10) / 10);
    assert.ok(km > 5 && km < 6, `got ${km}`);
  });
});

describe("rideFare", () => {
  it("charges the base fare within the included 3 km", () => {
    assert.equal(RATES.motorcycle.base, 200);
    assert.equal(rideFare("motorcycle", 0, RATES), 200);
    assert.equal(rideFare("motorcycle", 3, RATES), 200);
  });

  it("adds 40 DZD per km beyond, rounded up to 10 DZD", () => {
    // 200 + (10 - 3) * 40 = 480
    assert.equal(rideFare("motorcycle", 10, RATES), 480);
    // 200 + (5.6 - 3) * 40 = 304 → 310
    assert.equal(rideFare("motorcycle", 5.6, RATES), 310);
  });
});

describe("fare_multiplier", () => {
  it("scales the raw fare before rounding up to 10 DZD", () => {
    // 480 raw x 1.1 = 528 -> 530; x 0.9 = 432 -> 440
    assert.equal(rideFare("motorcycle", 10, RATES, 1.1), 530);
    assert.equal(rideFare("motorcycle", 10, RATES, 0.9), 440);
    assert.equal(quoteRide(GRANDE_POSTE, HYDRA, RATES, 1.5).options[0].fare, rideFare("motorcycle", rideKm(GRANDE_POSTE, HYDRA), RATES, 1.5));
  });
});

describe("rideDuration", () => {
  it("drives at 28 km/h plus 2 minutes of boarding", () => {
    assert.equal(rideDuration("motorcycle", 14), 32);
    assert.equal(rideDuration("motorcycle", 0), 2);
  });
});

describe("rideRouteError / quoteRide", () => {
  it("refuses a pickup next to the destination", () => {
    assert.ok(haversineKm(GRANDE_POSTE, NEXT_DOOR) < MIN_RIDE_KM);
    assert.equal(rideRouteError(GRANDE_POSTE, NEXT_DOOR, RATES), "too_close");
    const { options } = quoteRide(GRANDE_POSTE, NEXT_DOOR, RATES);
    assert.equal(options[0].available, false);
    assert.equal(options[0].unavailable_reason, "too_close");
  });

  it("refuses a ride longer than 40 road km", () => {
    assert.ok(rideKm(GRANDE_POSTE, BLIDA) > RATES.motorcycle.max_km);
    assert.equal(rideRouteError(GRANDE_POSTE, BLIDA, RATES), "too_far");
    assert.equal(quoteRide(GRANDE_POSTE, BLIDA, RATES).options[0].unavailable_reason, "too_far");
  });

  it("prices a city ride with the same rules as rideFare", () => {
    assert.equal(rideRouteError(GRANDE_POSTE, HYDRA, RATES), null);
    const { distance_km, options } = quoteRide(GRANDE_POSTE, HYDRA, RATES);
    assert.equal(options.length, 1);
    const moto = options[0];
    assert.equal(moto.vehicle_type, "motorcycle");
    assert.equal(moto.available, true);
    assert.equal(moto.unavailable_reason, null);
    assert.equal(moto.fare, rideFare("motorcycle", distance_km, RATES));
    assert.equal(moto.duration_minutes, rideDuration("motorcycle", distance_km));
  });
});

describe("ridePickupEtaMinutes", () => {
  it("is null without a known rider, at least 2 minutes otherwise", () => {
    assert.equal(ridePickupEtaMinutes("motorcycle", null), null);
    assert.equal(ridePickupEtaMinutes("motorcycle", 0), 2);
    // 3 km straight → 3.9 road km at 28 km/h ≈ 8 min + 1
    assert.equal(ridePickupEtaMinutes("motorcycle", 3), 9);
  });
});
