import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestBranchMove,
  parseCartItems,
  type BranchProduct,
  type BranchStore,
  type CartLine,
} from "./branch-suggestion";

const store = (id: string, over: Partial<BranchStore> = {}): BranchStore => ({
  id,
  name: `Store ${id}`,
  owner_id: "dev",
  delivery_fee: 150,
  open: true,
  ...over,
});
const line = (over: Partial<CartLine>): CartLine => ({
  product_id: "p",
  store_id: "bab",
  quantity: 1,
  price: 100,
  library_product_id: null,
  barcode: "",
  ...over,
});
const product = (over: Partial<BranchProduct>): BranchProduct => ({
  id: "x",
  store_id: "hydra",
  title: "Milk 1L",
  price: 100,
  image: "",
  library_product_id: null,
  barcode: "",
  ...over,
});
const stores = (...s: BranchStore[]) => new Map(s.map((x) => [x.id, x]));

describe("parseCartItems", () => {
  const a = "11111111-1111-1111-1111-111111111111";
  const b = "22222222-2222-2222-2222-222222222222";

  it("reads product_id:quantity pairs and drops malformed ones", () => {
    assert.deepEqual(parseCartItems(`${a}:2,${b}:1,bad,${a}:0, ${b}:x`), [
      { product_id: a, quantity: 2 },
      { product_id: b, quantity: 1 },
    ]);
  });

  it("caps at 60 lines", () => {
    assert.equal(parseCartItems(Array(80).fill(`${a}:1`).join(",")).length, 60);
  });
});

describe("bestBranchMove", () => {
  const twoStores = stores(store("bab"), store("hydra"));
  // Bab Ezzouar: milk (library L1). Hydra: bread (its own product, already in Hydra).
  const lines = [
    line({ product_id: "bab-milk", store_id: "bab", quantity: 2, price: 120, library_product_id: "L1" }),
    line({ product_id: "hydra-bread", store_id: "hydra", quantity: 1, price: 30 }),
  ];

  it("moves a branch's items into another branch of the same owner (library id)", () => {
    const products = [product({ id: "hydra-milk", price: 120, library_product_id: "L1" })];
    const s = bestBranchMove(lines, twoStores, products);
    assert.ok(s);
    assert.equal(s.to_store.id, "hydra");
    assert.deepEqual(s.from_store_ids, ["bab"]);
    assert.deepEqual(
      s.swaps.map((w) => [w.from_product_id, w.to_product.id]),
      [["bab-milk", "hydra-milk"]]
    );
    assert.equal(s.saving, 150); // one delivery fee saved, same prices
  });

  it("falls back to a non-empty barcode", () => {
    const withBarcode = [
      line({ product_id: "bab-milk", store_id: "bab", quantity: 2, price: 120, barcode: "613" }),
      lines[1],
    ];
    const products = [product({ id: "hydra-milk", price: 120, barcode: "613" })];
    assert.equal(bestBranchMove(withBarcode, twoStores, products)?.to_store.id, "hydra");
  });

  it("never matches on an empty barcode", () => {
    const products = [product({ id: "hydra-milk", price: 120, barcode: "" })];
    const noIds = [line({ product_id: "bab-milk", store_id: "bab", price: 120 }), lines[1]];
    // Moving hydra → bab needs the bread in bab, which isn't there either.
    assert.equal(bestBranchMove(noIds, twoStores, products), null);
  });

  it("is null when the switch would cost more", () => {
    // Hydra sells the milk 100 DZD dearer per unit ×2 = +200 > 150 fee saved.
    const products = [product({ id: "hydra-milk", price: 220, library_product_id: "L1" })];
    assert.equal(bestBranchMove(lines, twoStores, products), null);
  });

  it("suggests at the same total (saving 0)", () => {
    const products = [product({ id: "hydra-milk", price: 195, library_product_id: "L1" })];
    assert.equal(bestBranchMove(lines, twoStores, products)?.saving, 0);
  });

  it("skips a closed target", () => {
    const products = [product({ id: "hydra-milk", price: 120, library_product_id: "L1" })];
    const closed = stores(store("bab"), store("hydra", { open: false }));
    assert.equal(bestBranchMove(lines, closed, products), null);
  });

  it("never mixes owners", () => {
    const products = [product({ id: "hydra-milk", price: 120, library_product_id: "L1" })];
    const mixed = stores(store("bab"), store("hydra", { owner_id: "someone" }));
    assert.equal(bestBranchMove(lines, mixed, products), null);
  });

  it("ignores an owner with one store in the cart", () => {
    assert.equal(bestBranchMove([lines[0]], twoStores, []), null);
  });

  it("picks the biggest saving, then the target already holding more lines", () => {
    // Both directions match at equal prices; hydra already has 2 lines, bab 1.
    const l = [
      line({ product_id: "bab-milk", store_id: "bab", price: 100, library_product_id: "L1" }),
      line({ product_id: "hydra-bread", store_id: "hydra", price: 30, library_product_id: "L2" }),
      line({ product_id: "hydra-eggs", store_id: "hydra", price: 50, library_product_id: "L3" }),
    ];
    const products = [
      product({ id: "hydra-milk", store_id: "hydra", price: 100, library_product_id: "L1" }),
      product({ id: "bab-bread", store_id: "bab", price: 30, library_product_id: "L2" }),
      product({ id: "bab-eggs", store_id: "bab", price: 50, library_product_id: "L3" }),
    ];
    assert.equal(bestBranchMove(l, twoStores, products)?.to_store.id, "hydra");
  });
});
