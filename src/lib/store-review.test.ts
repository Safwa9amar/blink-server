import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storeOpenState } from "./store-categories";
import { documentsStatus } from "./store-documents";
import {
  onStoreHold,
  resolveStaffStoreReview,
  resolveStoreResubmit,
  type StaffStoreReview,
  type StoreReviewState,
} from "./store-review";

const AT = "2026-10-10T12:00:00.123456+00:00";

const store = (over: Partial<StoreReviewState> = {}): StoreReviewState => ({
  status: "under_review",
  review_note: null,
  updated_at: AT,
  ...over,
});

/** The owner has no pending / completed account deletion request. */
const STAYING = { leaving: false };
const LEAVING = { leaving: true };
const REVIEWER = { id: "staff-1", now: "2026-10-10T13:00:00.000Z" };

const review = (current: StoreReviewState, body: StaffStoreReview) =>
  resolveStaffStoreReview(current, body, STAYING, REVIEWER);

/** Approval columns of a store without documents (nothing to verify). */
const APPROVED = { status: "active", is_open: true, manual_override: false, review_note: null, document_review: {} };

describe("onStoreHold", () => {
  it("is a staff rejection / deactivation: inactive with a note", () => {
    assert.equal(onStoreHold(store({ status: "inactive", review_note: "Blurry" })), true);
    assert.equal(onStoreHold(store({ status: "inactive", review_note: "  " })), false);
    assert.equal(onStoreHold(store({ status: "inactive", review_note: null })), false);
    assert.equal(onStoreHold(store({ status: "under_review", review_note: "Blurry" })), false);
  });
});

