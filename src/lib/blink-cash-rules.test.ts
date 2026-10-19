import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentCapacity,
  agentLimit,
  algiersDayStartIso,
  algiersMonthStartIso,
  bonusFor,
  breachesAgentLimit,
  checkLimits,
  expiresAtFor,
  feeFor,
  isNearLimit,
  offerRefusal,
  totalFor,
  type CashRules,
  type OfferRow,
} from "./blink-cash-rules";

const RULES: CashRules = {
  deposit_fee_rate: 0.02,
  withdrawal_fee_rate: 0.03,
  min_amount: 1000,
  max_amount: 100000,
  daily_deposit_limit: 200000,
  daily_withdrawal_limit: 100000,
  monthly_deposit_limit: 1000000,
  monthly_withdrawal_limit: 500000,
  pending_expiry_minutes: 15,
};

describe("fees", () => {
  it("applies the rate of the operation, in whole dinars", () => {
    assert.equal(feeFor("deposit", 5000, RULES), 100);
    assert.equal(feeFor("withdrawal", 5000, RULES), 150);
    assert.equal(feeFor("deposit", 1250, RULES), 25);
    assert.equal(feeFor("deposit", 1275, RULES), 26); // 25.5 rounds up
    assert.equal(feeFor("deposit", 5000, { ...RULES, deposit_fee_rate: 0 }), 0);
  });

  it("adds the fee on a deposit and takes it off a withdrawal", () => {
    assert.equal(totalFor("deposit", 5000, 100), 5100);
    assert.equal(totalFor("withdrawal", 5000, 150), 4850);
  });
});

describe("checkLimits", () => {
  it("accepts an amount inside every limit", () => {
    assert.equal(checkLimits("deposit", 5000, RULES, 0, 0), null);
  });

  it("refuses under the minimum and over the maximum, with the limit", () => {
    assert.deepEqual(checkLimits("deposit", 999, RULES, 0, 0), { code: "limit_min", limit: 1000, used: 0 });
    assert.deepEqual(checkLimits("deposit", 100001, RULES, 0, 0), { code: "limit_max", limit: 100000, used: 0 });
    assert.equal(checkLimits("deposit", 1000, RULES, 0, 0), null);
    assert.equal(checkLimits("deposit", 100000, RULES, 0, 0), null);
  });

  it("refuses past the daily limit and reports what was used", () => {
    assert.deepEqual(checkLimits("deposit", 50000, RULES, 160000, 160000), {
      code: "limit_daily",
      limit: 200000,
      used: 160000,
    });
    assert.equal(checkLimits("deposit", 40000, RULES, 160000, 160000), null); // exactly at the limit
  });

  it("refuses past the monthly limit once the day is fine", () => {
    assert.deepEqual(checkLimits("deposit", 50000, RULES, 0, 980000), {
      code: "limit_monthly",
      limit: 1000000,
      used: 980000,
    });
  });

  it("uses the withdrawal limits for withdrawals", () => {
    assert.deepEqual(checkLimits("withdrawal", 50000, RULES, 60000, 0), {
      code: "limit_daily",
      limit: 100000,
      used: 60000,
    });
    assert.deepEqual(checkLimits("withdrawal", 50000, RULES, 0, 480000), {
      code: "limit_monthly",
      limit: 500000,
      used: 480000,
    });
  });

  it("reports the daily limit before the monthly one", () => {
    assert.equal(checkLimits("deposit", 50000, RULES, 190000, 990000)?.code, "limit_daily");
  });
});

describe("Algiers windows and expiry", () => {
  it("starts the day at the Algiers midnight (UTC+1)", () => {
    // 2026-10-15 23:30 UTC is already 2026-10-16 00:30 in Algiers.
    assert.equal(algiersDayStartIso(new Date("2026-10-15T23:30:00Z")), "2026-10-15T23:00:00.000Z");
    assert.equal(algiersDayStartIso(new Date("2026-10-16T12:00:00Z")), "2026-10-15T23:00:00.000Z");
    assert.equal(algiersDayStartIso(new Date("2026-10-16T22:59:00Z")), "2026-10-15T23:00:00.000Z");
  });

  it("starts the month at the Algiers midnight of the 1st", () => {
    assert.equal(algiersMonthStartIso(new Date("2026-10-16T12:00:00Z")), "2026-09-30T23:00:00.000Z");
    // 30 Sep 23:30 UTC is already 1 Oct in Algiers.
    assert.equal(algiersMonthStartIso(new Date("2026-09-30T23:30:00Z")), "2026-09-30T23:00:00.000Z");
  });

  it("expires a request after the configured minutes", () => {
    assert.equal(expiresAtFor(15, new Date("2026-10-16T12:00:00Z")), "2026-10-16T12:15:00.000Z");
  });
});

