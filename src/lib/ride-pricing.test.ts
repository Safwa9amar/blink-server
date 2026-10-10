import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { haversineKm } from "./courier-pricing";
import {
  MIN_RIDE_KM,
  quoteRide,
  RIDE_RATES,
  rideDuration,
  rideFare,
  rideKm,
  ridePickupEtaMinutes,
  rideRouteError,
} from "./ride-pricing";

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
    assert.equal(RIDE_RATES.motorcycle.base, 200);
    assert.equal(rideFare("motorcycle", 0), 200);
    assert.equal(rideFare("motorcycle", 3), 200);
  });

  it("adds 40 DZD per km beyond, rounded up to 10 DZD", () => {
    // 200 + (10 - 3) * 40 = 480
    assert.equal(rideFare("motorcycle", 10), 480);
    // 200 + (5.6 - 3) * 40 = 304 → 310
    assert.equal(rideFare("motorcycle", 5.6), 310);
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
    assert.equal(rideRouteError(GRANDE_POSTE, NEXT_DOOR), "too_close");
    const { options } = quoteRide(GRANDE_POSTE, NEXT_DOOR);
    assert.equal(options[0].available, false);
    assert.equal(options[0].unavailable_reason, "too_close");
  });

  it("refuses a ride longer than 40 road km", () => {
    assert.ok(rideKm(GRANDE_POSTE, BLIDA) > RIDE_RATES.motorcycle.maxKm);
    assert.equal(rideRouteError(GRANDE_POSTE, BLIDA), "too_far");
    assert.equal(quoteRide(GRANDE_POSTE, BLIDA).options[0].unavailable_reason, "too_far");
  });

  it("prices a city ride with the same rules as rideFare", () => {
    assert.equal(rideRouteError(GRANDE_POSTE, HYDRA), null);
    const { distance_km, options } = quoteRide(GRANDE_POSTE, HYDRA);
    assert.equal(options.length, 1);
    const moto = options[0];
    assert.equal(moto.vehicle_type, "motorcycle");
    assert.equal(moto.available, true);
    assert.equal(moto.unavailable_reason, null);
    assert.equal(moto.fare, rideFare("motorcycle", distance_km));
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
