import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contentChanged,
  decidePriceSuggestion,
  identityChanged,
  merchantWritableFields,
  newProductPriceError,
  proposedPrice,
  resolveProductUpdate,
  resolveStaffProductReview,
  sameInstant,
  type ProductReviewState,
} from "./product-review";

const product = (over: Partial<ProductReviewState> = {}): ProductReviewState => ({
  price: 100,
  blink_price: 100,
  review_status: "approved",
  title: "Lait Candia 1L",
  description: null,
  photos: ["a.jpg"],
  brand: "Candia",
  barcode: "613",
  category: "Dairy",
  unit: "1L",
  ...over,
});

describe("decidePriceSuggestion", () => {
  it("applies a price within ±20% of the Blink reference", () => {
    assert.deepEqual(decidePriceSuggestion(product(), 120), {
      suggested_price: 120,
      suggestion_status: "accepted",
      price: 120,
    });
    assert.equal(decidePriceSuggestion(product(), 80).suggestion_status, "accepted");
  });

  it("holds a price further away for staff review", () => {
    assert.deepEqual(decidePriceSuggestion(product(), 121), { suggested_price: 121, suggestion_status: "pending" });
    assert.equal(decidePriceSuggestion(product(), 79).suggestion_status, "pending");
  });

  it("falls back to the live price when there is no reference, and pins it as the reference", () => {
    assert.deepEqual(decidePriceSuggestion(product({ blink_price: 0, price: 200 }), 230), {
      suggested_price: 230,
      suggestion_status: "accepted",
      price: 230,
      blink_price: 200,
    });
    assert.deepEqual(decidePriceSuggestion(product({ blink_price: 0, price: 200 }), 300), {
      suggested_price: 300,
      suggestion_status: "pending",
      blink_price: 200,
    });
  });

  it("can't ratchet the price up ±20% at a time once the reference is pinned", () => {
    const first = decidePriceSuggestion(product({ blink_price: 0, price: 200 }), 240);
    assert.equal(first.suggestion_status, "accepted");
    // The next step is measured against the pinned 200, not the new live 240.
    const next = decidePriceSuggestion(product({ blink_price: first.blink_price!, price: first.price! }), 288);
    assert.deepEqual(next, { suggested_price: 288, suggestion_status: "pending" });
  });

  it("accepts anything when there is no price at all, and makes it the reference", () => {
    assert.deepEqual(decidePriceSuggestion(product({ blink_price: 0, price: 0 }), 450), {
      suggested_price: 450,
      suggestion_status: "accepted",
      price: 450,
      blink_price: 450,
    });
  });

  it("reads numeric strings (PostgREST numerics)", () => {
    assert.equal(decidePriceSuggestion(product({ blink_price: "100.00" }), 150).suggestion_status, "pending");
  });
});

describe("proposedPrice", () => {
  it("prefers an explicit suggestion", () => {
    assert.equal(proposedPrice(product(), { suggested_price: 130, price: 90 }), 130);
  });
  it("treats a changed price as a suggestion and ignores an unchanged one", () => {
    assert.equal(proposedPrice(product(), { price: 110 }), 110);
    assert.equal(proposedPrice(product(), { price: 100 }), undefined);
    assert.equal(proposedPrice(product({ price: "100.00" }), { price: 100.001 }), undefined);
    assert.equal(proposedPrice(product(), {}), undefined);
  });
});

describe("contentChanged", () => {
  it("is false when the form sends the same content back", () => {
    assert.equal(
      contentChanged(product(), { title: "Lait Candia 1L ", photos: ["a.jpg"], description: null, unit: "1L" }),
      false
    );
    assert.equal(contentChanged(product({ description: null }), { description: "" }), false);
  });
  it("is true when a reviewed field changes", () => {
    assert.equal(contentChanged(product(), { title: "Lait Candia 1 litre" }), true);
    assert.equal(contentChanged(product(), { photos: ["a.jpg", "b.jpg"] }), true);
    assert.equal(contentChanged(product(), { brand: "Soummam" }), true);
    assert.equal(contentChanged(product(), { category: "Drinks" }), true);
  });
});

