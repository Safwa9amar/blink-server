import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentDocValue,
  documentsStatus,
  effectiveDocStatus,
  markReviewed,
  resolveStoreDocumentReview,
  sanitizeReview,
  STORE_DOC_KEYS,
  verifyAllPresent,
  withDocumentsStatus,
  type StoreDocumentReview,
} from "./store-documents";

const NOW = "2026-10-10T12:00:00.000Z";
const LATER = "2026-10-11T09:00:00.000Z";
const STAFF = "staff-1";

const DOCS = {
  commercial_register_front_url: "https://cdn/front.jpg",
  commercial_register_back_url: "https://cdn/back.jpg",
  nif: "000016001234567",
  nis: "123456789012345",
};

const entry = (status: "verified" | "rejected", value: string, reason: string | null = null) => ({
  status,
  reason,
  value,
  reviewed_at: NOW,
  reviewed_by: STAFF,
});

const ALL_VERIFIED: StoreDocumentReview = {
  commercial_register_front: entry("verified", DOCS.commercial_register_front_url),
  commercial_register_back: entry("verified", DOCS.commercial_register_back_url),
  nif: entry("verified", DOCS.nif),
  nis: entry("verified", DOCS.nis),
};

describe("currentDocValue", () => {
  it("reads the document's field, trimmed", () => {
    assert.equal(currentDocValue(DOCS, "commercial_register_front"), DOCS.commercial_register_front_url);
    assert.equal(currentDocValue({ nif: "  123 " }, "nif"), "123");
  });

  it("is null when absent, blank or malformed", () => {
    for (const docs of [null, undefined, "x", [], {}, { nif: "  " }, { nif: null }, { nif: { a: 1 } }, { nif: true }]) {
      assert.equal(currentDocValue(docs, "nif"), null, JSON.stringify(docs));
    }
  });

  it("accepts a number typed as one", () => {
    assert.equal(currentDocValue({ nis: 42 }, "nis"), "42");
  });
});

describe("effectiveDocStatus", () => {
  it("is missing without a current value, whatever the review says", () => {
    assert.deepEqual(effectiveDocStatus({}, ALL_VERIFIED, "nif"), { status: "missing", reason: null });
  });

  it("is pending when present but never reviewed", () => {
    assert.deepEqual(effectiveDocStatus(DOCS, {}, "nif"), { status: "pending", reason: null });
  });

  it("is staff's verdict while it matches the current value", () => {
    assert.deepEqual(effectiveDocStatus(DOCS, ALL_VERIFIED, "nif"), { status: "verified", reason: null });
    const review = { nif: entry("rejected", DOCS.nif, "Wrong number") };
    assert.deepEqual(effectiveDocStatus(DOCS, review, "nif"), { status: "rejected", reason: "Wrong number" });
  });

  it("is pending again once the merchant uploads a new scan or edits a number", () => {
    const reuploaded = { ...DOCS, commercial_register_front_url: "https://cdn/front-v2.jpg" };
    assert.deepEqual(effectiveDocStatus(reuploaded, ALL_VERIFIED, "commercial_register_front"), {
      status: "pending",
      reason: null,
    });
    // A rejected one too: the new value waits for staff, the old reason is gone.
    const review = { nif: entry("rejected", DOCS.nif, "Wrong number") };
    assert.deepEqual(effectiveDocStatus({ ...DOCS, nif: "999" }, review, "nif"), { status: "pending", reason: null });
  });

  it("matches the value trimmed on both sides", () => {
    assert.equal(effectiveDocStatus({ nif: " 123 " }, { nif: entry("verified", "123 ") }, "nif").status, "verified");
  });

  it("ignores a malformed review", () => {
    for (const review of [
      null,
      "verified",
      [],
      { nif: "verified" },
      { nif: { status: "approved", value: DOCS.nif } },
      { nif: { status: "verified", value: 123 } },
      { nif: { status: "verified" } },
    ]) {
      assert.equal(effectiveDocStatus(DOCS, review, "nif").status, "pending", JSON.stringify(review));
    }
  });

  it("never exposes a reason on a verified document", () => {
    const review = { nif: { ...entry("verified", DOCS.nif), reason: "leftover" } };
    assert.deepEqual(effectiveDocStatus(DOCS, review, "nif"), { status: "verified", reason: null });
  });
});

describe("documentsStatus", () => {
  it("covers every required document", () => {
    const s = documentsStatus({ nif: "1" }, {});
    assert.deepEqual(Object.keys(s).sort(), [...STORE_DOC_KEYS, "all_verified"].sort());
    assert.deepEqual(s.nif, { status: "pending", reason: null });
    assert.deepEqual(s.nis, { status: "missing", reason: null });
    assert.equal(s.all_verified, false);
  });

  it("is all verified only when each document is verified in its current form", () => {
    assert.equal(documentsStatus(DOCS, ALL_VERIFIED).all_verified, true);
    assert.equal(documentsStatus({ ...DOCS, nis: "" }, ALL_VERIFIED).all_verified, false);
    assert.equal(documentsStatus({ ...DOCS, nis: "new" }, ALL_VERIFIED).all_verified, false);
    const oneRejected = { ...ALL_VERIFIED, nis: entry("rejected", DOCS.nis, "Expired") };
    assert.equal(documentsStatus(DOCS, oneRejected).all_verified, false);
  });

  it("never verifies a store with no documents", () => {
    for (const docs of [null, {}, "x"]) assert.equal(documentsStatus(docs, ALL_VERIFIED).all_verified, false);
  });
});

