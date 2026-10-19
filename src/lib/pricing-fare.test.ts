import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { legFare } from "./pricing/fare";

const leg = { base: 200, included_km: 3, per_km: 40, max_km: 40 };

describe("legFare", () => {
  it("does not let float noise bump the 10 DA step (200 × 1.1 → 220)", () => {
    assert.equal(legFare(leg, 2, { multiplier: 1.1 }), 220);
  });
  it("rounds genuinely higher fares up", () => {
    assert.equal(legFare(leg, 5, { multiplier: 1 }), 280);
    assert.equal(legFare(leg, 3.1, { multiplier: 1 }), 210);
  });
});
