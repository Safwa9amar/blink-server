import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceStoreOrder, type CustomerPack } from "./pack-pricing";
import { priceProductLines, productStockUsage, type OrderableProduct } from "./product-pricing";

const products: OrderableProduct[] = [
  { id: "p-bread", title: "Bread", price: 25 },
  { id: "p-milk", title: "Milk", price: "110.50" },
];

describe("priceProductLines", () => {
  it("uses the live price and product title for a line with product_id", () => {
    const r = priceProductLines([{ product_id: "p-bread", name: "old name", quantity: 2, unit_price: 25 }], products);
    assert.ok(r.ok);
    assert.deepEqual(r.lines, [{ product_id: "p-bread", name: "Bread", quantity: 2, unit_price: 25 }]);
  });

  it("409s a moved price with the current state, listing only offending lines", () => {
    const r = priceProductLines(
      [
        { product_id: "p-bread", name: "Bread", quantity: 1, unit_price: 25 },
        { product_id: "p-milk", name: "Milk", quantity: 1, unit_price: 1 },
      ],
      products
    );
    assert.deepEqual(r, {
      ok: false,
      reason: "changed",
      products: [{ product_id: "p-milk", name: "Milk", price: 110.5, available: true }],
    });
  });

  it("409s a product that is gone or unavailable with price null", () => {
    const r = priceProductLines([{ product_id: "p-gone", name: "Cheese", quantity: 1, unit_price: 50 }], products);
    assert.deepEqual(r, {
      ok: false,
      reason: "changed",
      products: [{ product_id: "p-gone", name: "Cheese", price: null, available: false }],
    });
  });

  it("charges a legacy line (no product_id) the live price by title and stores the id", () => {
    const r = priceProductLines([{ name: "Milk", quantity: 2, unit_price: 1 }], products);
    assert.ok(r.ok);
    assert.deepEqual(r.lines, [{ product_id: "p-milk", name: "Milk", quantity: 2, unit_price: 110.5 }]);
  });

  it("errors on a legacy line matching no product", () => {
    const r = priceProductLines([{ name: "Unknown", quantity: 1, unit_price: 10 }], products);
    assert.deepEqual(r, { ok: false, reason: "unavailable", name: "Unknown" });
  });

  it("leaves pack lines untouched", () => {
    const line = { name: "Pack", quantity: 1, unit_price: 99, pack_id: "pk" };
    const r = priceProductLines([line], products);
    assert.ok(r.ok);
    assert.deepEqual(r.lines, [line]);
  });
});

describe("product + pack subtotal", () => {
  const pack = {
    id: "pk",
    name: "Salad pack",
    price: 200,
    free_delivery: false,
    items: [],
  } as unknown as CustomerPack;

  it("sums server prices and ignores client-sent unit prices on legacy lines", () => {
    const priced = priceProductLines(
      [
        { name: "Bread", quantity: 2, unit_price: 1 },
        { product_id: "p-milk", name: "x", quantity: 1, unit_price: 110.5 },
        { name: "Salad pack", quantity: 1, unit_price: 200, pack_id: "pk" },
      ],
      products
    );
    assert.ok(priced.ok);
    const r = priceStoreOrder(priced.lines, [pack], 150);
    assert.ok(r.ok);
    assert.equal(r.subtotal, 360.5);
    assert.equal(r.delivery_fee, 150);
    assert.deepEqual(r.items[0], { name: "Bread", quantity: 2, unit_price: 25, product_id: "p-bread" });
  });

  it("has no client money field to trust: subtotal comes from the lines only", () => {
    const priced = priceProductLines([{ name: "Bread", quantity: 1, unit_price: 0 }], products);
    assert.ok(priced.ok);
    const r = priceStoreOrder(priced.lines, [], 100);
    assert.ok(r.ok);
    assert.equal(r.subtotal, 25);
  });
});

describe("productStockUsage", () => {
  it("sums product lines by id and skips pack lines", () => {
    const usage = productStockUsage([
      { product_id: "a", quantity: 2 },
      { product_id: "a", quantity: 1 },
      { quantity: 5 },
      { pack_id: "pk", quantity: 1 },
    ]);
    assert.deepEqual([...usage], [["a", 3]]);
  });
});
