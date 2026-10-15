import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { algiersDate, bucketDaily, windowDates, windowStartIso } from "./blink-cash-summary";

// 2026-10-15 12:00 UTC = 13:00 in Algiers.
const NOW = new Date("2026-10-15T12:00:00Z");

describe("blink-cash summary bucketing", () => {
  it("uses the Algiers calendar date (UTC+1)", () => {
    assert.equal(algiersDate("2026-10-14T23:30:00Z"), "2026-10-15");
    assert.equal(algiersDate("2026-10-14T22:59:59Z"), "2026-10-14");
  });

  it("lists every day of the window, oldest first, ending today", () => {
    assert.deepEqual(windowDates(3, NOW), ["2026-10-13", "2026-10-14", "2026-10-15"]);
    assert.equal(windowDates(30, NOW).length, 30);
    assert.equal(windowStartIso(3, NOW), "2026-10-12T23:00:00.000Z");
  });

  it("rolls 'today' over at Algiers midnight, not UTC", () => {
    const late = new Date("2026-10-15T23:30:00Z"); // 00:30 on the 16th in Algiers
    assert.equal(windowDates(1, late)[0], "2026-10-16");
  });

  it("buckets completed ops and keeps empty days as zeros", () => {
    const out = bucketDaily(
      [
        { type: "deposit", amount: "1000", created_at: "2026-10-15T08:00:00Z" },
        { type: "deposit", amount: 500, created_at: "2026-10-14T23:30:00Z" }, // 15th in Algiers
        { type: "withdrawal", amount: 200, created_at: "2026-10-13T10:00:00Z" },
        { type: "withdrawal", amount: 50, created_at: "2026-10-01T10:00:00Z" }, // outside
      ],
      3,
      NOW
    );
    assert.deepEqual(out, [
      { date: "2026-10-13", deposits: 0, withdrawals: 200, deposits_count: 0, withdrawals_count: 1 },
      { date: "2026-10-14", deposits: 0, withdrawals: 0, deposits_count: 0, withdrawals_count: 0 },
      { date: "2026-10-15", deposits: 1500, withdrawals: 0, deposits_count: 2, withdrawals_count: 0 },
    ]);
  });
});
