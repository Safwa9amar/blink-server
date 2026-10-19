import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceAttribution, toPriceChange } from "./price-history";

describe("priceAttribution", () => {
  it("attributes a write that touches price or blink_price", () => {
    assert.deepEqual(priceAttribution({ price: 80 }, "merchant", "u1"), {
      price_update_source: "merchant",
      price_updated_by: "u1",
    });
    assert.deepEqual(priceAttribution({ blink_price: 80 }, "staff", "u2"), {
      price_update_source: "staff",
      price_updated_by: "u2",
    });
  });

  it("leaves other writes alone", () => {
    assert.deepEqual(priceAttribution({ stock: 3, suggested_price: 90 }, "merchant", "u1"), {});
  });
});

describe("toPriceChange", () => {
  it("turns numeric strings into numbers and keeps nulls", () => {
    assert.deepEqual(
      toPriceChange({
        id: "c1",
        old_price: null,
        new_price: "100.00",
        old_blink_price: null,
        new_blink_price: "100.00",
        source: "created",
        changed_at: "2026-10-01T00:00:00Z",
      }),
      {
        id: "c1",
        old_price: null,
        new_price: 100,
        old_blink_price: null,
        new_blink_price: 100,
        source: "created",
        changed_at: "2026-10-01T00:00:00Z",
      }
    );
  });
});
