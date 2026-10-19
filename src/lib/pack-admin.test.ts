import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adminPackUpdateKind,
  changedPackFields,
  duplicateItems,
  foreignItems,
  foundRow,
  hasEditableField,
  isStale,
  newAdminPackColumns,
  normalizePackItems,
  resolveAdminPackUpdate,
} from "./pack-admin";

const NOW = "2026-10-19T12:00:00.000Z";
const A = "0b1e6a52-7a8f-4c1e-9d2a-3f5b6c7d8e9f";
const B = "1c2f7b63-8b9a-4d2f-ae3b-4a6c7d8e9fa0";

const line = (product_id: string, quantity = 1) => ({
  product_id,
  quantity,
  qty_promo_enabled: false,
  buy_qty: 0,
  get_qty: 0,
});

describe("normalizePackItems", () => {
  it("fills the promo defaults", () => {
    assert.deepEqual(normalizePackItems([{ product_id: A, quantity: 2 }]), [line(A, 2)]);
  });
  it("keeps a promo as sent", () => {
    assert.deepEqual(
      normalizePackItems([{ product_id: A, quantity: 1, qty_promo_enabled: true, buy_qty: 2, get_qty: 1 }]),
      [{ product_id: A, quantity: 1, qty_promo_enabled: true, buy_qty: 2, get_qty: 1 }]
    );
  });
  it("lowercases product ids", () => {
    assert.equal(normalizePackItems([{ product_id: A.toUpperCase(), quantity: 1 }])[0].product_id, A);
  });
});

describe("duplicateItems", () => {
  it("accepts distinct products", () => {
    assert.equal(duplicateItems([line(A), line(B)]), null);
  });
  it("refuses a product listed twice, whatever its case", () => {
    const failure = duplicateItems(normalizePackItems([line(A), line(B), { product_id: A.toUpperCase(), quantity: 3 }]));
    assert.equal(failure?.status, 400);
    assert.equal(failure?.code, "duplicate_items");
    assert.match(failure!.error, new RegExp(A));
    assert.doesNotMatch(failure!.error, new RegExp(B));
  });
});

describe("foreignItems", () => {
  it("accepts products of the store", () => {
    assert.equal(foreignItems([line(A), line(B)], [A, B]), null);
    assert.equal(foreignItems([line(A)], [A.toUpperCase()]), null);
  });
  it("names each item that isn't the store's", () => {
    const failure = foreignItems([line(A), line(B)], [A]);
    assert.equal(failure?.code, "invalid_items");
    assert.match(failure!.error, new RegExp(B));
    assert.deepEqual(failure?.details, [{ path: "items.1.product_id", message: "Not a product of this store" }]);
  });
});

describe("hasEditableField", () => {
  it("is false for an empty body or one with only the expected timestamp", () => {
    assert.equal(hasEditableField({}), false);
    assert.equal(hasEditableField({ expected_updated_at: NOW, name: undefined }), false);
  });
  it("counts a cleared field", () => {
    assert.equal(hasEditableField({ description: null }), true);
    assert.equal(hasEditableField({ status: "archived" }), true);
    assert.equal(hasEditableField({ free_delivery: false }), true);
  });
});

describe("foundRow", () => {
  it("returns the row, or null when the read found none", () => {
    assert.deepEqual(foundRow({ data: { id: A }, error: null }, "pack"), { id: A });
    assert.equal(foundRow({ data: null, error: null }, "pack"), null);
  });
  it("reads a malformed id as no row", () => {
    const error = { code: "22P02", message: 'invalid input syntax for type uuid: "nope"' };
    assert.equal(foundRow({ data: null, error }, "pack"), null);
  });
  it("throws on any other read failure instead of answering not found", () => {
    assert.throws(
      () => foundRow({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }, "store"),
      /store lookup failed: canceling statement/
    );
    assert.throws(() => foundRow({ data: null, error: { message: "TypeError: fetch failed" } }, "pack"), /pack lookup failed/);
  });
});

describe("isStale", () => {
  it("only checks when the reviewer sent a timestamp", () => {
    assert.equal(isStale("2026-10-19T10:00:00+00:00", undefined), false);
  });
  it("compares instants, not strings", () => {
    assert.equal(isStale("2026-10-19T10:00:00.123+00:00", "2026-10-19T10:00:00.123Z"), false);
    assert.equal(isStale("2026-10-19T10:00:00.123+00:00", "2026-10-19T10:00:01.000Z"), true);
  });
});

