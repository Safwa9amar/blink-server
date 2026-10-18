import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRICING_KEYS, PRICING_SCHEMAS, PRICING_SCOPES, PRICING_SEEDS, scopeError } from "./pricing/catalog";

describe("pricing catalog", () => {
  it("has 12 keys and every seed passes its own schema", () => {
    assert.equal(PRICING_KEYS.length, 12);
    for (const k of PRICING_KEYS) {
      assert.ok(PRICING_SCHEMAS[k].safeParse(PRICING_SEEDS[k]).success, k);
      assert.ok(PRICING_SCOPES[k], k);
    }
  });

  it("seeds equal today's constants", () => {
    assert.equal(PRICING_SEEDS.service_fee.amount, 1.5);
    assert.equal(PRICING_SEEDS.rider_commission_rate.rate, 0.15);
    assert.equal(PRICING_SEEDS.rider_cancel_penalty.amount, 200);
    assert.equal(PRICING_SEEDS.merchant_commission_rate.rate, 0.05);
    assert.equal(PRICING_SEEDS.stamp_duty_rate.rate, 0.01);
    assert.equal(PRICING_SEEDS.blink_cash_fee_rate.rate, 0.02);
    assert.equal(PRICING_SEEDS.agent_platform_share.rate, 0.2);
    assert.equal(PRICING_SEEDS.agent_tax_rate.rate, 0.01);
    assert.equal(PRICING_SEEDS.dues_payment_fee_rate.rate, 0.002);
    assert.equal(PRICING_SEEDS.courier_fare.extra_stop_fee, 60);
    assert.deepEqual(PRICING_SEEDS.courier_fare.bicycle, { base: 140, included_km: 2, per_km: 35, max_km: 10 });
    assert.deepEqual(PRICING_SEEDS.courier_fare.motorcycle, { base: 250, included_km: 3, per_km: 40, max_km: 40 });
    assert.deepEqual(PRICING_SEEDS.ride_fare.motorcycle, { base: 200, included_km: 3, per_km: 40, max_km: 40 });
  });

  it("enforces the spec bounds", () => {
    const ok = (k: (typeof PRICING_KEYS)[number], v: unknown) => PRICING_SCHEMAS[k].safeParse(v).success;
    assert.equal(ok("fare_multiplier", { multiplier: 0.5 }), true);
    assert.equal(ok("fare_multiplier", { multiplier: 2.01 }), false);
    assert.equal(ok("fare_multiplier", { multiplier: 0.49 }), false);
    assert.equal(ok("rider_commission_rate", { rate: 0.5 }), true);
    assert.equal(ok("rider_commission_rate", { rate: 0.51 }), false);
    assert.equal(ok("merchant_commission_rate", { rate: -0.01 }), false);
    assert.equal(ok("blink_cash_fee_rate", { rate: 0.1 }), true);
    assert.equal(ok("blink_cash_fee_rate", { rate: 0.11 }), false);
    assert.equal(ok("agent_platform_share", { rate: 1 }), true);
    assert.equal(ok("agent_platform_share", { rate: 1.01 }), false);
    assert.equal(ok("rider_cancel_penalty", { amount: 5000 }), true);
    assert.equal(ok("rider_cancel_penalty", { amount: 5001 }), false);
    assert.equal(ok("stamp_duty_rate", { rate: 0.21 }), false);
    assert.equal(ok("dues_payment_fee_rate", { rate: 0.051 }), false);
    assert.equal(ok("service_fee", { amount: "1" }), false);
    assert.equal(ok("service_fee", { amount: 1, extra: 1 }), false);
  });

  it("validates scopes per key", () => {
    assert.equal(scopeError("service_fee", { service: "merchant", wilaya_code: "16" }), null);
    assert.ok(scopeError("service_fee", { service: "courier" }));
    assert.ok(scopeError("service_fee", { merchant_id: "m" }));
    assert.equal(scopeError("merchant_commission_rate", { merchant_id: "m", wilaya_code: "16" }), null);
    assert.ok(scopeError("merchant_commission_rate", { agent_id: "a" }));
    assert.equal(scopeError("agent_platform_share", { agent_id: "a" }), null);
    assert.ok(scopeError("stamp_duty_rate", { wilaya_code: "16" }));
    assert.ok(scopeError("rider_cancel_penalty", { wilaya_code: "16" }));
    assert.equal(scopeError("blink_cash_fee_rate", { service: "withdrawal" }), null);
    assert.ok(scopeError("courier_fare", { service: "courier" }));
  });
});
