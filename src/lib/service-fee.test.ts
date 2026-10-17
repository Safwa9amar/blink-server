import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SERVICE_FEE, serviceFeeFor } from "./service-fee";

describe("serviceFeeFor", () => {
  it("charges the server's fee on a store order that starts a checkout", () => {
    assert.equal(serviceFeeFor({ type: "merchant", checkoutAlreadyCharged: false }), SERVICE_FEE);
    assert.equal(SERVICE_FEE, 1.5);
  });

  it("charges nothing on a later order of a checkout that already paid it", () => {
    assert.equal(serviceFeeFor({ type: "merchant", checkoutAlreadyCharged: true }), 0);
  });

  it("treats shopper orders like store orders", () => {
    assert.equal(serviceFeeFor({ type: "shopper", checkoutAlreadyCharged: false }), SERVICE_FEE);
  });

  it("charges nothing on courier and ride orders", () => {
    for (const type of ["courier", "ride"]) {
      assert.equal(serviceFeeFor({ type, checkoutAlreadyCharged: false }), 0);
    }
  });
});
