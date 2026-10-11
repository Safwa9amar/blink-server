import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OFFER_PUSH_MAX_RIDERS,
  pickOfferRecipients,
  ridersNear,
  type OfferPushRider,
} from "./offer-recipients";

// Bab Ezzouar; 0.009° of latitude ≈ 1 km.
const PICKUP = { lat: 36.72, lng: 3.18 };
const rider = (id: string, kmNorth: number, vehicleType: string | null = "motorcycle"): OfferPushRider => ({
  id,
  lat: PICKUP.lat + kmNorth * 0.009,
  lng: PICKUP.lng,
  vehicleType,
});
const order = (o: Record<string, unknown> = {}) => ({ id: "o1", type: "merchant", customer_id: "cust", ...o });
const none = new Set<string>();

describe("ridersNear", () => {
  it("keeps riders inside the radius, nearest first", () => {
    const near = ridersNear([PICKUP], [rider("far", 20), rider("b", 5), rider("a", 1)], 15, 10);
    assert.deepEqual(near.map((r) => r.id), ["a", "b"]);
  });

  it("measures to the nearest pickup of a checkout", () => {
    const second = { lat: PICKUP.lat + 30 * 0.009, lng: PICKUP.lng };
    const near = ridersNear([PICKUP, second], [rider("byB", 29)], 15, 10);
    assert.deepEqual(near.map((r) => r.id), ["byB"]);
  });

  it("skips riders and pickups without a position, and caps the list", () => {
    const riders = [{ id: "nopos", lat: null, lng: null, vehicleType: null }, rider("a", 1), rider("b", 2)];
    assert.deepEqual(ridersNear([PICKUP], riders, 15, 1).map((r) => r.id), ["a"]);
    assert.deepEqual(ridersNear([{ lat: null, lng: null }], riders, 15, 10), []);
  });
});

describe("pickOfferRecipients", () => {
  it("drops the customer, busy riders and riders who declined or released it", () => {
    const near = [rider("cust", 1), rider("busy", 2), rider("declined", 3), rider("ok", 4)];
    const ids = pickOfferRecipients({
      members: [order()],
      near,
      skip: new Set(["declined"]),
      busy: new Set(["busy"]),
    });
    assert.deepEqual(ids, ["ok"]);
  });

  it("never sends a motorcycle courier request to a bicycle", () => {
    const near = [rider("bike", 1, "bicycle"), rider("moto", 2, "motorcycle")];
    const moto = pickOfferRecipients({ members: [order({ type: "courier", vehicle_type: "motorcycle" })], near, skip: none, busy: none });
    assert.deepEqual(moto, ["moto"]);
    const bike = pickOfferRecipients({ members: [order({ type: "courier", vehicle_type: "bicycle" })], near, skip: none, busy: none });
    assert.deepEqual(bike, ["bike", "moto"]);
  });

  it("caps the push at the nearest riders", () => {
    const near = Array.from({ length: OFFER_PUSH_MAX_RIDERS + 5 }, (_, i) => rider(`r${i}`, i * 0.1));
    const ids = pickOfferRecipients({ members: [order()], near, skip: none, busy: none });
    assert.equal(ids.length, OFFER_PUSH_MAX_RIDERS);
    assert.equal(ids[0], "r0");
  });

  it("applies vehicle rules to single jobs only (a checkout is store orders)", () => {
    const near = [rider("bike", 1, "bicycle")];
    const members = [order({ id: "a", customer_id: "c" }), order({ id: "b", customer_id: "c" })];
    assert.deepEqual(pickOfferRecipients({ members, near, skip: none, busy: none }), ["bike"]);
  });
});