describe("resolveStaffStoreReview — approve", () => {
  it("approves a store waiting for review: open, note cleared", () => {
    assert.deepEqual(review(store(), { status: "active" }), {
      ok: true,
      columns: APPROVED,
      kind: "store_approved",
    });
  });

  it("approves a resubmitted store and clears the earlier reason", () => {
    const r = review(store({ review_note: "Blurry" }), { status: "active" });
    assert.deepEqual(r, { ok: true, columns: APPROVED, kind: "store_approved" });
  });

  it("re-approves a rejected / deactivated store (inactive with a note)", () => {
    const r = review(store({ status: "inactive", review_note: "Blurry" }), { status: "active" });
    assert.deepEqual(r, { ok: true, columns: APPROVED, kind: "store_approved" });
  });

  it("refuses a store hidden for another reason (inactive, no note)", () => {
    const r = review(store({ status: "inactive", review_note: null }), { status: "active" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 409);
    assert.equal(!r.ok && r.code, "invalid_state");
  });

  it("changes nothing on a store that is already live", () => {
    assert.deepEqual(review(store({ status: "active" }), { status: "active" }), {
      ok: true,
      columns: null,
      kind: null,
    });
  });

  it("ignores a note sent with an approval", () => {
    const r = review(store(), { status: "active", note: "Looks good" });
    assert.ok(r.ok);
    assert.equal(r.columns?.review_note, null);
  });
});

describe("resolveStaffStoreReview — reject / deactivate", () => {
  it("needs a note", () => {
    for (const note of [undefined, null, "", "   "]) {
      const r = review(store(), { status: "inactive", note });
      assert.equal(!r.ok && r.status, 400);
      assert.equal(!r.ok && r.code, "note_required");
    }
  });

  it("rejects a store waiting for review with the trimmed note, closed", () => {
    assert.deepEqual(review(store(), { status: "inactive", note: "  Blurry scan " }), {
      ok: true,
      columns: { status: "inactive", is_open: false, review_note: "Blurry scan" },
      kind: "store_rejected",
    });
  });

  it("deactivates a live store", () => {
    const r = review(store({ status: "active" }), { status: "inactive", note: "Expired register" });
    assert.deepEqual(r, {
      ok: true,
      columns: { status: "inactive", is_open: false, review_note: "Expired register" },
      kind: "store_deactivated",
    });
  });

  it("changes nothing when the store is already off with the same note", () => {
    const r = review(store({ status: "inactive", review_note: "Blurry" }), {
      status: "inactive",
      note: " Blurry ",
    });
    assert.deepEqual(r, { ok: true, columns: null, kind: null });
  });

  it("refuses a store already off for another reason or with another note", () => {
    for (const review_note of [null, "Blurry"]) {
      const r = review(store({ status: "inactive", review_note }), {
        status: "inactive",
        note: "Something else",
      });
      assert.equal(!r.ok && r.status, 409);
      assert.equal(!r.ok && r.code, "invalid_state");
    }
  });
});

describe("resolveStaffStoreReview — what the reviewer saw", () => {
  it("accepts the same instant in another format", () => {
    const r = review(store(), {
      status: "active",
      expected_updated_at: "2026-10-10T12:00:00.123Z",
    });
    assert.ok(r.ok);
  });

  it("refuses when the store changed since (stale)", () => {
    const r = review(store(), { status: "active", expected_updated_at: "2000-01-01T00:00:00Z" });
    assert.equal(!r.ok && r.status, 409);
    assert.equal(!r.ok && r.code, "stale");
  });

  it("asks for the note before checking staleness", () => {
    const r = review(store(), { status: "inactive", expected_updated_at: "2000-01-01T00:00:00Z" });
    assert.equal(!r.ok && r.code, "note_required");
  });
});

describe("resolveStaffStoreReview — owner leaving Blink", () => {
  it("refuses any approval (owner_leaving), even a stale one", () => {
    for (const s of [
      store(),
      store({ review_note: "Blurry" }),
      store({ status: "inactive", review_note: "Blurry" }),
      store({ status: "inactive", review_note: null }),
      store({ status: "active" }),
    ]) {
      for (const expected_updated_at of [undefined, "2000-01-01T00:00:00Z"]) {
        const r = resolveStaffStoreReview(s, { status: "active", expected_updated_at }, LEAVING, REVIEWER);
        assert.equal(!r.ok && r.status, 409, `${s.status}/${s.review_note}`);
        assert.equal(!r.ok && r.code, "owner_leaving");
      }
    }
  });

  it("still lets staff reject a store in review or deactivate a live one", () => {
    const rejected = resolveStaffStoreReview(
      store(),
      { status: "inactive", note: "Owner leaving" },
      LEAVING,
      REVIEWER
    );
    assert.deepEqual(rejected, {
      ok: true,
      columns: { status: "inactive", is_open: false, review_note: "Owner leaving" },
      kind: "store_rejected",
    });
    const deactivated = resolveStaffStoreReview(
      store({ status: "active" }),
      { status: "inactive", note: "Owner leaving" },
      LEAVING,
      REVIEWER
    );
    assert.equal(deactivated.ok && deactivated.kind, "store_deactivated");
  });

  it("still asks for the note first", () => {
    const r = resolveStaffStoreReview(store(), { status: "inactive" }, LEAVING, REVIEWER);
    assert.equal(!r.ok && r.code, "note_required");
  });
});

describe("resolveStaffStoreReview — approval and the opening hours", () => {
  // Every day 08:00–20:00; 2026-10-10 is a Saturday, Algiers = UTC+1.
  const shifts = [{ open: "08:00", close: "20:00" }];
  const hours = Object.fromEntries(
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { enabled: true, shifts }])
  );
  const NOON = new Date("2026-10-10T11:00:00Z");
  const NIGHT = new Date("2026-10-10T22:00:00Z");

  it("drops the merchant's manual override so the store follows its hours", () => {
    const r = review(store(), { status: "active" });
    assert.ok(r.ok && r.columns);
    // Before: the merchant had forced it closed.
    const before = { hours, is_open: false, manual_override: true };
    const approved = { ...before, ...r.columns };
    assert.equal(storeOpenState(approved, NOON).is_open, true);
    assert.equal(storeOpenState(approved, NIGHT).is_open, false);
    assert.ok(storeOpenState(approved, NIGHT).next_open_at);
  });

  it("opens a store without hours (is_open decides)", () => {
    const r = review(store(), { status: "active" });
    assert.ok(r.ok && r.columns);
    const before = { hours: null, is_open: false, manual_override: true };
    const approved = { ...before, ...r.columns };
    assert.equal(storeOpenState(approved, NIGHT).is_open, true);
  });

  it("leaves the override alone on a rejection / deactivation", () => {
    const r = review(store({ status: "active" }), { status: "inactive", note: "Expired register" });
    assert.ok(r.ok && r.columns);
    assert.equal("manual_override" in r.columns, false);
  });
});

