import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateDues, BLINK_CASH_HREF, DUES_REMINDER_COOLDOWN_MS, duesReminderCopy, remindedRecently } from "./merchant-dues";

const RATES = { commission: 0.05, fee: 0.002 };
const stores = [
  { id: "s1", name: "Hydra" },
  { id: "s2", name: "Kouba" },
];
const sales = new Map([
  ["s1", 10_000], // owes 500
  ["s2", 4_000], // owes 200
]);

describe("allocateDues", () => {
  it("charges the commission on delivered sales", () => {
    const [a, b] = allocateDues(stores, sales, [], RATES);
    assert.deepEqual(a, {
      store_id: "s1",
      store_name: "Hydra",
      total_profit: 10_000,
      commission: 500,
      paid: 0,
      dues_payable: 500,
      fees: 1,
      last_payment_at: null,
    });
    assert.equal(b.dues_payable, 200);
  });

  it("takes a store's own payments off that store", () => {
    const [a, b] = allocateDues(stores, sales, [{ store_id: "s2", amount: "150", created_at: "2026-10-01T00:00:00Z" }], RATES);
    assert.equal(a.dues_payable, 500);
    assert.equal(b.dues_payable, 50);
    assert.equal(b.paid, 150);
    assert.equal(b.last_payment_at, "2026-10-01T00:00:00Z");
  });

  it("spreads an all-stores payment in store order", () => {
    const [a, b] = allocateDues(stores, sales, [{ store_id: null, amount: 600, created_at: "2026-10-02T00:00:00Z" }], RATES);
    assert.equal(a.dues_payable, 0);
    assert.equal(a.paid, 500);
    assert.equal(b.dues_payable, 100);
    assert.equal(b.paid, 100);
    assert.equal(b.last_payment_at, "2026-10-02T00:00:00Z");
  });

  it("never goes negative on overpayment, and counts a payment to an unknown store as all-stores", () => {
    const [a, b] = allocateDues(
      stores,
      sales,
      [
        { store_id: "s1", amount: 900 },
        { store_id: "gone", amount: 50 },
      ],
      RATES
    );
    assert.equal(a.dues_payable, 0);
    assert.equal(b.dues_payable, 150);
    assert.equal(b.paid, 50);
  });

  it("keeps the latest payment date", () => {
    const [a] = allocateDues(
      stores,
      sales,
      [
        { store_id: "s1", amount: 10, created_at: "2026-10-03T00:00:00Z" },
        { store_id: "s1", amount: 10, created_at: "2026-09-01T00:00:00Z" },
      ],
      RATES
    );
    assert.equal(a.last_payment_at, "2026-10-03T00:00:00Z");
  });

  it("handles a store with no sales", () => {
    const [c] = allocateDues([{ id: "s3", name: "New" }], sales, [], RATES);
    assert.equal(c.total_profit, 0);
    assert.equal(c.dues_payable, 0);
  });
});

describe("duesReminderCopy", () => {
  it("states the amount and the store in every language", () => {
    const copy = duesReminderCopy(1234.5, "Superette Hydra");
    for (const lang of ["en", "fr", "ar"] as const) {
      assert.ok(copy[lang].title.trim());
      assert.ok(copy[lang].description.includes("1234.5"), lang);
      assert.ok(copy[lang].description.includes("Superette Hydra"), lang);
    }
    assert.match(copy.en.description, /You have 1234\.5 Da in outstanding dues/);
  });

  it("opens Blink Cash", () => {
    assert.equal(BLINK_CASH_HREF, "/(merchant)/blink-cash");
  });
});

describe("remindedRecently", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  it("blocks a second reminder within 24 h", () => {
    assert.equal(remindedRecently("2026-10-10T11:59:00Z", now), true);
    assert.equal(remindedRecently("2026-10-09T12:00:01+00:00", now), true);
  });
  it("allows one after 24 h, or when there was none", () => {
    assert.equal(remindedRecently("2026-10-09T12:00:00Z", now), false);
    assert.equal(remindedRecently(null, now), false);
    assert.equal(remindedRecently(undefined, now), false);
    assert.equal(remindedRecently("garbage", now), false);
  });
  it("uses a one-day cooldown", () => {
    assert.equal(DUES_REMINDER_COOLDOWN_MS, 86_400_000);
  });
});
