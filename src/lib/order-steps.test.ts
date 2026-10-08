import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickedUpPatch } from "./order-steps";

const NOW = "2026-10-08T17:00:00.000Z";

describe("pickedUpPatch", () => {
  it("on the way, stamped", () => {
    assert.deepEqual(pickedUpPatch({ type: "merchant", merchant_status: "ready" }, NOW), {
      status: "on_the_way",
      picked_up_at: NOW,
    });
  });

  it("a store order collected before the store marked it prepared is prepared now", () => {
    assert.deepEqual(pickedUpPatch({ type: "merchant", merchant_status: "accepted" }, NOW), {
      status: "on_the_way",
      picked_up_at: NOW,
      merchant_status: "ready",
      prepared_at: NOW,
    });
  });

  it("leaves shopper / courier orders and other merchant states alone", () => {
    for (const o of [
      { type: "shopper", merchant_status: "rejected" },
      { type: "courier", merchant_status: null },
      { type: "merchant", merchant_status: null },
    ]) {
      assert.deepEqual(pickedUpPatch(o, NOW), { status: "on_the_way", picked_up_at: NOW });
    }
  });
});
