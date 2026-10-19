import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkAdjust,
  extraEntriesTotal,
  mapLimit,
  mapWalletError,
  reconcileWallet,
  reconciliationTotals,
} from "./blink-cash-admin";
import { adjustmentCopy, duesPaymentCopy, txnEventCopy } from "./blink-cash-copy";
import { buildAuditRow } from "./finance-audit";
import { AdjustWalletBody, offerRuleIssues, settingsRuleIssues, UpdateBlinkCashSettingsBody } from "../validators/blink-cash-admin";

describe("reconciliation", () => {
  it("expects derived total + adjustments + bonuses", () => {
    const extras = extraEntriesTotal([
      { kind: "adjustment", amount: "500" },
      { kind: "offer_bonus", amount: 100 },
      { kind: "deposit", amount: 9999 },
      { kind: "opening_balance", amount: 7777 },
    ]);
    assert.equal(extras, 600);
    const r = reconcileWallet({ ledgerBalance: 5600, derivedTotal: 5000, extras });
    assert.deepEqual(r, { ledger: 5600, expected: 5600, diff: 0, drift: false });
  });

  it("counts a reversed bonus but not a reversed deposit", () => {
    const extras = extraEntriesTotal([
      { kind: "offer_bonus", amount: 100 },
      { kind: "reversal", amount: -100, idempotency_key: "reverse-bonus:abc" },
      { kind: "reversal", amount: -2000, idempotency_key: "reverse:abc" },
    ]);
    assert.equal(extras, 0);
  });

  it("flags drift above 0.01 only", () => {
    assert.equal(reconcileWallet({ ledgerBalance: 100.01, derivedTotal: 100, extras: 0 }).drift, false);
    const r = reconcileWallet({ ledgerBalance: 120, derivedTotal: 100, extras: 0 });
    assert.equal(r.drift, true);
    assert.equal(r.diff, 20);
  });

  it("totals circulation, held and drift", () => {
    assert.deepEqual(
      reconciliationTotals([
        { balance: 100.5, held: 10, drift: false },
        { balance: 50, held: 0, drift: true },
      ]),
      { circulation: 150.5, held: 10, wallets: 2, drift_count: 1 }
    );
  });

});

describe("checkAdjust", () => {
  const base = { limit: 50000, balance: 1000 };
  it("lets finance_admin adjust within the limit", () => {
    assert.deepEqual(checkAdjust({ ...base, staffRole: "finance_admin", amount: 50000 }), { ok: true, allowNegative: false });
    assert.deepEqual(checkAdjust({ ...base, staffRole: "finance_admin", amount: -1000 }), { ok: true, allowNegative: false });
  });
  it("refuses finance_admin above the limit", () => {
    assert.deepEqual(checkAdjust({ ...base, staffRole: "finance_admin", amount: 50001 }), {
      ok: false,
      status: 403,
      code: "adjust_limit_exceeded",
    });
  });
  it("never lets finance_admin go below 0", () => {
    assert.deepEqual(checkAdjust({ ...base, staffRole: "finance_admin", amount: -1000.01 }), {
      ok: false,
      status: 409,
      code: "insufficient_funds",
    });
  });
  it("super_admin is unlimited and may go negative", () => {
    assert.deepEqual(checkAdjust({ ...base, staffRole: "super_admin", amount: -900000 }), { ok: true, allowNegative: true });
  });
  it("refuses 0 and NaN", () => {
    assert.equal(checkAdjust({ ...base, staffRole: "super_admin", amount: 0 }).ok, false);
    assert.equal(checkAdjust({ ...base, staffRole: "super_admin", amount: NaN }).ok, false);
  });
  it("body needs a reason of 3+ chars", () => {
    assert.equal(AdjustWalletBody.safeParse({ amount: 10, reason: "" }).success, false);
    assert.equal(AdjustWalletBody.safeParse({ amount: 10, reason: "  x " }).success, false);
    assert.equal(AdjustWalletBody.safeParse({ amount: 0, reason: "fix" }).success, false);
    assert.equal(AdjustWalletBody.safeParse({ amount: -10, reason: "fix" }).success, true);
  });
});