const OFFER: OfferRow = {
  id: "o1",
  min_deposit: 5000,
  bonus_type: "percent",
  bonus_value: 10,
  max_bonus: 500,
  starts_at: "2026-10-01T00:00:00Z",
  ends_at: "2026-11-01T00:00:00Z",
  active: true,
  per_user_limit: 1,
  budget: 10000,
  used_amount: 0,
};
const NOW = new Date("2026-10-16T12:00:00Z");

describe("bonusFor", () => {
  it("pays a fixed bonus as is", () => {
    assert.equal(bonusFor({ bonus_type: "fixed", bonus_value: 200, max_bonus: null }, 10000), 200);
  });

  it("pays a percentage, capped by max_bonus", () => {
    assert.equal(bonusFor(OFFER, 3000), 300);
    assert.equal(bonusFor(OFFER, 5000), 500);
    assert.equal(bonusFor(OFFER, 20000), 500); // 2000 capped
    assert.equal(bonusFor({ ...OFFER, max_bonus: null }, 20000), 2000);
  });

  it("caps a fixed bonus too and rounds percentages to centimes", () => {
    assert.equal(bonusFor({ bonus_type: "fixed", bonus_value: 800, max_bonus: 500 }, 9000), 500);
    assert.equal(bonusFor({ bonus_type: "percent", bonus_value: 2.5, max_bonus: null }, 1234), 30.85);
  });
});

describe("offerRefusal", () => {
  it("accepts a live offer the rider has not used", () => {
    assert.equal(offerRefusal(OFFER, 6000, 0, NOW), null);
  });

  it("refuses an archived offer", () => {
    assert.equal(offerRefusal({ ...OFFER, active: false }, 6000, 0, NOW), "offer_inactive");
  });

  it("refuses before the start and after the end", () => {
    assert.equal(offerRefusal({ ...OFFER, starts_at: "2026-10-20T00:00:00Z" }, 6000, 0, NOW), "offer_not_started");
    assert.equal(offerRefusal({ ...OFFER, ends_at: "2026-10-16T12:00:00Z" }, 6000, 0, NOW), "offer_ended");
  });

  it("refuses a deposit under the minimum", () => {
    assert.equal(offerRefusal(OFFER, 4999, 0, NOW), "offer_min_deposit");
  });

  it("refuses once the per-user limit is reached, but not when it has none", () => {
    assert.equal(offerRefusal(OFFER, 6000, 1, NOW), "offer_limit_reached");
    assert.equal(offerRefusal({ ...OFFER, per_user_limit: null }, 6000, 50, NOW), null);
  });

  it("refuses when this bonus would break the budget", () => {
    assert.equal(offerRefusal({ ...OFFER, used_amount: 9600 }, 6000, 0, NOW), "offer_budget_exhausted"); // 600 > 400 left
    assert.equal(offerRefusal({ ...OFFER, used_amount: 9400 }, 6000, 0, NOW), null); // exactly 600 left
    assert.equal(offerRefusal({ ...OFFER, budget: null, used_amount: 99999 }, 6000, 0, NOW), null);
  });
});

describe("agent cash limit", () => {
  it("falls back to the default when the agent has none", () => {
    assert.equal(agentLimit(null, 200000), 200000);
    assert.equal(agentLimit(undefined, 200000), 200000);
    assert.equal(agentLimit(50000, 200000), 50000);
    assert.equal(agentLimit(0, 200000), 0); // an explicit 0 blocks deposits
  });

  it("reports the room left, never negative", () => {
    assert.equal(agentCapacity(150000, 200000), 50000);
    assert.equal(agentCapacity(250000, 200000), 0);
  });

  it("refuses a deposit that would pass the limit, never a withdrawal", () => {
    assert.equal(breachesAgentLimit("deposit", 150000, 50000, 200000), false); // exactly at the limit
    assert.equal(breachesAgentLimit("deposit", 150000, 50001, 200000), true);
    assert.equal(breachesAgentLimit("withdrawal", 250000, 50000, 200000), false);
  });

  it("warns from 80 % of the limit", () => {
    assert.equal(isNearLimit(159999, 200000), false);
    assert.equal(isNearLimit(160000, 200000), true);
    assert.equal(isNearLimit(10, 0), false);
  });
});
