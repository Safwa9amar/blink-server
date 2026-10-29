import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWilayaCode, PRICING_FIELDS, PRICING_KEYS, PRICING_SCHEMAS, PRICING_SCOPES, PRICING_SEEDS, scopeError } from "./pricing/catalog";

describe("pricing catalog", () => {
  it("has 16 keys (12 + zone pricing) and every seed passes its own schema", () => {
    assert.equal(PRICING_KEYS.length, 16);
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
    assert.deepEqual(PRICING_SEEDS.courier_fare.bicycle, { base: 140, included_km: 2, per_km: 35, max_km: 10, per_minute: 0 });
    assert.deepEqual(PRICING_SEEDS.courier_fare.motorcycle, { base: 250, included_km: 3, per_km: 40, max_km: 40, per_minute: 0 });
    assert.deepEqual(PRICING_SEEDS.ride_fare.motorcycle, { base: 200, included_km: 3, per_km: 40, max_km: 40, per_minute: 0 });
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

describe("pricing precision + field metadata", () => {
  const ok = (k: (typeof PRICING_KEYS)[number], v: unknown) => PRICING_SCHEMAS[k].safeParse(v).success;

  it("rates take at most 4 decimals, amounts and multipliers 2", () => {
    assert.equal(ok("merchant_commission_rate", { rate: 0.0525 }), true);
    assert.equal(ok("merchant_commission_rate", { rate: 0.07 }), true);
    assert.equal(ok("merchant_commission_rate", { rate: 0.05251 }), false);
    assert.equal(ok("service_fee", { amount: 1.25 }), true);
    assert.equal(ok("service_fee", { amount: 1.255 }), false);
    assert.equal(ok("fare_multiplier", { multiplier: 1.15 }), true);
    assert.equal(ok("fare_multiplier", { multiplier: 1.155 }), false);
    const leg = { base: 140.5, included_km: 2, per_km: 35, max_km: 10 };
    assert.equal(ok("ride_fare", { motorcycle: leg }), true);
    assert.equal(ok("ride_fare", { motorcycle: { ...leg, per_km: 35.005 } }), false);
  });

  it("exposes a field list per key, matching the value shape and bounds", () => {
    const paths = (k: (typeof PRICING_KEYS)[number]) => PRICING_FIELDS[k].map((f) => f.path);
    assert.deepEqual(paths("service_fee"), ["amount"]);
    assert.deepEqual(paths("fare_multiplier"), ["multiplier"]);
    assert.deepEqual(paths("ride_fare"), ["motorcycle.base", "motorcycle.included_km", "motorcycle.per_km", "motorcycle.max_km", "motorcycle.per_minute"]);
    assert.equal(PRICING_FIELDS.courier_fare.length, 11);
    assert.ok(paths("courier_fare").includes("bicycle.base") && paths("courier_fare").includes("extra_stop_fee"));
    const m = PRICING_FIELDS.merchant_commission_rate[0];
    assert.deepEqual(m, { path: "rate", unit: "rate", min: 0, max: 0.5, step: 0.0001 });
    assert.deepEqual(PRICING_FIELDS.service_fee[0], { path: "amount", unit: "da", min: 0, max: 1000, step: 0.01 });
    assert.deepEqual(PRICING_FIELDS.fare_multiplier[0], { path: "multiplier", unit: "multiplier", min: 0.5, max: 2, step: 0.01 });
    assert.equal(PRICING_FIELDS.ride_fare[1].unit, "km");
    assert.equal(PRICING_FIELDS.ride_fare[1].step, 0.1);
    // every seed leaf is covered by exactly one field
    for (const k of PRICING_KEYS) {
      for (const f of PRICING_FIELDS[k]) {
        // bool / choice / tier fields aren't numbers (checked in pricing-zones.test.ts).
        if (f.unit === "bool" || f.unit === "choice" || f.unit === "tier") continue;
        const v = f.path.split(".").reduce<any>((o, p) => o?.[p], PRICING_SEEDS[k]);
        assert.equal(typeof v, "number", `${k}.${f.path}`);
        assert.ok(v >= f.min && v <= f.max, `${k}.${f.path} in bounds`);
      }
    }
  });

  it("wilaya scope is 1..58", () => {
    assert.equal(isWilayaCode("1"), true);
    assert.equal(isWilayaCode("16"), true);
    assert.equal(isWilayaCode("58"), true);
    assert.equal(isWilayaCode("59"), false);
    assert.equal(isWilayaCode("0"), false);
    assert.equal(isWilayaCode("01"), false);
    assert.equal(isWilayaCode("alger"), false);
    assert.match(scopeError("service_fee", { wilaya_code: "99" }) ?? "", /1 to 58/);
    assert.equal(scopeError("service_fee", { wilaya_code: "16" }), null);
  });
});