describe("sanitizeReview", () => {
  it("keeps well-formed entries of known documents only", () => {
    const review = {
      nif: entry("verified", "1"),
      nis: "nope",
      additional_docs: entry("verified", "x"),
      commercial_register_front: { status: "verified", value: "f" },
    };
    assert.deepEqual(sanitizeReview(review), {
      nif: entry("verified", "1"),
      commercial_register_front: { status: "verified", reason: null, value: "f", reviewed_at: "", reviewed_by: null },
    });
    assert.deepEqual(sanitizeReview(null), {});
    assert.deepEqual(sanitizeReview([1, 2]), {});
  });
});

describe("markReviewed", () => {
  it("records the verdict on the current value, who and when", () => {
    const next = markReviewed({}, DOCS, "nif", "rejected", "  Wrong number ", STAFF, new Date(NOW));
    assert.deepEqual(next, { nif: entry("rejected", DOCS.nif, "Wrong number") });
  });

  it("drops the reason on a verification and keeps the other documents", () => {
    const start = { nis: entry("rejected", DOCS.nis, "Expired") };
    const next = markReviewed(start, DOCS, "nif", "verified", "ignored", STAFF, NOW);
    assert.deepEqual(next, { nis: start.nis, nif: entry("verified", DOCS.nif) });
  });

  it("doesn't mutate its input", () => {
    const start = { nif: entry("verified", DOCS.nif) };
    const copy = structuredClone(start);
    markReviewed(start, DOCS, "nif", "rejected", "x", STAFF, LATER);
    assert.deepEqual(start, copy);
  });

  it("leaves a missing document alone", () => {
    assert.deepEqual(markReviewed({}, { nif: " " }, "nif", "verified", null, STAFF, NOW), {});
  });

  it("survives a malformed review", () => {
    assert.deepEqual(markReviewed("garbage", DOCS, "nis", "verified", null, STAFF, NOW), {
      nis: entry("verified", DOCS.nis),
    });
  });
});

describe("verifyAllPresent (store approval)", () => {
  it("verifies every document present, pending or rejected", () => {
    const start = { nis: entry("rejected", DOCS.nis, "Expired") };
    const next = verifyAllPresent(start, { ...DOCS, commercial_register_back_url: "" }, "staff-2", LATER);
    const s = documentsStatus({ ...DOCS, commercial_register_back_url: "" }, next);
    assert.equal(s.commercial_register_front.status, "verified");
    assert.equal(s.commercial_register_back.status, "missing");
    assert.equal(s.nif.status, "verified");
    assert.deepEqual(next.nis, { status: "verified", reason: null, value: DOCS.nis, reviewed_at: LATER, reviewed_by: "staff-2" });
    assert.equal(next.commercial_register_back, undefined);
  });

  it("keeps the original verdict of a document already verified in its current form", () => {
    const next = verifyAllPresent(ALL_VERIFIED, { ...DOCS, nif: "new" }, "staff-2", LATER);
    assert.deepEqual(next.nis, ALL_VERIFIED.nis);
    assert.equal(next.nif?.value, "new");
    assert.equal(next.nif?.reviewed_by, "staff-2");
  });

  it("is empty for a store without documents", () => {
    assert.deepEqual(verifyAllPresent(null, null, STAFF, NOW), {});
  });
});

describe("withDocumentsStatus (merchant store response)", () => {
  it("replaces the raw review (staff ids) by the computed status", () => {
    const row = { id: "s1", name: "Kouba", documents: DOCS, document_review: ALL_VERIFIED };
    const out = withDocumentsStatus(row);
    assert.equal("document_review" in out, false);
    assert.equal(JSON.stringify(out).includes(STAFF), false);
    assert.equal(out.documents_status.all_verified, true);
    assert.equal(out.name, "Kouba");
  });

  it("shows a re-uploaded document as pending (no reset needed)", () => {
    // Staff verified everything, then the merchant uploaded a new front scan
    // (PATCH /merchant/stores/{id} only rewrites `documents`).
    const row = {
      documents: { ...DOCS, commercial_register_front_url: "https://cdn/front-v2.jpg" },
      document_review: ALL_VERIFIED,
    };
    const { documents_status } = withDocumentsStatus(row);
    assert.deepEqual(documents_status.commercial_register_front, { status: "pending", reason: null });
    assert.equal(documents_status.commercial_register_back.status, "verified");
    assert.equal(documents_status.all_verified, false);
  });

  it("copes with a row predating the column", () => {
    const { documents_status } = withDocumentsStatus({ documents: DOCS });
    assert.equal(documents_status.nif.status, "pending");
  });
});

