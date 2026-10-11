import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effectiveDiscountPercent,
  freeUnits,
  packStockUsage,
  pricePack,
  pricePacks,
  priceStoreOrder,
  samePrice,
  storeOrderDeliveryFee,
  type PackProductLike,
  type PackRowLike,
} from "./pack-pricing";

const STORE = "11111111-1111-4111-8111-111111111111";

const products: PackProductLike[] = [
  { id: "p-tomato", title: "Tomatoes", price: 120, image: "tomato.jpg", unit: "1 kg" },
  { id: "p-carrot", title: "Carrots", price: "80.50", image: "", photos: ["carrot.jpg"], unit: null },
  { id: "p-onion", title: "Onions", price: 33.33, image: null, unit: "500 g" },
];
const byId = new Map(products.map((p) => [p.id, p]));

function pack(over: Partial<PackRowLike> = {}): PackRowLike {
  return {
    id: "pack-1",
    store_id: STORE,
    name: "Salad pack",
    description: null,
    image: null,
    items: [
      { product_id: "p-tomato", quantity: 2, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 },
      { product_id: "p-carrot", quantity: 1, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 },
    ],
    discount_enabled: false,
    discount_percent: 0,
    free_delivery: false,
    created_at: "2026-10-01T10:00:00Z",
    ...over,
  };
}

describe("pricePack — discount", () => {
  it("charges the full original price when the discount is off", () => {
    const p = pricePack(pack({ discount_enabled: false, discount_percent: 20 }), byId)!;
    assert.equal(p.original_price, 320.5); // 120×2 + 80.50
    assert.equal(p.savings, 0);
    assert.equal(p.price, 320.5);
    assert.equal(p.discount_percent, 0);
  });

  it("treats an enabled 0% discount as off", () => {
    const p = pricePack(pack({ discount_enabled: true, discount_percent: 0 }), byId)!;
    assert.equal(p.savings, 0);
    assert.equal(p.price, p.original_price);
    assert.equal(p.discount_percent, 0);
  });

  it("takes the % off the original price when on", () => {
    const p = pricePack(pack({ discount_enabled: true, discount_percent: 10 }), byId)!;
    assert.equal(p.discount_percent, 10);
    // 320.5 × 10% = 32.05 → rounded to 32
    assert.equal(p.savings, 32);
    assert.equal(p.price, 288.5);
  });

  it("rounds the discount to the nearest whole amount", () => {
    // 3 × 33.33 = 99.99 → 15% = 14.9985 → 15
    const p = pricePack(
      pack({
        discount_enabled: true,
        discount_percent: 15,
        items: [{ product_id: "p-onion", quantity: 3, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 }],
      }),
      byId
    )!;
    assert.equal(p.original_price, 99.99);
    assert.equal(p.savings, 15);
    assert.equal(p.price, 84.99);
  });

  it("effectiveDiscountPercent reads the toggle", () => {
    assert.equal(effectiveDiscountPercent({ discount_enabled: true, discount_percent: 25 }), 25);
    assert.equal(effectiveDiscountPercent({ discount_enabled: false, discount_percent: 25 }), 0);
  });
});

describe("freeUnits — buy X get Y", () => {
  const promo = (quantity: number, over: object = {}) => ({
    product_id: "p-tomato",
    quantity,
    qty_promo_enabled: true,
    buy_qty: 2,
    get_qty: 1,
    ...over,
  });

  it("gives get_qty per full buy_qty", () => {
    assert.equal(freeUnits(promo(2)), 1);
    assert.equal(freeUnits(promo(3)), 1);
    assert.equal(freeUnits(promo(5)), 2);
  });

  it("gives nothing when the promo is off", () => {
    assert.equal(freeUnits(promo(5, { qty_promo_enabled: false })), 0);
  });

  it("gives nothing with buy_qty 0 (or get_qty 0)", () => {
    assert.equal(freeUnits(promo(5, { buy_qty: 0 })), 0);
    assert.equal(freeUnits(promo(5, { get_qty: 0 })), 0);
  });

  it("free units are not charged and don't count as items", () => {
    const p = pricePack(
      pack({
        items: [
          { product_id: "p-tomato", quantity: 5, qty_promo_enabled: true, buy_qty: 2, get_qty: 1 },
          { product_id: "p-carrot", quantity: 1, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 },
        ],
      }),
      byId
    )!;
    assert.equal(p.items[0].free_qty, 2);
    assert.equal(p.items[1].free_qty, 0);
    assert.equal(p.original_price, 680.5); // 120×5 + 80.50, free units excluded
    assert.equal(p.item_count, 6); // charged units only
  });
});