describe("resolveProductUpdate", () => {
  it("never writes a price outside the suggestion rule", () => {
    const r = resolveProductUpdate(product(), { price: 500 });
    assert.deepEqual(r, {
      ok: true,
      columns: { suggested_price: 500, suggestion_status: "pending", review_note: null },
    });
  });

  it("applies a small price change as an accepted suggestion", () => {
    const r = resolveProductUpdate(product(), { price: 105 });
    assert.deepEqual(r, {
      ok: true,
      columns: { suggested_price: 105, suggestion_status: "accepted", price: 105, review_note: null },
    });
  });

  it("ignores an unchanged price", () => {
    assert.deepEqual(resolveProductUpdate(product(), { price: 100, title: "Lait Candia 1L" }), {
      ok: true,
      columns: {},
    });
  });

  it("refuses a zero price", () => {
    assert.deepEqual(resolveProductUpdate(product(), { price: 0 }), {
      ok: false,
      code: "price_invalid",
      error: "price must be greater than 0",
    });
  });

  it("resubmits a rejected product whose content changed", () => {
    const r = resolveProductUpdate(product({ review_status: "rejected" }), { photos: ["new.jpg"] });
    assert.deepEqual(r, { ok: true, columns: { review_status: "pending", review_note: null } });
  });

  it("leaves a rejected product rejected when nothing reviewed changed", () => {
    const r = resolveProductUpdate(product({ review_status: "rejected" }), { title: "Lait Candia 1L" });
    assert.deepEqual(r, { ok: true, columns: {} });
  });

  it("keeps a rejected product's note on a price-only edit", () => {
    const r = resolveProductUpdate(product({ review_status: "rejected" }), { suggested_price: 300 });
    assert.ok(r.ok);
    assert.equal("review_note" in r.columns, false);
    assert.equal(r.columns.suggestion_status, "pending");
  });

  it("does not touch the review status of a pending product", () => {
    const r = resolveProductUpdate(product({ review_status: "pending" }), { title: "Other" });
    assert.deepEqual(r, { ok: true, columns: {} });
  });

  it("re-reviews an approved manual product whose name, photos, brand or barcode change", () => {
    for (const edit of [{ title: "Other" }, { photos: ["b.jpg"] }, { brand: "Soummam" }, { barcode: "614" }]) {
      assert.deepEqual(resolveProductUpdate(product({ library_product_id: null }), edit), {
        ok: true,
        columns: { review_status: "pending", review_note: null },
      });
    }
  });

  it("keeps an approved manual product live for other edits or an unchanged identity", () => {
    const manual = product({ library_product_id: null });
    for (const edit of [
      { description: "Whole milk" },
      { category: "Drinks" },
      { unit: "2L" },
      { title: " Lait Candia 1L", photos: ["a.jpg"], brand: "Candia", barcode: "613" },
    ]) {
      assert.deepEqual(resolveProductUpdate(manual, edit), { ok: true, columns: {} });
    }
  });

  it("does not re-review a library product (its content is Blink's)", () => {
    const r = resolveProductUpdate(product({ library_product_id: "lib-1" }), { title: "Other" });
    assert.deepEqual(r, { ok: true, columns: {} });
  });

  it("re-reviews an identity change made together with a price change", () => {
    const r = resolveProductUpdate(product(), { title: "Other", price: 105 });
    assert.ok(r.ok);
    assert.equal(r.columns.review_status, "pending");
    assert.equal(r.columns.price, 105);
  });
});

describe("identityChanged", () => {
  it("only looks at name, photos, brand and barcode", () => {
    assert.equal(identityChanged(product(), { title: "Other" }), true);
    assert.equal(identityChanged(product(), { photos: [] }), true);
    assert.equal(identityChanged(product(), { description: "x", category: "y", unit: "z" }), false);
    assert.equal(identityChanged(product(), { title: "Lait Candia 1L" }), false);
  });
});

describe("merchantWritableFields", () => {
  const sent = {
    title: "My name",
    description: "mine",
    photos: ["mine.jpg"],
    brand: "Mine",
    barcode: "000",
    unit: "kg",
    category: "Breakfast",
    stock: 4,
    is_available: false,
    tag: undefined,
  };
  it("keeps only category / stock / availability for a library product", () => {
    assert.deepEqual(merchantWritableFields(true, sent), { category: "Breakfast", stock: 4, is_available: false });
  });
  it("keeps every defined field of a manual product", () => {
    const { tag: _tag, ...defined } = sent;
    assert.deepEqual(merchantWritableFields(false, sent), defined);
  });
});

