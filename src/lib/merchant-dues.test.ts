import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateDues, BLINK_CASH_HREF, DUES_REMINDER_COOLDOWN_MS, duesReminderCopy, remindedRecently } from "./merchant-dues";

import { PRICING_SEEDS } from "./pricing/catalog";

const RATES = PRICING_SEEDS.dues_payment_fee_rate.rate;
const COMMISSION = PRICING_SEEDS.merchant_commission_rate.rate;
const owed = (sales: number) => ({ sales, commission: sales * COMMISSION });
const stores = [
  { id: "s1", name: "Hydra" },
  { id: "s2", name: "Kouba" },
];
const sales = new Map([
  ["s1", owed(10_000)], // owes 500
  ["s2", owed(4_000)], // owes 200
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

describe("allocateDues with per-order rates", () => {
  it("owes the sum of each order's own commission, not one rate on the total", () => {
    // 6000 placed at 5% (300) + 4000 placed at 3% (120) = 420, not 10000 x current rate
    const mixed = new Map([["s1", { sales: 10_000, commission: 6_000 * 0.05 + 4_000 * 0.03 }]]);
    const [a] = allocateDues([stores[0]], mixed, [], RATES);
    assert.equal(a.total_profit, 10_000);
    assert.equal(a.commission, 420);
    assert.equal(a.dues_payable, 420);
    assert.equal(a.fees, 0.84);
  });

  it("uses the configured payment fee rate", () => {
    const [a] = allocateDues([stores[0]], sales, [], 0.01);
    assert.equal(a.fees, 5);
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

describe("feeFromSales", () => {
  it("a single rate equals round2(Σsale × rate), the pre-pricing-config maths", async () => {
    const { addSale, feeFromSales } = await import("./merchant-dues");
    const sales = [3052.97, 2111.61, 2600.82, 259.84, 4220.86];
    const by = new Map<number, number>();
    for (const s of sales) addSale(by, 0.05, s);
    const old = Math.round(sales.reduce((a, b) => a + b, 0) * 0.05 * 100) / 100;
    assert.equal(feeFromSales(by), old);
    assert.equal(feeFromSales(by), 612.3);
  });
  it("sums per distinct rate", async () => {
    const { addSale, feeFromSales } = await import("./merchant-dues");
    const by = new Map<number, number>();
    addSale(by, 0.05, 1000);
    addSale(by, 0.03, 1000);
    assert.equal(feeFromSales(by), 80);
  });
});
