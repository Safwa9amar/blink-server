import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRICING_SEEDS } from "./pricing/catalog";
import { blinkFundedDiscount, releasesCoupon, tripPayout, tripWalletDelta } from "./cash-jobs";

describe("tripPayout", () => {
  it("takes Blink's commission off the fare", () => {
    const rate = PRICING_SEEDS.rider_commission_rate.rate;
    assert.equal(rate, 0.15);
    assert.deepEqual(tripPayout(1000, rate), { estimated_payout: 1000, net_payout: 850 });
    assert.deepEqual(tripPayout(330, rate), { estimated_payout: 330, net_payout: 281 });
    // A configured override changes the cut.
    assert.deepEqual(tripPayout(1000, 0.1), { estimated_payout: 1000, net_payout: 900 });
  });
});

describe("blinkFundedDiscount", () => {
  it("is the coupon discount on a courier or ride", () => {
    assert.equal(blinkFundedDiscount({ type: "ride", discount: 200, delivery_fee: 1000 }), 200);
    assert.equal(blinkFundedDiscount({ type: "courier", discount: "50", delivery_fee: "400" }), 50);
  });

  it("never exceeds the fare and ignores junk", () => {
    assert.equal(blinkFundedDiscount({ type: "ride", discount: 1500, delivery_fee: 1000 }), 1000);
    assert.equal(blinkFundedDiscount({ type: "ride", discount: -10, delivery_fee: 1000 }), 0);
    assert.equal(blinkFundedDiscount({ type: "ride", discount: null, delivery_fee: 1000 }), 0);
    assert.equal(blinkFundedDiscount(null), 0);
  });

  it("is nothing on a store order (the discount isn't the rider's cash)", () => {
    assert.equal(blinkFundedDiscount({ type: "merchant", discount: 200, delivery_fee: 300 }), 0);
    assert.equal(blinkFundedDiscount({ type: "shopper", discount: 200, delivery_fee: 300 }), 0);
  });
});

describe("tripWalletDelta", () => {
  const done = { status: "completed", ...tripPayout(1000, PRICING_SEEDS.rider_commission_rate.rate), penalty_amount: null };

  it("charges the commission on a completed trip", () => {
    assert.equal(tripWalletDelta(done), -150);
  });

  it("nets the funded discount against it: the rider is never out of pocket", () => {
    // 800 cash collected (1000 − 200), commission 150 − discount 200 = +50
    // Blink Cash: 800 + 50 = 850, the net payout.
    assert.equal(tripWalletDelta(done, 200), 50);
    assert.equal(tripWalletDelta(done, 150), 0);
    // Cash collected + balance effect = the net payout, whatever the discount.
    for (const discount of [0, 100, 150, 400, 1000]) {
      assert.equal(1000 - discount + tripWalletDelta(done, discount), done.net_payout);
    }
  });

  it("credits nothing on a trip that didn't complete", () => {
    assert.equal(tripWalletDelta({ ...done, status: "upcoming" }, 200), 0);
    assert.equal(tripWalletDelta({ ...done, status: "canceled" }, 200), 0);
  });

  it("charges a penalty whatever the status", () => {
    assert.equal(tripWalletDelta({ ...done, status: "canceled", penalty_amount: 200 }), -200);
    assert.equal(tripWalletDelta({ ...done, penalty_amount: "200" }), -350);
  });

  it("ignores a negative funded discount", () => {
    assert.equal(tripWalletDelta(done, -50), -150);
  });
});

describe("releasesCoupon", () => {
  const ride = { type: "ride", coupon_id: "c1" };

  it("hands the coupon back when no rider took the request", () => {
    assert.equal(releasesCoupon(ride, { by: "system", reason: "no_rider", fromStatus: "searching" }), true);
    assert.equal(
      releasesCoupon({ type: "courier", coupon_id: "c1" }, { by: "system", reason: "no_rider", fromStatus: "searching" }),
      true
    );
  });

  it("hands it back when the customer cancels while searching only", () => {
    assert.equal(releasesCoupon(ride, { by: "customer", fromStatus: "searching" }), true);
    assert.equal(releasesCoupon(ride, { by: "customer", fromStatus: "heading_to_store" }), false);
    assert.equal(releasesCoupon(ride, { by: "customer", fromStatus: "pickup" }), false);
  });

  it("keeps it on a no-show and on any other cancel", () => {
    assert.equal(releasesCoupon(ride, { by: "rider", reason: "passenger_no_show", fromStatus: "pickup" }), false);
    assert.equal(releasesCoupon(ride, { by: "system", reason: "fraud", fromStatus: "searching" }), false);
    assert.equal(releasesCoupon(ride, { by: "merchant", fromStatus: "searching" }), false);
  });

  it("needs a coupon on a courier or ride", () => {
    assert.equal(releasesCoupon({ type: "ride", coupon_id: null }, { by: "customer", fromStatus: "searching" }), false);
    assert.equal(
      releasesCoupon({ type: "merchant", coupon_id: "c1" }, { by: "customer", fromStatus: "searching" }),
      false
    );
  });
});
