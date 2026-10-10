import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courierHref } from "./courier-copy";
import { rideHref } from "./ride-copy";
import { CLEAR_OFFER } from "./rider-offer";
import {
  bookedJobs,
  CHECKOUT_RELEASE_PATCH,
  releaseNotice,
  releasePatch,
  storeReleaseNotice,
} from "./rider-release-rules";

const NOW = "2026-10-10T12:00:00.000Z";

describe("bookedJobs", () => {
  it("keeps single orders still searching, not the one under way", () => {
    const { singles, checkouts } = bookedJobs([
      { id: "a", status: "searching", checkout_id: null },
      { id: "b", status: "heading_to_store", checkout_id: null },
      { id: "c", status: "searching" },
    ]);
    assert.deepEqual(
      singles.map((o) => o.id),
      ["a", "c"]
    );
    assert.deepEqual(checkouts, []);
  });

  it("groups a booked checkout's members into one job", () => {
    const { singles, checkouts } = bookedJobs([
      { id: "m1", status: "searching", checkout_id: "k1" },
      { id: "s", status: "searching", checkout_id: null },
      { id: "m2", status: "searching", checkout_id: "k1" },
    ]);
    assert.deepEqual(
      singles.map((o) => o.id),
      ["s"]
    );
    assert.deepEqual(
      checkouts.map((members) => members.map((o) => o.id)),
      [["m1", "m2"]]
    );
  });

  it("leaves a checkout with a stop under way to the rider", () => {
    const { checkouts } = bookedJobs([
      { id: "m1", status: "searching", checkout_id: "k1" },
      { id: "m2", status: "heading_to_store", checkout_id: "k1" },
      { id: "n1", status: "searching", checkout_id: "k2" },
    ]);
    assert.deepEqual(
      checkouts.map((members) => members.map((o) => o.id)),
      [["n1"]]
    );
  });
});

describe("releasePatch", () => {
  it("unassigns the rider, clears any request and keeps the order searching", () => {
    for (const type of ["merchant", "shopper", "courier", "ride"]) {
      const patch = releasePatch({ type }, NOW) as Record<string, unknown>;
      assert.equal(patch.rider_id, null);
      assert.equal(patch.rider_assigned_at, null);
      for (const [k, v] of Object.entries(CLEAR_OFFER)) assert.equal(patch[k], v, `${type} ${k}`);
      assert.equal("status" in patch, false, type);
    }
  });

  it("hands a store order back without a delivery mode or own driver", () => {
    const patch = releasePatch({ type: "merchant" }, NOW) as Record<string, unknown>;
    assert.equal(patch.delivery_mode, null);
    assert.equal(patch.store_driver_id, null);
    assert.equal("accepted_at" in patch, false);
  });

  it("restarts a courier or ride's search window", () => {
    for (const type of ["courier", "ride"]) {
      const patch = releasePatch({ type }, NOW) as Record<string, unknown>;
      assert.equal(patch.accepted_at, NOW);
      assert.equal("delivery_mode" in patch, false);
    }
  });

  it("frees every checkout member's delivery mode", () => {
    assert.equal(CHECKOUT_RELEASE_PATCH.rider_id, null);
    assert.equal(CHECKOUT_RELEASE_PATCH.delivery_mode, null);
    assert.equal(CHECKOUT_RELEASE_PATCH.store_driver_id, null);
    assert.equal(CHECKOUT_RELEASE_PATCH.offered_rider_id, null);
  });
});

describe("releaseNotice", () => {
  const TYPES = ["merchant", "shopper", "courier", "ride"];

  it("has a title and the ref in every language, without blaming the rider", () => {
    for (const type of TYPES) {
      const n = releaseNotice({ id: "o1", type }, "#AB12CD");
      for (const lang of ["en", "fr", "ar"] as const) {
        assert.ok(n[lang].title.trim(), `${type} ${lang} title`);
        assert.ok(n[lang].description.includes("#AB12CD"), `${type} ${lang} description`);
      }
      assert.doesNotMatch(n.en.description, /cancel|dropped/i, type);
      assert.doesNotMatch(n.fr.description, /annulé|abandonné/i, type);
    }
  });

  it("sends courier and ride notices on their own channel", () => {
    const courier = releaseNotice({ id: "o1", type: "courier" }, "#A");
    assert.equal(courier.type, "courier");
    assert.equal(courier.href, courierHref("o1"));
    const ride = releaseNotice({ id: "o1", type: "ride" }, "#A");
    assert.equal(ride.type, "ride");
    assert.equal(ride.href, rideHref("o1"));
    for (const type of ["merchant", "shopper"]) {
      const n = releaseNotice({ id: "o1", type }, "#A");
      assert.equal(n.type, "order");
      assert.equal(n.href, undefined);
    }
  });

  it("talks about a ride, never an order or a delivery, for a ride", () => {
    const { en } = releaseNotice({ id: "o1", type: "ride" }, "#A");
    assert.doesNotMatch(`${en.title} ${en.description}`, /order|deliver/i);
  });
});

describe("storeReleaseNotice", () => {
  it("names the rider and the order in every language", () => {
    const n = storeReleaseNotice({ en: "Sami", fr: "Sami", ar: "سامي" }, "#AB12CD");
    for (const lang of ["en", "fr", "ar"] as const) {
      assert.ok(n[lang].title.includes("#AB12CD"), `${lang} title`);
      assert.ok(n[lang].description.trim(), `${lang} description`);
    }
    assert.ok(n.ar.title.includes("سامي"));
  });
});