describe("pricePack — contents", () => {
  it("counts item_count as Σ quantity", () => {
    assert.equal(pricePack(pack(), byId)!.item_count, 3);
  });

  it("maps each item from the live product", () => {
    const p = pricePack(pack({ image: "pack.jpg", description: "Fresh" }), byId)!;
    assert.equal(p.image, "pack.jpg");
    assert.equal(p.description, "Fresh");
    assert.deepEqual(p.items[0], {
      product_id: "p-tomato",
      name: "Tomatoes",
      image: "tomato.jpg",
      unit: "1 kg",
      unit_price: 120,
      quantity: 2,
      free_qty: 0,
    });
    // No main image → first photo; numeric strings → numbers.
    assert.equal(p.items[1].image, "carrot.jpg");
    assert.equal(p.items[1].unit_price, 80.5);
  });

  it("drops a pack with a missing / hidden product", () => {
    const items = [{ product_id: "p-gone", quantity: 1, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 }];
    assert.equal(pricePack(pack({ items: [...pack().items!, ...items] }), byId), null);
  });

  it("drops an empty pack or one with a bad quantity", () => {
    assert.equal(pricePack(pack({ items: [] }), byId), null);
    assert.equal(pricePack(pack({ items: null }), byId), null);
    const zero = [{ product_id: "p-tomato", quantity: 0, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 }];
    assert.equal(pricePack(pack({ items: zero }), byId), null);
  });
});

describe("pricePacks", () => {
  it("drops unsellable packs and sorts by savings, then newest", () => {
    const list = pricePacks(
      [
        pack({ id: "old-no-discount", created_at: "2026-09-01T00:00:00Z" }),
        pack({ id: "new-no-discount", created_at: "2026-10-05T00:00:00Z" }),
        pack({ id: "big-discount", discount_enabled: true, discount_percent: 30 }),
        pack({
          id: "broken",
          discount_enabled: true,
          discount_percent: 50,
          items: [{ product_id: "p-gone", quantity: 1, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 }],
        }),
      ],
      products
    );
    assert.deepEqual(
      list.map((p) => p.id),
      ["big-discount", "new-no-discount", "old-no-discount"]
    );
  });
});

describe("storeOrderDeliveryFee", () => {
  it("is free when every line is a free-delivery pack", () => {
    assert.equal(
      storeOrderDeliveryFee(
        [
          { pack_id: "a", free_delivery: true },
          { pack_id: "b", free_delivery: true },
        ],
        200
      ),
      0
    );
  });

  it("charges the store fee for a mix of packs and products", () => {
    assert.equal(storeOrderDeliveryFee([{ pack_id: "a", free_delivery: true }, {}], 200), 200);
  });

  it("charges the store fee for packs without free delivery", () => {
    assert.equal(
      storeOrderDeliveryFee(
        [
          { pack_id: "a", free_delivery: true },
          { pack_id: "b", free_delivery: false },
        ],
        200
      ),
      200
    );
  });

  it("charges the store fee for an empty order", () => {
    assert.equal(storeOrderDeliveryFee([], 200), 200);
  });
});