describe("resolveStoreDocumentReview", () => {
  const REVIEWER = { id: STAFF, now: NOW };
  const store = (document_review: unknown = {}, documents: unknown = DOCS) => ({ documents, document_review });

  it("verifies a pending document", () => {
    const r = resolveStoreDocumentReview(store(), { document: "nif", status: "verified" }, REVIEWER);
    assert.deepEqual(r, { ok: true, review: { nif: entry("verified", DOCS.nif) }, notify: null });
  });

  it("rejects with the trimmed reason and tells the owner", () => {
    const r = resolveStoreDocumentReview(
      store(),
      { document: "commercial_register_back", status: "rejected", reason: "  Blurry " },
      REVIEWER
    );
    assert.deepEqual(r, {
      ok: true,
      review: { commercial_register_back: entry("rejected", DOCS.commercial_register_back_url, "Blurry") },
      notify: "store_document_rejected",
    });
  });

  it("needs a reason to reject", () => {
    for (const reason of [undefined, null, "", "   "]) {
      const r = resolveStoreDocumentReview(store(), { document: "nif", status: "rejected", reason }, REVIEWER);
      assert.equal(!r.ok && r.status, 400);
      assert.equal(!r.ok && r.code, "note_required");
    }
  });

  it("refuses a document the store hasn't provided (document_missing)", () => {
    const r = resolveStoreDocumentReview(store({}, { ...DOCS, nis: " " }), { document: "nis", status: "verified" }, REVIEWER);
    assert.equal(!r.ok && r.status, 400);
    assert.equal(!r.ok && r.code, "document_missing");
  });

  it("refuses when the document changed since the reviewer saw it (stale)", () => {
    const r = resolveStoreDocumentReview(
      store(),
      { document: "nif", status: "verified", expected_value: "000016000000000" },
      REVIEWER
    );
    assert.equal(!r.ok && r.status, 409);
    assert.equal(!r.ok && r.code, "stale");
    const ok = resolveStoreDocumentReview(
      store(),
      { document: "nif", status: "verified", expected_value: ` ${DOCS.nif} ` },
      REVIEWER
    );
    assert.ok(ok.ok && ok.review);
  });

  it("changes nothing on the same verdict for the same value", () => {
    const verified = resolveStoreDocumentReview(store(ALL_VERIFIED), { document: "nif", status: "verified" }, REVIEWER);
    assert.deepEqual(verified, { ok: true, review: null, notify: null });
    const rejected = resolveStoreDocumentReview(
      store({ nif: entry("rejected", DOCS.nif, "Wrong number") }),
      { document: "nif", status: "rejected", reason: " Wrong number " },
      REVIEWER
    );
    assert.deepEqual(rejected, { ok: true, review: null, notify: null });
  });

  it("records a new reason on an already rejected document", () => {
    const r = resolveStoreDocumentReview(
      store({ nif: entry("rejected", DOCS.nif, "Wrong number") }),
      { document: "nif", status: "rejected", reason: "Expired" },
      REVIEWER
    );
    assert.ok(r.ok && r.review);
    assert.equal(r.review.nif?.reason, "Expired");
    assert.equal(r.notify, "store_document_rejected");
  });

  it("reviews a re-uploaded document again (the old verdict was on another value)", () => {
    const r = resolveStoreDocumentReview(
      store(ALL_VERIFIED, { ...DOCS, nif: "000016009999999" }),
      { document: "nif", status: "verified" },
      REVIEWER
    );
    assert.ok(r.ok && r.review);
    assert.equal(r.review.nif?.value, "000016009999999");
    assert.equal(r.notify, "store_documents_verified");
  });

  it("tells the owner when this verdict makes every document verified", () => {
    const { nis: _nis, ...threeVerified } = ALL_VERIFIED;
    const r = resolveStoreDocumentReview(store(threeVerified), { document: "nis", status: "verified" }, REVIEWER);
    assert.ok(r.ok);
    assert.equal(r.notify, "store_documents_verified");
    // From a rejection too.
    const fromRejected = resolveStoreDocumentReview(
      store({ ...threeVerified, nis: entry("rejected", DOCS.nis, "Expired") }),
      { document: "nis", status: "verified" },
      REVIEWER
    );
    assert.equal(fromRejected.ok && fromRejected.notify, "store_documents_verified");
  });

  it("stays silent on a verification while other documents still wait", () => {
    const r = resolveStoreDocumentReview(store({}), { document: "nis", status: "verified" }, REVIEWER);
    assert.equal(r.ok && r.notify, null);
  });

  it("asks for the reason before anything else", () => {
    const r = resolveStoreDocumentReview(
      store({}, {}),
      { document: "nif", status: "rejected", expected_value: "other" },
      REVIEWER
    );
    assert.equal(!r.ok && r.code, "note_required");
  });
});