describe("changedPackFields", () => {
  const current = {
    name: "Breakfast",
    description: null,
    image: null,
    items: [{ product_id: A, quantity: 1, qty_promo_enabled: false, buy_qty: 2, get_qty: 1 }],
    discount_enabled: true,
    discount_percent: 10,
    free_delivery: false,
    status: "active",
  };
  it("drops what already holds the sent value", () => {
    assert.deepEqual(
      changedPackFields(current, {
        name: "Breakfast",
        description: null,
        items: [{ product_id: A, quantity: 1, qty_promo_enabled: false, buy_qty: 2, get_qty: 1 }],
        discount_percent: 10,
        status: "active",
      }),
      {}
    );
  });
  it("keeps the changes", () => {
    assert.deepEqual(changedPackFields(current, { name: "Brunch", image: "https://x/y.jpg", status: "inactive" }), {
      name: "Brunch",
      image: "https://x/y.jpg",
      status: "inactive",
    });
  });
  it("sees an item change and a line order change", () => {
    const items = normalizePackItems([line(A, 2)]);
    assert.deepEqual(changedPackFields(current, { items }), { items });
    const reordered = normalizePackItems([line(B), line(A)]);
    assert.deepEqual(
      changedPackFields({ ...current, items: normalizePackItems([line(A), line(B)]) }, { items: reordered }),
      { items: reordered }
    );
  });
  it("ignores keys that aren't pack columns", () => {
    assert.deepEqual(changedPackFields(current, { expected_updated_at: NOW } as Record<string, unknown>), {});
  });
});

describe("newAdminPackColumns", () => {
  it("approves a live free-delivery pack", () => {
    assert.deepEqual(newAdminPackColumns("active", true, NOW), { status: "active", reviewed_at: NOW, review_note: null });
  });
  it("leaves reviewed_at empty otherwise", () => {
    assert.deepEqual(newAdminPackColumns("active", false, NOW), { status: "active", reviewed_at: null, review_note: null });
    assert.deepEqual(newAdminPackColumns("inactive", true, NOW), { status: "inactive", reviewed_at: null, review_note: null });
  });
  it("never creates a pack in review", () => {
    for (const status of ["active", "inactive"] as const) {
      for (const free of [true, false]) assert.notEqual(newAdminPackColumns(status, free, NOW).status, "under_review");
    }
  });
});

describe("resolveAdminPackUpdate", () => {
  it("keeps the current status when none is sent", () => {
    assert.equal(resolveAdminPackUpdate({ status: "under_review", free_delivery: true }, {}, NOW).status, "under_review");
    assert.equal(resolveAdminPackUpdate({ status: "inactive", free_delivery: false }, {}, NOW).status, "inactive");
  });
  it("re-approves a live free-delivery pack and lifts the hold", () => {
    assert.deepEqual(resolveAdminPackUpdate({ status: "active", free_delivery: true }, {}, NOW), {
      status: "active",
      reviewed_at: NOW,
      review_note: null,
    });
    assert.deepEqual(resolveAdminPackUpdate({ status: "inactive", free_delivery: false }, { status: "active", free_delivery: true }, NOW), {
      status: "active",
      reviewed_at: NOW,
      review_note: null,
    });
  });
  it("approves a pack in review when staff turn it on", () => {
    assert.deepEqual(resolveAdminPackUpdate({ status: "under_review", free_delivery: true }, { status: "active" }, NOW), {
      status: "active",
      reviewed_at: NOW,
      review_note: null,
    });
  });
  it("clears reviewed_at without free delivery", () => {
    assert.deepEqual(resolveAdminPackUpdate({ status: "active", free_delivery: true }, { free_delivery: false }, NOW), {
      status: "active",
      reviewed_at: null,
      review_note: null,
    });
    assert.deepEqual(resolveAdminPackUpdate({ status: "active", free_delivery: false }, { status: "archived" }, NOW), {
      status: "archived",
      reviewed_at: null,
    });
  });
  it("leaves reviewed_at and the note alone on a free-delivery pack that isn't live", () => {
    assert.deepEqual(resolveAdminPackUpdate({ status: "active", free_delivery: true }, { status: "inactive" }, NOW), {
      status: "inactive",
    });
    assert.deepEqual(resolveAdminPackUpdate({ status: "under_review", free_delivery: false }, { free_delivery: true }, NOW), {
      status: "under_review",
    });
  });
});

describe("adminPackUpdateKind", () => {
  it("sends the approval when a pack in review goes live", () => {
    assert.equal(adminPackUpdateKind({ status: "under_review" }, { status: "active" }), "pack_approved");
  });
  it("sends the staff edit notice otherwise", () => {
    const statuses = ["active", "under_review", "inactive", "archived"] as const;
    for (const before of statuses) {
      for (const after of statuses) {
        if (before === "under_review" && after === "active") continue;
        assert.equal(adminPackUpdateKind({ status: before }, { status: after }), "pack_updated_by_staff", `${before} → ${after}`);
      }
    }
  });
});
