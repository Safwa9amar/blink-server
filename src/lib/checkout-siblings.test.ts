import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownSiblings, ownsWholeCheckout, type SiblingRow } from "./checkout-siblings";

const row = (over: Partial<SiblingRow>): SiblingRow => ({
  id: "o1",
  checkout_id: "c1",
  store_id: "s1",
  store_name: "Blink Mart — Bab Ezzouar",
  status: "searching",
  merchant_status: "pending",
  type: "merchant",
  items: [{ quantity: 2 }],
  subtotal: 400,
  total: 410,
  accepted_at: null,
  prepared_at: null,
  rider_assigned_at: null,
  owner_id: "dev",
  ...over,
});

describe("ownSiblings", () => {
  const bab = row({});
  const hydra = row({
    id: "o2",
    store_id: "s2",
    store_name: "Blink Mart — Hydra",
    items: [{ quantity: 1 }, { quantity: 2 }],
  });
  const other = row({ id: "o3", store_id: "s3", store_name: "Other Shop", owner_id: "someone" });

  it("lists the other parts in stores with the same owner", () => {
    const sibs = ownSiblings({ id: "o1", checkout_id: "c1" }, [bab, hydra, other]);
    assert.deepEqual(
      sibs.map((s) => s.id),
      ["o2"]
    );
    assert.equal(sibs[0].item_count, 3);
    assert.equal(sibs[0].store_name, "Blink Mart — Hydra");
  });

  it("never includes the order itself or another merchant's part", () => {
    const sibs = ownSiblings({ id: "o2", checkout_id: "c1" }, [bab, hydra, other]);
    assert.deepEqual(
      sibs.map((s) => s.id),
      ["o1"]
    );
  });

  it("is empty without a checkout_id", () => {
    assert.deepEqual(ownSiblings({ id: "o1", checkout_id: null }, [bab, hydra]), []);
  });

  it("is empty when the order's own row is missing (owner unknown)", () => {
    assert.deepEqual(ownSiblings({ id: "o9", checkout_id: "c1" }, [bab, hydra]), []);
  });

  it("keeps canceled parts and sorts by store name", () => {
    const zeralda = row({
      id: "o4",
      store_id: "s4",
      store_name: "Blink Mart — Zeralda",
      status: "canceled",
    });
    const sibs = ownSiblings({ id: "o1", checkout_id: "c1" }, [zeralda, bab, hydra]);
    assert.deepEqual(
      sibs.map((s) => s.id),
      ["o2", "o4"]
    );
  });

  it("ignores rows from another checkout", () => {
    const elsewhere = row({ id: "o5", checkout_id: "c2", store_id: "s2" });
    assert.deepEqual(ownSiblings({ id: "o1", checkout_id: "c1" }, [bab, elsewhere]), []);
  });
});

describe("ownsWholeCheckout", () => {
  const bab = row({});
  const hydra = row({ id: "o2", store_id: "s2", store_name: "Blink Mart — Hydra" });
  const other = row({ id: "o3", store_id: "s3", owner_id: "someone" });

  it("is true when every live part is the same owner's", () => {
    assert.equal(ownsWholeCheckout({ id: "o1", checkout_id: "c1" }, [bab, hydra]), true);
  });

  it("is false when another merchant's store is in the checkout", () => {
    assert.equal(ownsWholeCheckout({ id: "o1", checkout_id: "c1" }, [bab, hydra, other]), false);
  });

  it("ignores another merchant's store that dropped out", () => {
    const gone = row({ id: "o3", store_id: "s3", owner_id: "someone", status: "merchant_rejected" });
    assert.equal(ownsWholeCheckout({ id: "o1", checkout_id: "c1" }, [bab, hydra, gone]), true);
  });

  it("is false without a checkout", () => {
    assert.equal(ownsWholeCheckout({ id: "o1", checkout_id: null }, [bab]), false);
  });
});
