import assert from "node:assert/strict";
import { test } from "node:test";
import { PRICING_KEYS, PRICING_SEEDS } from "./pricing/catalog";
import { feeExample } from "./pricing/examples";
import { simulate, type SimPrices } from "./pricing/simulate";

const S = PRICING_SEEDS;
const ex = (k: (typeof PRICING_KEYS)[number]) => feeExample(k, S[k]);

test("feeExample at the seeds", () => {
  assert.deepEqual(ex("courier_fare"), { kind: "trip_km", vehicle: "motorcycle", km: 5, output: 330 });
  assert.deepEqual(ex("ride_fare"), { kind: "trip_km", vehicle: "motorcycle", km: 5, output: 280 });
  assert.deepEqual(ex("fare_multiplier"), { kind: "multiplier", km: 5, input: 280, output: 280 });
  assert.deepEqual(ex("rider_commission_rate"), { kind: "rate_on_amount", input: 400, output: 60 });
  assert.deepEqual(ex("merchant_commission_rate"), { kind: "rate_on_amount", input: 10000, output: 500 });
  assert.deepEqual(ex("stamp_duty_rate"), { kind: "rate_on_amount", input: 10000, output: 100 });
  assert.deepEqual(ex("blink_cash_fee_rate"), { kind: "rate_on_amount", input: 1000, output: 20 });
  assert.deepEqual(ex("dues_payment_fee_rate"), { kind: "rate_on_amount", input: 10000, output: 20 });
  assert.deepEqual(ex("agent_tax_rate"), { kind: "rate_on_amount", input: 80, output: 0.8 });
  assert.deepEqual(ex("agent_platform_share"), { kind: "agent_split", input: 100, output: 79.2 });
  assert.deepEqual(ex("rider_cancel_penalty"), { kind: "amount", output: 200 });
  assert.deepEqual(ex("service_fee"), { kind: "per_checkout", output: 1.5 });
});

test("feeExample uses other values and rejects invalid ones", () => {
  assert.equal((feeExample("fare_multiplier", { multiplier: 1.5 }) as any).output, 420);
  assert.equal((feeExample("agent_platform_share", { rate: 0.2 }, { agent_tax_rate: { rate: 0 } }) as any).output, 80);
  assert.equal(feeExample("service_fee", { amount: -1 }), null);
});

const prices: SimPrices = { ...S };
const sum = (r: ReturnType<typeof simulate>) => Math.round(r.lines.reduce((n, l) => n + l.amount, 0) * 100) / 100;
const by = (r: ReturnType<typeof simulate>) => Object.fromEntries(r.lines.map((l) => [l.label, l.amount]));

test("simulate store worked example", () => {
  const r = simulate("store", { subtotal: 2000, delivery_fee: 200 }, prices);
  assert.equal(r.payer_total, 2201.5);
  assert.deepEqual(by(r), {
    merchant_keeps: 1880, rider_keeps: 170, service_fee: 1.5, merchant_commission: 100, rider_commission: 30, stamp_duty: 20,
  });
  assert.equal(sum(r), r.payer_total);
});

test("simulate courier and ride sum to the fare", () => {
  const c = simulate("courier", { km: 5, vehicle: "motorcycle" }, prices);
  assert.equal(c.payer_total, 330);
  assert.equal(sum(c), 330);
  assert.deepEqual(by(c), { rider_keeps: 281, rider_commission: 49 });
  const r = simulate("ride", { km: 5 }, prices);
  assert.equal(r.payer_total, 280);
  assert.equal(sum(r), 280);
});

test("simulate deposit / withdrawal", () => {
  const d = simulate("deposit", { amount: 1000 }, prices);
  assert.equal(d.payer_total, 1020);
  assert.deepEqual(by(d), { platform_share: 4, agent_tax: 0.16, agent_keeps: 15.84 });
  assert.equal(sum(d), 20);
  assert.equal(simulate("withdrawal", { amount: 1000 }, prices).payer_total, 980);
});

test("simulate too_far", () => {
  const r = simulate("courier", { km: 11, vehicle: "bicycle" }, prices);
  assert.equal(r.unavailable, "too_far");
  assert.deepEqual(r.lines, []);
  assert.equal(simulate("ride", { km: 41 }, prices).unavailable, "too_far");
  assert.equal(simulate("courier", { km: 40, vehicle: "motorcycle" }, prices).unavailable, null);
});