describe("mapWalletError", () => {
  it("maps ledger codes to 409 and not_found to 404", () => {
    for (const code of ["insufficient_funds", "wallet_frozen", "not_pending", "expired", "wrong_agent", "not_completed", "not_in_review"]) {
      const m = mapWalletError({ code: "P0001", message: code });
      assert.equal(m?.status, 409, code);
      assert.equal(m?.body.code, code);
    }
    assert.equal(mapWalletError({ code: "P0001", message: "not_found" })?.status, 404);
  });
  it("leaves everything else to the caller", () => {
    assert.equal(mapWalletError({ code: "23505", message: "not_pending" }), null);
    assert.equal(mapWalletError({ code: "P0001", message: "boom" }), null);
    assert.equal(mapWalletError(null), null);
  });
});

describe("settings validation", () => {
  it("accepts a partial update and rejects empty / out of range", () => {
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({ deposit_fee_rate: 0.03 }).success, true);
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({}).success, false);
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({ deposit_fee_rate: 0.9 }).success, false);
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({ pending_expiry_minutes: 0 }).success, false);
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({ quick_amounts: [] }).success, false);
    assert.equal(UpdateBlinkCashSettingsBody.safeParse({ electronic_accounts: [{ label: "x", type: "paypal", number: "1", holder: "a" }] }).success, false);
  });
  it("checks cross-field rules on the merged settings", () => {
    assert.deepEqual(settingsRuleIssues({ min_amount: 1000, max_amount: 100000, daily_deposit_limit: 200000, monthly_deposit_limit: 1000000 }), []);
    assert.equal(settingsRuleIssues({ min_amount: 5000, max_amount: 1000 }).length, 1);
    assert.equal(settingsRuleIssues({ max_amount: 100000, daily_withdrawal_limit: 50000 }).length, 1);
    assert.equal(settingsRuleIssues({ daily_deposit_limit: 200000, monthly_deposit_limit: 100000 }).length, 1);
    assert.equal(settingsRuleIssues({ min_amount: 1000, max_amount: 100000, quick_amounts: [500, 1000] }).length, 1);
    assert.equal(settingsRuleIssues({ dues_payment_methods: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }).length, 1);
  });
  it("checks offers", () => {
    assert.equal(offerRuleIssues({ bonus_type: "percent", bonus_value: 150 }).length, 1);
    assert.equal(offerRuleIssues({ starts_at: "2026-10-02T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" }).length, 1);
    assert.deepEqual(offerRuleIssues({ bonus_type: "fixed", bonus_value: 500 }), []);
  });
});

describe("audit row", () => {
  it("builds the finance_audit_events payload", () => {
    assert.deepEqual(
      buildAuditRow({ actorId: "a", action: "wallet.adjust", targetType: "wallet", targetId: "u", amount: -50, reason: "  typo  ", details: { x: 1 } }),
      { actor_id: "a", action: "wallet.adjust", target_type: "wallet", target_id: "u", amount: -50, reason: "typo", details: { x: 1 } }
    );
    const bare = buildAuditRow({ actorId: "a", action: "x", targetType: "t", targetId: "i" });
    assert.equal(bare.amount, null);
    assert.equal(bare.reason, null);
    assert.deepEqual(bare.details, {});
  });
});

describe("notification copy", () => {
  it("is trilingual", () => {
    for (const c of [txnEventCopy("reversed", "deposit", 5000), adjustmentCopy(-200), duesPaymentCopy("rejected", 1500)]) {
      for (const l of [c.en, c.fr, c.ar]) assert.ok(l.title && l.description);
    }
  });
});

describe("mapLimit", () => {
  it("keeps order and bounds concurrency", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
    assert.ok(peak <= 2);
  });
});
