import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogReviewCopy,
  catalogReviewHref,
  money,
  packDecisionKind,
  type CatalogReviewEvent,
} from "./catalog-review-copy";

const EVENTS: CatalogReviewEvent[] = [
  { kind: "product_approved", product_id: "p1", product: "Candia 1L", store: "Superette Hydra" },
  { kind: "product_rejected", product_id: "p1", product: "Candia 1L", store: "Superette Hydra", note: "Blurry photo" },
  { kind: "price_accepted", product_id: "p1", product: "Candia 1L", price: 150 },
  { kind: "pricing_flagged", product_id: "p1", product: "Candia 1L", suggested: 300, price: 120, note: "Too high" },
  { kind: "pack_approved", pack_id: "k1", pack: "Breakfast pack", store: "Superette Hydra" },
  { kind: "pack_rejected", pack_id: "k1", pack: "Breakfast pack", store: "Superette Hydra", note: "Margin too low" },
  { kind: "pack_deactivated", pack_id: "k1", pack: "Breakfast pack", store: "Superette Hydra" },
];

describe("catalogReviewCopy", () => {
  it("has a title and a description naming the item in every language", () => {
    for (const e of EVENTS) {
      const copy = catalogReviewCopy(e);
      const name = "product" in e ? e.product : e.pack;
      for (const lang of ["en", "fr", "ar"] as const) {
        assert.ok(copy[lang].title.trim(), `${e.kind} ${lang} title`);
        assert.ok(copy[lang].description.includes(name), `${e.kind} ${lang} description`);
      }
    }
  });

  it("includes the staff note when there is one", () => {
    const copy = catalogReviewCopy(EVENTS[1]);
    assert.match(copy.en.description, /Note: Blurry photo$/);
    assert.match(copy.fr.description, /Note : Blurry photo$/);
    assert.match(copy.ar.description, /ملاحظة: Blurry photo$/);
  });

  it("leaves the note out when it is empty", () => {
    const copy = catalogReviewCopy({ ...EVENTS[1], note: "  " } as CatalogReviewEvent);
    assert.doesNotMatch(copy.en.description, /Note/);
  });

  it("keeps the existing pricing-flagged wording with both prices", () => {
    const { en } = catalogReviewCopy(EVENTS[3]);
    assert.equal(en.title, "Item pricing flagged");
    assert.match(en.description, /300 Da was declined\. It stays at 120 Da\./);
  });

  it("copes with a declined suggestion that has no amount", () => {
    const { en } = catalogReviewCopy({ ...EVENTS[3], suggested: null } as CatalogReviewEvent);
    assert.match(en.description, /your suggested price was declined/);
  });
});

describe("catalogReviewHref", () => {
  it("opens the product, its price or the pack", () => {
    assert.equal(catalogReviewHref(EVENTS[0]), "/(merchant)/my-store/products/p1");
    assert.equal(catalogReviewHref(EVENTS[1]), "/(merchant)/my-store/products/p1");
    assert.equal(catalogReviewHref(EVENTS[2]), "/(merchant)/my-store/pricing/p1");
    assert.equal(catalogReviewHref(EVENTS[3]), "/(merchant)/my-store/pricing/p1");
    for (const e of EVENTS.slice(4)) assert.equal(catalogReviewHref(e), "/(merchant)/my-store/packs/k1");
  });
});

describe("packDecisionKind", () => {
  it("approves a pack that wasn't live", () => {
    assert.equal(packDecisionKind({ status: "under_review", review_note: null }, { status: "active" }), "pack_approved");
    assert.equal(packDecisionKind({ status: "inactive", review_note: "x" }, { status: "active" }), "pack_approved");
  });
  it("rejects a pack in review, deactivates a live one", () => {
    assert.equal(packDecisionKind({ status: "under_review", review_note: null }, { status: "inactive" }), "pack_rejected");
    assert.equal(packDecisionKind({ status: "active", review_note: null }, { status: "inactive" }), "pack_deactivated");
  });
  it("stays quiet when nothing changed", () => {
    assert.equal(packDecisionKind({ status: "active", review_note: null }, { status: "active" }), null);
    assert.equal(packDecisionKind({ status: "inactive", review_note: null }, { status: "inactive" }), null);
    assert.equal(
      packDecisionKind({ status: "inactive", review_note: "Margin" }, { status: "inactive", note: " Margin " }),
      null
    );
  });
  it("tells the merchant about a new note on a pack already off", () => {
    assert.equal(
      packDecisionKind({ status: "inactive", review_note: null }, { status: "inactive", note: "Margin" }),
      "pack_rejected"
    );
  });
});

describe("money", () => {
  it("prints at most 2 decimals", () => {
    assert.equal(money(1500), "1500");
    assert.equal(money(99.5), "99.5");
    assert.equal(money(10.006), "10.01");
  });
});