describe("resolveStaffStoreReview — the store's documents", () => {
  const DOCS = {
    commercial_register_front_url: "https://cdn/front.jpg",
    commercial_register_back_url: "https://cdn/back.jpg",
    nif: "000016001234567",
    nis: "",
  };
  const earlier = {
    status: "verified" as const,
    reason: null,
    value: "https://cdn/front.jpg",
    reviewed_at: "2026-10-01T00:00:00.000Z",
    reviewed_by: "staff-0",
  };

  it("approving verifies every document present — what the reviewer saw", () => {
    const r = review(
      store({
        documents: DOCS,
        document_review: {
          commercial_register_front: earlier,
          nif: { ...earlier, status: "rejected", reason: "Wrong", value: DOCS.nif },
        },
      }),
      { status: "active", expected_updated_at: AT }
    );
    assert.ok(r.ok && r.columns);
    const stamp = { status: "verified", reason: null, reviewed_at: REVIEWER.now, reviewed_by: "staff-1" };
    assert.deepEqual(r.columns.document_review, {
      // Already verified in this form: keeps who / when.
      commercial_register_front: earlier,
      commercial_register_back: { ...stamp, value: DOCS.commercial_register_back_url },
      nif: { ...stamp, value: DOCS.nif },
      // NIS missing: nothing to verify.
    });
    assert.equal(documentsStatus(DOCS, r.columns.document_review).nis.status, "missing");
  });

  it("re-approving a rejected store verifies its current documents", () => {
    const r = review(store({ status: "inactive", review_note: "Blurry", documents: DOCS }), { status: "active" });
    assert.ok(r.ok && r.columns);
    assert.equal(documentsStatus(DOCS, r.columns.document_review).nif.status, "verified");
  });

  it("rejecting / deactivating leaves the document verdicts alone", () => {
    for (const status of ["under_review", "active"] as const) {
      const r = review(store({ status, documents: DOCS, document_review: { commercial_register_front: earlier } }), {
        status: "inactive",
        note: "Expired register",
      });
      assert.ok(r.ok && r.columns);
      assert.equal("document_review" in r.columns, false, status);
    }
  });

  it("writes nothing on a store that is already live", () => {
    const r = review(store({ status: "active", documents: DOCS }), { status: "active" });
    assert.deepEqual(r, { ok: true, columns: null, kind: null });
  });
});

describe("resolveStoreResubmit", () => {
  it("sends a rejected / deactivated store back to review, closed, keeping the note", () => {
    const r = resolveStoreResubmit(store({ status: "inactive", review_note: "Blurry" }), STAYING);
    assert.deepEqual(r, { ok: true, columns: { status: "under_review", is_open: false } });
  });

  it("refuses any other store", () => {
    for (const s of [
      store({ status: "active" }),
      store({ status: "under_review" }),
      store({ status: "under_review", review_note: "Blurry" }),
      store({ status: "inactive", review_note: null }),
      store({ status: "inactive", review_note: " " }),
    ]) {
      const r = resolveStoreResubmit(s, STAYING);
      assert.equal(!r.ok && r.status, 409, `${s.status}/${s.review_note}`);
      assert.equal(!r.ok && r.code, "invalid_state");
    }
  });

  it("refuses any store while the merchant is leaving Blink (owner_leaving)", () => {
    for (const s of [
      store({ status: "inactive", review_note: "Blurry" }),
      store({ status: "inactive", review_note: null }),
      store({ status: "under_review" }),
      store({ status: "active" }),
    ]) {
      const r = resolveStoreResubmit(s, LEAVING);
      assert.equal(!r.ok && r.status, 409, `${s.status}/${s.review_note}`);
      assert.equal(!r.ok && r.code, "owner_leaving");
    }
  });
});

describe("merchant store update body", () => {
  it("can't carry the review state (status / review_note)", async () => {
    const { updateMerchantStoreSchema } = await import("../validators/merchant");
    const parsed = updateMerchantStoreSchema.parse({ name: "Kouba", status: "active", review_note: null, is_open: true });
    assert.deepEqual(parsed, { name: "Kouba", is_open: true });
  });

  it("can't carry Blink's document verdicts (document_review / documents_status)", async () => {
    const { createMerchantStoreSchema, updateMerchantStoreSchema } = await import("../validators/merchant");
    const forged = {
      document_review: { nif: { status: "verified", value: "1", reason: null, reviewed_at: "x", reviewed_by: null } },
      documents_status: { all_verified: true },
    };
    assert.deepEqual(updateMerchantStoreSchema.parse({ documents: { nif: "1" }, ...forged }), {
      documents: { nif: "1" },
    });
    assert.deepEqual(createMerchantStoreSchema.parse({ name: "Kouba", ...forged }), { name: "Kouba" });
  });
});
