import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RIDER_NOT_VERIFIED, riderCanWork } from "./rider-access";

describe("riderCanWork", () => {
  it("allows only an approved rider", () => {
    assert.equal(riderCanWork({ verification_status: "approved" }), true);
    for (const s of ["not_submitted", "pending", "rejected"]) {
      assert.equal(riderCanWork({ verification_status: s }), false);
    }
  });
  it("treats a missing profile or status as not verified", () => {
    assert.equal(riderCanWork(null), false);
    assert.equal(riderCanWork(undefined), false);
    assert.equal(riderCanWork({}), false);
    assert.equal(riderCanWork({ verification_status: null }), false);
  });
});

describe("RIDER_NOT_VERIFIED", () => {
  it("carries the machine code the app maps", () => {
    assert.equal(RIDER_NOT_VERIFIED.code, "rider_not_verified");
    assert.ok(RIDER_NOT_VERIFIED.error.length > 0);
  });
});
