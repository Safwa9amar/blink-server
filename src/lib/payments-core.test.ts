import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  amountMatches,
  appRedirectUrl,
  chargilyEventStatus,
  convertFromDzd,
  fromMinorUnits,
  isPastExpiry,
  mapChargilyStatus,
  mapSatimOrderStatus,
  mapStripeSession,
  needsSync,
  returnUrl,
  routeMethod,
  toMinorUnits,
  verifyHmacSha256Hex,
  webhookUrl,
  wholeChargeFees,
  wholeDinars,
  type RoutingConfig,
} from "./payments/core";

const cfg = (over: Partial<RoutingConfig> = {}, on = { chargily: true, stripe: true, satim: false }): RoutingConfig => ({
  cibProvider: "chargily",
  configured: on,
  ...over,
});

test("routing: edahabia -> chargily, card -> stripe", () => {
  assert.equal(routeMethod("edahabia", cfg()), "chargily");
  assert.equal(routeMethod("card", cfg()), "stripe");
});

test("routing: cib defaults to chargily; satim only when asked for and configured", () => {
  assert.equal(routeMethod("cib", cfg()), "chargily");
  assert.equal(routeMethod("cib", cfg({ cibProvider: "satim" })), "chargily");
  assert.equal(routeMethod("cib", cfg({ cibProvider: "satim" }, { chargily: true, stripe: false, satim: true })), "satim");
});

test("routing: unconfigured provider -> null", () => {
  assert.equal(routeMethod("card", cfg({}, { chargily: true, stripe: false, satim: false })), null);
  assert.equal(routeMethod("edahabia", cfg({}, { chargily: false, stripe: true, satim: false })), null);
});

test("hmac: accepts the right signature, rejects tampering and junk", () => {
  const body = '{"type":"checkout.paid"}';
  const sig = createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyHmacSha256Hex(body, sig, "secret"), true);
  assert.equal(verifyHmacSha256Hex(body + " ", sig, "secret"), false);
  assert.equal(verifyHmacSha256Hex(body, sig, "other"), false);
  assert.equal(verifyHmacSha256Hex(body, "zz", "secret"), false);
  assert.equal(verifyHmacSha256Hex(body, sig.slice(2), "secret"), false);
  assert.equal(verifyHmacSha256Hex(body, null, "secret"), false);
  assert.equal(verifyHmacSha256Hex(body, sig, ""), false);
});

test("amounts: exact match only, currency case-insensitive", () => {
  assert.equal(amountMatches({ amount: 1050, currency: "DZD" }, { amount: 1050, currency: "dzd" }), true);
  assert.equal(amountMatches({ amount: 1050, currency: "DZD" }, { amount: 1049.99, currency: "dzd" }), false);
  assert.equal(amountMatches({ amount: 1050, currency: "DZD" }, { amount: 1050, currency: "usd" }), false);
  assert.equal(amountMatches({ amount: 10.1, currency: "DZD" }, { amount: 10.1, currency: "DZD" }), true);
  assert.equal(amountMatches({ amount: 10, currency: "DZD" }, { amount: NaN, currency: "DZD" }), false);
});

test("minor units: x100 except zero-decimal", () => {
  assert.equal(toMinorUnits(10.5, "dzd"), 1050);
  assert.equal(toMinorUnits(19.99, "USD"), 1999);
  assert.equal(toMinorUnits(500, "jpy"), 500);
  assert.equal(fromMinorUnits(1050, "dzd"), 10.5);
  assert.equal(fromMinorUnits(500, "jpy"), 500);
});

test("wholeChargeFees: the fee absorbs the rounding so base + fee is whole", () => {
  assert.equal(wholeChargeFees(1000, 20), 20);
  assert.equal(wholeChargeFees(1234, 24.68), 25);
  assert.equal(wholeChargeFees(1234.56, 0), 0.44);
  assert.equal(wholeChargeFees(1234.56, 24.69), 25.44);
  assert.ok(Number.isInteger(1234.56 + wholeChargeFees(1234.56, 24.69)));
});

test("wholeDinars: rounds up and reports the adjustment", () => {
  assert.deepEqual(wholeDinars(1000), { charged: 1000, adjustment: 0 });
  assert.deepEqual(wholeDinars(1030.85), { charged: 1031, adjustment: 0.15 });
  assert.deepEqual(wholeDinars(0.1 + 0.2 + 99.7), { charged: 100, adjustment: 0 });
});

test("status mapping", () => {
  assert.equal(mapChargilyStatus("paid"), "paid");
  assert.equal(mapChargilyStatus("canceled"), "canceled");
  assert.equal(mapChargilyStatus("processing"), null);
  assert.equal(mapChargilyStatus(undefined), null);
  assert.equal(chargilyEventStatus("checkout.failed"), "failed");
  assert.equal(chargilyEventStatus("other"), null);
  assert.equal(mapStripeSession({ status: "complete", payment_status: "paid" }), "paid");
  assert.equal(mapStripeSession({ status: "complete", payment_status: "unpaid" }), null);
  assert.equal(mapStripeSession({ status: "expired", payment_status: "unpaid" }), "expired");
  assert.equal(mapSatimOrderStatus(2), "paid");
  assert.equal(mapSatimOrderStatus("6"), "failed");
  assert.equal(mapSatimOrderStatus(0), null);
});

test("urls", () => {
  assert.equal(returnUrl("https://x.dz", "/blink", "p1", "success"), "https://x.dz/blink/payments/return/p1?outcome=success");
  assert.equal(returnUrl("https://x.dz", "", "p1"), "https://x.dz/payments/return/p1");
  assert.equal(webhookUrl("https://x.dz", "", "stripe"), "https://x.dz/payments/webhooks/stripe");
  assert.equal(appRedirectUrl("blink://payments/return", "p1", "failure"), "blink://payments/return?payment_id=p1&outcome=failure");
  assert.equal(appRedirectUrl("blink://r?a=1", "p1", "success"), "blink://r?a=1&payment_id=p1&outcome=success");
});

test("timing", () => {
  const now = Date.parse("2026-10-20T10:00:10Z");
  assert.equal(needsSync(null, now), true);
  assert.equal(needsSync("2026-10-20T10:00:05Z", now), false);
  assert.equal(needsSync("2026-10-20T10:00:00Z", now), true);
  assert.equal(isPastExpiry("2026-10-20T09:59:00Z", now), true);
  assert.equal(isPastExpiry(null, now), false);
});

test("convertFromDzd: dinars to the charge currency at the fixed rate, rounded up to the cent", () => {
  assert.equal(convertFromDzd(1020, 250), 4.08);
  assert.equal(convertFromDzd(1000.5, 250), 4.01);
  assert.equal(convertFromDzd(1000, 300), 3.34);
  assert.equal(convertFromDzd(125, 250), 0.5);
  // Never short: the euro charge is worth at least the dinars at the rate.
  for (const dzd of [99.99, 1234.56, 5000, 20400]) assert.ok(convertFromDzd(dzd, 247.5) * 247.5 >= dzd - 1e-9);
});
