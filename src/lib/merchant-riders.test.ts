import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { riderFitsOrder, VEHICLE_CLASS_REFUSAL } from "./merchant-riders";
import { VEHICLE_CLASS_SEEDS } from "./pricing/vehicle-classes";

const classes = VEHICLE_CLASS_SEEDS.map((c) => ({ ...c, enabled: true }));
const moto = { vehicle_type: "motorcycle", vehicle_class: null };
const comfort = { vehicle_type: "motorcycle", vehicle_class: "motorcycle_comfort" };
const bike = { vehicle_type: "bicycle", vehicle_class: null };

describe("riderFitsOrder (merchant rider lists + assign)", () => {
  it("an exclusive class only reaches riders of that class", () => {
    assert.equal(riderFitsOrder(["motorcycle_comfort"], comfort, classes), true);
    assert.equal(riderFitsOrder(["motorcycle_comfort"], moto, classes), false);
    assert.equal(riderFitsOrder(["motorcycle_comfort"], bike, classes), false);
  });

  it("a base-vehicle class: motorcycle jobs skip bicycles, bicycle jobs take anyone", () => {
    assert.equal(riderFitsOrder(["motorcycle"], moto, classes), true);
    assert.equal(riderFitsOrder(["motorcycle"], comfort, classes), true);
    assert.equal(riderFitsOrder(["motorcycle"], bike, classes), false);
    assert.equal(riderFitsOrder(["bicycle"], bike, classes), true);
    assert.equal(riderFitsOrder(["bicycle"], comfort, classes), true);
  });

  it("legacy: a null job class (merchant mode) is open to everyone, even a rider with no profile", () => {
    assert.equal(riderFitsOrder([null], bike, classes), true);
    assert.equal(riderFitsOrder([undefined], moto, classes), true);
    assert.equal(riderFitsOrder([null], undefined, classes), true);
    assert.equal(riderFitsOrder([], bike, classes), true);
  });

  it("a checkout needs a rider every member allows", () => {
    assert.equal(riderFitsOrder(["bicycle", "motorcycle"], bike, classes), false);
    assert.equal(riderFitsOrder(["bicycle", "motorcycle"], moto, classes), true);
    assert.equal(riderFitsOrder(["motorcycle", "motorcycle_comfort"], moto, classes), false);
  });

  it("refusal carries the vehicle_class code", () => {
    assert.equal(VEHICLE_CLASS_REFUSAL.code, "vehicle_class");
  });
});
