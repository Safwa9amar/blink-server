import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPackSuggestions, type SuggestionOrder, type SuggestionProduct } from "./pack-suggestions";

const product = (id: string, title: string, price: number, category = "", over: Partial<SuggestionProduct> = {}) => ({
  id,
  title,
  price,
  image: `${id}.jpg`,
  photos: [],
  category,
  is_available: true,
  review_status: "approved",
  ...over,
});

const CATALOG: SuggestionProduct[] = [
  product("milk", "Lait Candia 1L", 120, "Dairy"),
  product("yog", "Yaourt Soummam", 40, "Dairy"),
  product("bread", "Pain", 15, "Bakery"),
  product("cof", "Café Bonal", 350, "Drinks"),
  product("oil", "Huile Elio 1L", 300, "Grocery"),
  product("hidden", "Pending item", 99, "Dairy", { review_status: "pending" }),
  product("off", "Out of stock", 99, "Dairy", { is_available: false }),
];

const order = (...lines: [string, number][]): SuggestionOrder => ({
  items: lines.map(([name, quantity]) => ({ name, quantity, unit_price: 0 })),
});

const ORDERS: SuggestionOrder[] = [
  order(["Lait Candia 1L", 2], ["Pain", 4]),
  order(["Lait Candia 1L", 1], ["Pain", 2], ["Yaourt Soummam", 6]),
  order(["lait candia 1l ", 1], ["Café Bonal", 1]),
  order(["Yaourt Soummam", 4]),
  // Pack lines and unknown products are ignored.
  { items: [{ name: "Breakfast pack", quantity: 1, pack_id: "k1" }, { name: "Mystery", quantity: 9 }] },
];

describe("buildPackSuggestions — from orders", () => {
  const ideas = buildPackSuggestions(CATALOG, ORDERS);

  it("pairs products bought together at least twice", () => {
    const together = ideas.filter((i) => i.kind === "bought_together");
    assert.equal(together.length, 1);
    assert.deepEqual(together[0].product_ids, ["bread", "milk"]);
    assert.equal(together[0].params.orders_count, 2);
    assert.equal(together[0].discount_percent, 10);
    assert.equal(together[0].original_price, 135);
    assert.equal(together[0].price, 121); // 135 − round(13.5)
  });

  it("bundles the top sellers by units", () => {
    const top = ideas.find((i) => i.kind === "top_sellers")!;
    // yog 10 units, bread 6, milk 4.
    assert.deepEqual(
      top.items.map((i) => i.product_id),
      ["yog", "bread", "milk"]
    );
    assert.equal(top.params.orders_count, 4);
  });

  it("offers buy 2 get 1 on the best-selling category", () => {
    const multi = ideas.find((i) => i.kind === "category_multibuy")!;
    assert.equal(multi.params.category, "Dairy");
    assert.deepEqual(
      multi.items.map((i) => [i.product_id, i.quantity, i.qty_promo_enabled, i.buy_qty, i.get_qty]),
      [
        ["yog", 2, true, 2, 1],
        ["milk", 2, true, 2, 1],
      ]
    );
    assert.equal(multi.discount_percent, 0);
    assert.equal(multi.price, multi.original_price);
  });

  it("only uses approved, available products and no starters", () => {
    const ids = ideas.flatMap((i) => i.product_ids);
    assert.ok(!ids.includes("hidden") && !ids.includes("off"));
    assert.ok(!ideas.some((i) => i.kind === "starter"));
  });

  it("gives every idea a stable id", () => {
    const again = buildPackSuggestions(CATALOG, ORDERS);
    assert.deepEqual(
      again.map((i) => i.id),
      ideas.map((i) => i.id)
    );
    assert.equal(new Set(ideas.map((i) => i.id)).size, ideas.length);
    for (const i of ideas) assert.match(i.id, new RegExp(`^${i.kind}-[0-9a-f]{12}$`));
  });

  it("returns item details the app can show and create a pack from", () => {
    const item = ideas[0].items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      "buy_qty",
      "get_qty",
      "image",
      "name",
      "product_id",
      "qty_promo_enabled",
      "quantity",
      "unit_price",
    ]);
  });
});

describe("buildPackSuggestions — dedup and limits", () => {
  it("skips an idea the store already has as a live pack, but not an archived one", () => {
    const withPack = buildPackSuggestions(CATALOG, ORDERS, [
      { status: "active", items: [{ product_id: "milk" }, { product_id: "bread" }] },
    ]);
    assert.ok(!withPack.some((i) => i.kind === "bought_together"));
    const archived = buildPackSuggestions(CATALOG, ORDERS, [
      { status: "archived", items: [{ product_id: "milk" }, { product_id: "bread" }] },
    ]);
    assert.ok(archived.some((i) => i.kind === "bought_together"));
  });

  it("caps the number of ideas", () => {
    assert.equal(buildPackSuggestions(CATALOG, ORDERS, [], 2).length, 2);
    assert.ok(buildPackSuggestions(CATALOG, ORDERS).length <= 6);
  });
});

describe("buildPackSuggestions — starters", () => {
  it("falls back to catalog picks when there are no orders, spreading categories", () => {
    const ideas = buildPackSuggestions(CATALOG, []);
    assert.ok(ideas.length >= 1);
    assert.ok(ideas.every((i) => i.kind === "starter"));
    const first = ideas[0];
    assert.equal(first.items.length, 3);
    const cats = first.items.map((i) => CATALOG.find((p) => p.id === i.product_id)!.category);
    assert.equal(new Set(cats).size, 3);
    assert.equal(first.discount_percent, 10);
  });

  it("offers buy 2 get 1 when the store has a single product", () => {
    const [idea] = buildPackSuggestions([product("milk", "Lait", 120)], []);
    assert.equal(idea.kind, "starter");
    assert.equal(idea.items[0].qty_promo_enabled, true);
    assert.equal(idea.items[0].quantity, 2);
  });

  it("suggests nothing for an empty catalog", () => {
    assert.deepEqual(buildPackSuggestions([], ORDERS), []);
  });
});