describe("newProductPriceError", () => {
  it("needs a price > 0 for a manual product", () => {
    assert.equal(newProductPriceError(false, 150), null);
    assert.match(newProductPriceError(false, undefined) ?? "", /manual/);
    assert.match(newProductPriceError(false, 0) ?? "", /greater than 0/);
  });
  it("needs a price > 0 for a library product too (it goes live at once)", () => {
    assert.equal(newProductPriceError(true, 99), null);
    assert.equal(newProductPriceError(true, 0.5), null);
    assert.match(newProductPriceError(true, undefined) ?? "", /library/);
    assert.match(newProductPriceError(true, 0) ?? "", /greater than 0/);
    assert.match(newProductPriceError(true, Number.NaN) ?? "", /greater than 0/);
  });
});

describe("sameInstant", () => {
  it("compares instants, not strings", () => {
    assert.ok(sameInstant("2026-10-10T12:00:00.123456+00:00", "2026-10-10T12:00:00.123Z"));
    assert.ok(sameInstant("2026-10-10T13:00:00+01:00", "2026-10-10T12:00:00Z"));
    assert.ok(!sameInstant("2026-10-10T12:00:00.124Z", "2026-10-10T12:00:00.123Z"));
    assert.ok(!sameInstant(null, "2026-10-10T12:00:00Z"));
    assert.ok(!sameInstant("nope", "nope"));
  });
});

