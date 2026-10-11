import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storeReviewCopy, storeReviewHref, storeReviewKind } from "./store-review-copy";

const LANGS = ["en", "fr", "ar"] as const;

describe("storeReviewKind", () => {
  it("names the decision by where the store comes from", () => {
    assert.equal(storeReviewKind({ from: "under_review", to: "active" }), "store_approved");
    assert.equal(storeReviewKind({ from: "inactive", to: "active" }), "store_approved");
    assert.equal(storeReviewKind({ from: "under_review", to: "inactive" }), "store_rejected");
    assert.equal(storeReviewKind({ from: "active", to: "inactive" }), "store_deactivated");
  });

  it("is null when the merchant has nothing new to learn", () => {
    assert.equal(storeReviewKind({ from: "active", to: "active" }), null);
    assert.equal(storeReviewKind({ from: "inactive", to: "inactive" }), null);
    assert.equal(storeReviewKind({ from: "active", to: "under_review" }), null);
    assert.equal(storeReviewKind({ from: "inactive", to: "under_review" }), null);
  });
});

describe("storeReviewCopy", () => {
  it("announces the approval of a store under review", () => {
    const copy = storeReviewCopy({ name: "Chez Amine", from: "under_review", to: "active" });
    assert.ok(copy);
    assert.equal(copy.kind, "store_approved");
    assert.equal(copy.en.title, "Store approved");
    for (const lang of LANGS) {
      assert.ok(copy[lang].title.trim(), `${lang} title`);
      assert.ok(copy[lang].description.includes("Chez Amine"), `${lang} description`);
    }
  });

  it("announces the re-approval of a rejected store, without the old note", () => {
    const copy = storeReviewCopy({ name: "Chez Amine", from: "inactive", to: "active", note: "Old reason" });
    assert.equal(copy?.kind, "store_approved");
    for (const lang of LANGS) assert.ok(!copy![lang].description.includes("Old reason"), `${lang} no note`);
  });

  it("passes the staff note on when a store under review is rejected", () => {
    const copy = storeReviewCopy({
      name: "Chez Amine",
      from: "under_review",
      to: "inactive",
      note: "  Register scan is blurry ",
    });
    assert.ok(copy);
    assert.equal(copy.kind, "store_rejected");
    assert.equal(copy.en.title, "Store not approved");
    for (const lang of LANGS) {
      assert.ok(copy[lang].description.includes("Chez Amine"), `${lang} name`);
      assert.ok(copy[lang].description.includes("Register scan is blurry"), `${lang} note`);
      assert.ok(!copy[lang].description.includes("  Register"), `${lang} note is trimmed`);
    }
  });

  it("falls back to generic advice when the rejection has no note", () => {
    for (const note of [undefined, null, "", "   "]) {
      const copy = storeReviewCopy({ name: "Chez Amine", from: "under_review", to: "inactive", note });
      assert.ok(copy);
      assert.match(copy.en.description, /check its details and documents/i);
      for (const lang of LANGS) {
        assert.doesNotMatch(copy[lang].description, /undefined|null/, `${lang} has no leaked value`);
      }
    }
  });

  it("tells the merchant when a live store is deactivated, with the note", () => {
    const copy = storeReviewCopy({ name: "Chez Amine", from: "active", to: "inactive", note: "Expired register" });
    assert.equal(copy?.kind, "store_deactivated");
    assert.equal(copy?.en.title, "Store deactivated");
    for (const lang of LANGS) assert.ok(copy![lang].description.includes("Expired register"), `${lang} note`);
  });

  it("stays silent when the merchant has nothing new to learn", () => {
    assert.equal(storeReviewCopy({ name: "S", from: "active", to: "active" }), null);
    assert.equal(storeReviewCopy({ name: "S", from: "inactive", to: "inactive" }), null);
    assert.equal(storeReviewCopy({ name: "S", from: "active", to: "under_review" }), null);
    assert.equal(storeReviewCopy({ name: "S", from: "inactive", to: "under_review" }), null);
  });
});

describe("storeReviewHref", () => {
  it("opens the store in the merchant app", () => {
    assert.equal(storeReviewHref("st-1"), "/(merchant)/profile/my-stores/st-1");
  });
});
