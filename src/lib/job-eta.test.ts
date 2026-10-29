import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jobBaseVehicle, jobDurationMinutes, jobSpeedKmh } from "./job-eta";
import { SEED_FORMULA } from "./pricing/fare";

const formula = { ...SEED_FORMULA, speed_kmh: { bicycle: 10, motorcycle: 30 }, stop_minutes: 5, boarding_minutes: 4 };

describe("job ETA from fare_formula", () => {
  it("resolves the base vehicle of a class code; unknown / null = motorcycle", () => {
    assert.equal(jobBaseVehicle("bicycle"), "bicycle");
    assert.equal(jobBaseVehicle("motorcycle_comfort"), "motorcycle");
    assert.equal(jobBaseVehicle(null), "motorcycle");
    assert.equal(jobBaseVehicle("car"), "motorcycle");
    assert.equal(jobSpeedKmh(formula, "bicycle"), 10);
  });

  it("drive time at the base vehicle's speed", () => {
    assert.equal(jobDurationMinutes(10, { formula, vehicle: "bicycle" }), 60);
    assert.equal(jobDurationMinutes(10, { formula, vehicle: "motorcycle" }), 20);
    assert.equal(jobDurationMinutes(10, { formula }), 20);
  });

  it("adds stop_minutes per courier drop-off and boarding_minutes for a ride", () => {
    assert.equal(jobDurationMinutes(10, { formula, vehicle: "motorcycle", stops: 3 }), 35);
    assert.equal(jobDurationMinutes(10, { formula, vehicle: "motorcycle", ride: true }), 24);
  });

  it("is at least a minute", () => {
    assert.equal(jobDurationMinutes(0, { formula }), 1);
  });

  it("seed formula: only the moto speed differs from the old 25 km/h constant", () => {
    assert.equal(jobDurationMinutes(7, { vehicle: "motorcycle" }), Math.round((7 / SEED_FORMULA.speed_kmh.motorcycle) * 60));
    assert.equal(jobDurationMinutes(5, { vehicle: "motorcycle", stops: 2 }), Math.round((5 / SEED_FORMULA.speed_kmh.motorcycle) * 60 + 2 * SEED_FORMULA.stop_minutes));
    assert.equal(SEED_FORMULA.stop_minutes, 3); // = the old COURIER_STOP_MINUTES
  });
});
