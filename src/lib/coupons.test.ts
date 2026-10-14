import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentCoupon, promotionAvailability } from "./coupons";

const NOW = new Date("2026-10-14T12:00:00Z");
const base = { is_active: true, archived_at: null, starts_at: null, ends_at: null, max_coupons: null, discount_budget: null };
const none = { issued: 0, discount_given: 0 };
const avail = (p: object, usage = none) => promotionAvailability({ ...base, ...p }, usage, NOW);

describe("promotionAvailability", () => {
  it("is live by default", () => assert.equal(avail({}), "live"));
  it("archived", () => assert.equal(avail({ archived_at: "2026-10-01T00:00:00Z" }), "archived"));
  it("paused", () => assert.equal(avail({ is_active: false }), "paused"));
  it("scheduled", () => assert.equal(avail({ starts_at: "2026-10-15T00:00:00Z" }), "scheduled"));
  it("ended", () => assert.equal(avail({ ends_at: "2026-10-13T00:00:00Z" }), "ended"));
  it("started and not yet ended is live", () =>
    assert.equal(avail({ starts_at: "2026-10-14T00:00:00Z", ends_at: "2026-10-15T00:00:00Z" }), "live"));
  it("sold out at the cap", () => {
    assert.equal(avail({ max_coupons: 10 }, { issued: 9, discount_given: 0 }), "live");
    assert.equal(avail({ max_coupons: 10 }, { issued: 10, discount_given: 0 }), "sold_out");
    assert.equal(avail({ max_coupons: 10 }, { issued: 11, discount_given: 0 }), "sold_out");
  });
  it("budget spent at the budget", () => {
    assert.equal(avail({ discount_budget: 1000 }, { issued: 0, discount_given: 999.99 }), "live");
    assert.equal(avail({ discount_budget: 1000 }, { issued: 0, discount_given: 1000 }), "budget_spent");
  });
  it("null caps are unlimited", () =>
    assert.equal(avail({}, { issued: 1_000_000, discount_given: 1e9 }), "live"));
  it("precedence: archived > paused > scheduled > ended > sold_out > budget_spent", () => {
    const spent = { issued: 5, discount_given: 500 };
    const all = {
      archived_at: "2026-10-01T00:00:00Z",
      is_active: false,
      starts_at: "2026-10-15T00:00:00Z",
      ends_at: "2026-10-13T00:00:00Z",
      max_coupons: 5,
      discount_budget: 500,
    };
    assert.equal(avail(all, spent), "archived");
    assert.equal(avail({ ...all, archived_at: null }, spent), "paused");
    assert.equal(avail({ ...all, archived_at: null, is_active: true }, spent), "scheduled");
    assert.equal(avail({ ...all, archived_at: null, is_active: true, starts_at: null }, spent), "ended");
    assert.equal(avail({ ...all, archived_at: null, is_active: true, starts_at: null, ends_at: null }, spent), "sold_out");
    assert.equal(
      avail({ ...all, archived_at: null, is_active: true, starts_at: null, ends_at: null, max_coupons: null }, spent),
      "budget_spent"
    );
  });
});

describe("presentCoupon status", () => {
  const row = { discount_type: "fixed", discount_value: 500 };
  const past = "2020-01-01T00:00:00Z";
  it("revoked wins over used and expired", () =>
    assert.equal(presentCoupon({ ...row, revoked_at: past, used_at: past, expires_at: past }).status, "revoked"));
  it("used wins over expired", () =>
    assert.equal(presentCoupon({ ...row, used_at: past, expires_at: past }).status, "used"));
  it("expired", () => assert.equal(presentCoupon({ ...row, expires_at: past }).status, "expired"));
  it("active", () => assert.equal(presentCoupon({ ...row }).status, "active"));
});
