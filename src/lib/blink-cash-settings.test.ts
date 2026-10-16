import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, publicSettings } from "./blink-cash-settings";

describe("normalizeSettings", () => {
  it("returns the defaults when there is no row", () => {
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  });

  it("coerces numeric columns (PostgREST may send strings) and keeps arrays", () => {
    const s = normalizeSettings({
      deposit_fee_rate: "0.0300",
      min_amount: "500.00",
      quick_amounts: [500, 1500],
      electronic_enabled: true,
      electronic_accounts: [{ label: "CCP", type: "ccp", number: "1", holder: "Blink" }],
    });
    assert.equal(s.deposit_fee_rate, 0.03);
    assert.equal(s.min_amount, 500);
    assert.deepEqual(s.quick_amounts, [500, 1500]);
    assert.equal(s.electronic_enabled, true);
    assert.equal(s.electronic_accounts.length, 1);
    assert.equal(s.withdrawal_fee_rate, 0.02); // untouched default
  });

  it("falls back to the default for garbage values", () => {
    assert.equal(normalizeSettings({ max_amount: "abc" }).max_amount, DEFAULT_SETTINGS.max_amount);
  });
});

describe("publicSettings", () => {
  it("exposes only the app-facing subset", () => {
    const pub = publicSettings(DEFAULT_SETTINGS);
    assert.deepEqual(Object.keys(pub).sort(), [
      "deposit_fee_rate",
      "dues_payment_methods",
      "electronic_accounts",
      "electronic_enabled",
      "max_amount",
      "min_amount",
      "pending_expiry_minutes",
      "quick_amounts",
      "require_pin_for_withdrawal",
      "withdrawal_fee_rate",
    ]);
    assert.equal("agent_credit_limit" in pub, false);
    assert.equal("daily_deposit_limit" in pub, false);
  });
});