describe("priceStoreOrder", () => {
  const free = pricePack(pack({ id: "free", free_delivery: true, discount_enabled: true, discount_percent: 10 }), byId)!;
  const paid = pricePack(pack({ id: "paid" }), byId)!;

  it("stores pack lines at the server price with the pack name and contents", () => {
    const r = priceStoreOrder([{ name: "whatever", quantity: 2, unit_price: 288.5, pack_id: "free" }], [free], 150);
    assert.ok(r.ok);
    assert.deepEqual(r.items, [
      {
        name: "Salad pack",
        quantity: 2,
        unit_price: 288.5,
        pack_id: "free",
        pack_items: [
          { name: "Tomatoes", quantity: 2, free_qty: 0 },
          { name: "Carrots", quantity: 1, free_qty: 0 },
        ],
      },
    ]);
    assert.equal(r.subtotal, 577);
    // The rider's fare stays the store fee; the customer's part is waived.
    assert.equal(r.delivery_fee, 150);
    assert.equal(r.delivery_waived, 150);
  });

  it("recomputes the subtotal from the lines and charges the fee for a mixed order", () => {
    const r = priceStoreOrder(
      [
        { name: "Bread", quantity: 3, unit_price: 25 },
        { name: "Salad pack", quantity: 1, unit_price: 288.5, pack_id: "free" },
      ],
      [free],
      150
    );
    assert.ok(r.ok);
    assert.equal(r.subtotal, 363.5);
    assert.equal(r.delivery_fee, 150);
    assert.equal(r.delivery_waived, 0);
    assert.deepEqual(r.items[0], { name: "Bread", quantity: 3, unit_price: 25 });
  });

  it("charges the fee when a pack has no free delivery", () => {
    const r = priceStoreOrder([{ name: "Salad pack", quantity: 1, unit_price: 320.5, pack_id: "paid" }], [paid], 150);
    assert.ok(r.ok);
    assert.equal(r.delivery_fee, 150);
    assert.equal(r.delivery_waived, 0);
  });

  it("accepts a price equal once rounded to 2 decimals", () => {
    assert.ok(samePrice(288.5, 288.499999));
    const r = priceStoreOrder([{ name: "x", quantity: 1, unit_price: 288.500001, pack_id: "free" }], [free], 150);
    assert.ok(r.ok);
  });

  it("rejects a pack whose price changed", () => {
    const r = priceStoreOrder([{ name: "x", quantity: 1, unit_price: 320.5, pack_id: "free" }], [free], 150);
    assert.deepEqual(r, { ok: false, pack_id: "free" });
  });

  it("rejects a pack that's gone or not visible", () => {
    const r = priceStoreOrder([{ name: "x", quantity: 1, unit_price: 100, pack_id: "missing" }], [free], 150);
    assert.deepEqual(r, { ok: false, pack_id: "missing" });
  });
});

describe("packStockUsage", () => {
  const promo = pricePack(
    pack({
      id: "promo",
      items: [
        { product_id: "p-tomato", quantity: 2, qty_promo_enabled: true, buy_qty: 2, get_qty: 1 },
        { product_id: "p-carrot", quantity: 1, qty_promo_enabled: false, buy_qty: 0, get_qty: 0 },
      ],
    }),
    byId
  )!;

  it("takes each pack's charged + free units times the packs sold, by product", () => {
    const usage = packStockUsage(
      [
        { name: "Bread", quantity: 1, unit_price: 25 },
        { name: "Promo pack", quantity: 2, unit_price: promo.price, pack_id: "promo" },
      ],
      [promo]
    );
    // Tomatoes: (2 charged + 1 free) × 2 packs; carrots: 1 × 2 packs.
    assert.deepEqual(Object.fromEntries(usage), { "p-tomato": 6, "p-carrot": 2 });
  });

  it("ignores product lines and unknown packs", () => {
    const usage = packStockUsage([{ name: "x", quantity: 1, unit_price: 1, pack_id: "gone" }], [promo]);
    assert.equal(usage.size, 0);
  });
});
