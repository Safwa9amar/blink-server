import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rideCopy, rideHref, type RideEvent } from "./ride-copy";

const EVENTS: RideEvent[] = [
  { kind: "accepted", scheduled: false },
  { kind: "accepted", scheduled: true },
  { kind: "started" },
  { kind: "arrived" },
  { kind: "picked_up", to: "Hydra" },
  { kind: "delivered" },
  { kind: "rider_canceled" },
  { kind: "no_rider" },
  { kind: "canceled_by_rider" },
];

describe("rideCopy", () => {
  it("has a title and a description with the ref in every language", () => {
    for (const e of EVENTS) {
      const copy = rideCopy("#AB12CD", e);
      for (const lang of ["en", "fr", "ar"] as const) {
        assert.ok(copy[lang].title.trim(), `${e.kind} ${lang} title`);
        assert.ok(copy[lang].description.includes("#AB12CD"), `${e.kind} ${lang} description`);
      }
    }
  });

  it("talks about a ride, never an order or a delivery", () => {
    for (const e of EVENTS) {
      const { en } = rideCopy("#AB12CD", e);
      assert.doesNotMatch(`${en.title} ${en.description}`, /order|deliver|parcel/i, e.kind);
    }
  });

  it("invites the passenger to rate the ride at the end", () => {
    const { en } = rideCopy("#AB12CD", { kind: "delivered" });
    assert.equal(en.title, "You've arrived");
    assert.match(en.description, /rate your ride/i);
  });

  it("opens the ride tracking screen", () => {
    assert.equal(rideHref("o1"), "/(customer)/activities/ride/o1");
  });
});