describe("resolveStaffProductReview", () => {
  const UPDATED = "2026-10-10T12:00:00.123456+00:00";
  const staff = (over: Partial<Parameters<typeof resolveStaffProductReview>[0]> = {}) => ({
    price: 100,
    review_status: "pending" as const,
    suggested_price: null,
    suggestion_status: null,
    review_note: null,
    updated_at: UPDATED,
    ...over,
  });

  it("approves a pending product, clearing the note", () => {
    assert.deepEqual(resolveStaffProductReview(staff({ review_note: "blurry" }), { review_status: "approved" }), {
      ok: true,
      columns: { review_status: "approved", review_note: null },
      decisions: ["product_approved"],
    });
  });

  it("approves a rejected product (staff change their mind)", () => {
    const r = resolveStaffProductReview(staff({ review_status: "rejected", review_note: "blurry" }), {
      review_status: "approved",
    });
    assert.ok(r.ok);
    assert.deepEqual(r.decisions, ["product_approved"]);
  });

  it("rejects a pending or approved product with the staff note", () => {
    for (const review_status of ["pending", "approved"] as const) {
      assert.deepEqual(resolveStaffProductReview(staff({ review_status }), { review_status: "rejected", note: " Blurry photo " }), {
        ok: true,
        columns: { review_status: "rejected", review_note: "Blurry photo" },
        decisions: ["product_rejected"],
      });
    }
  });

  it("needs a note to reject a product or a price", () => {
    const noteRequired = { ok: false, status: 400, code: "note_required", error: "A note is required to reject" };
    assert.deepEqual(resolveStaffProductReview(staff(), { review_status: "rejected" }), noteRequired);
    assert.deepEqual(resolveStaffProductReview(staff(), { review_status: "rejected", note: "   " }), noteRequired);
    assert.deepEqual(
      resolveStaffProductReview(staff({ suggested_price: 300, suggestion_status: "pending" }), { suggestion_status: "rejected" }),
      noteRequired
    );
  });

  it("changes nothing for a decision already in place, or a request for pending", () => {
    const nothing = { ok: true, columns: {}, decisions: [] };
    assert.deepEqual(resolveStaffProductReview(staff({ review_status: "approved" }), { review_status: "approved" }), nothing);
    const rejected = staff({ review_status: "rejected", review_note: "Blurry" });
    assert.deepEqual(resolveStaffProductReview(rejected, { review_status: "rejected", note: "Blurry" }), nothing);
    assert.deepEqual(resolveStaffProductReview(rejected, { review_status: "rejected", note: "Wrong brand" }), nothing);
    assert.deepEqual(resolveStaffProductReview(staff({ review_status: "approved" }), { review_status: "pending" }), nothing);
  });

  it("accepts a pending price suggestion as the live price", () => {
    const r = resolveStaffProductReview(staff({ review_status: "approved", suggested_price: "150.00", suggestion_status: "pending" }), {
      suggestion_status: "accepted",
    });
    assert.deepEqual(r, {
      ok: true,
      columns: { suggestion_status: "accepted", price: 150 },
      decisions: ["price_accepted"],
    });
  });

  it("overturns a declined suggestion, dropping its note unless the product is rejected", () => {
    const declined = staff({ review_status: "approved", suggested_price: 150, suggestion_status: "rejected", review_note: "Too high" });
    assert.deepEqual(resolveStaffProductReview(declined, { suggestion_status: "accepted" }), {
      ok: true,
      columns: { suggestion_status: "accepted", price: 150, review_note: null },
      decisions: ["price_accepted"],
    });
    const r = resolveStaffProductReview({ ...declined, review_status: "rejected", review_note: "Blurry" }, { suggestion_status: "accepted" });
    assert.ok(r.ok);
    assert.equal("review_note" in r.columns, false);
  });

  it("refuses to accept when there is no suggestion, or it was already accepted", () => {
    assert.deepEqual(resolveStaffProductReview(staff(), { suggestion_status: "accepted" }), {
      ok: false,
      status: 409,
      code: "no_suggestion",
      error: "There is no suggested price to accept",
    });
    const r = resolveStaffProductReview(staff({ suggested_price: 150, suggestion_status: "accepted" }), { suggestion_status: "accepted" });
    assert.ok(!r.ok && r.status === 409 && r.code === "not_pending");
  });

  it("declines a pending price suggestion with the staff note", () => {
    const r = resolveStaffProductReview(staff({ review_status: "approved", suggested_price: 300, suggestion_status: "pending" }), {
      suggestion_status: "rejected",
      note: "Too far above market",
    });
    assert.deepEqual(r, {
      ok: true,
      columns: { suggestion_status: "rejected", review_note: "Too far above market" },
      decisions: ["pricing_flagged"],
    });
  });

  it("only declines a suggestion that is pending", () => {
    for (const suggestion_status of ["accepted", "rejected", null] as const) {
      const r = resolveStaffProductReview(staff({ suggested_price: 300, suggestion_status }), {
        suggestion_status: "rejected",
        note: "Too high",
      });
      assert.ok(!r.ok && r.status === 409 && r.code === "not_pending", String(suggestion_status));
    }
  });

  it("notifies both decisions made in one review", () => {
    const r = resolveStaffProductReview(staff({ suggested_price: 120, suggestion_status: "pending" }), {
      review_status: "approved",
      suggestion_status: "accepted",
    });
    assert.ok(r.ok);
    assert.deepEqual(r.decisions, ["product_approved", "price_accepted"]);
  });

  it("refuses a suggestion decision when the suggested price changed since the reviewer saw it", () => {
    const pending = staff({ suggested_price: "150.00", suggestion_status: "pending" });
    const stale = resolveStaffProductReview(pending, { suggestion_status: "accepted", expected_suggested_price: 140 });
    assert.ok(!stale.ok && stale.status === 409 && stale.code === "stale");
    const gone = resolveStaffProductReview(staff({ suggestion_status: "pending" }), {
      suggestion_status: "rejected",
      note: "x",
      expected_suggested_price: 140,
    });
    assert.ok(!gone.ok && gone.code === "stale");
    assert.ok(resolveStaffProductReview(pending, { suggestion_status: "accepted", expected_suggested_price: 150 }).ok);
  });

  it("refuses a product decision when the row changed since the reviewer saw it", () => {
    const stale = resolveStaffProductReview(staff(), {
      review_status: "approved",
      expected_updated_at: "2026-10-10T11:59:59Z",
    });
    assert.ok(!stale.ok && stale.status === 409 && stale.code === "stale");
    // Same instant, another format.
    assert.ok(resolveStaffProductReview(staff(), { review_status: "approved", expected_updated_at: "2026-10-10T12:00:00.123Z" }).ok);
  });

  it("ignores expected_updated_at on a suggestion-only decision (stock sales bump it)", () => {
    const r = resolveStaffProductReview(staff({ suggested_price: 150, suggestion_status: "pending" }), {
      suggestion_status: "accepted",
      expected_updated_at: "2020-01-01T00:00:00Z",
    });
    assert.ok(r.ok);
  });

  it("checks the note before the state", () => {
    const r = resolveStaffProductReview(staff({ suggestion_status: "accepted", suggested_price: 1 }), { suggestion_status: "rejected" });
    assert.ok(!r.ok && r.code === "note_required");
  });
});
