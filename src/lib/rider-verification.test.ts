import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReview,
  applyUploads,
  deriveVerificationStatus,
  isOwnDocumentPath,
  reviewNoticeKind,
  riderRequiredActions,
  type RiderStoredDocument,
  type RiderStoredDocuments,
  type RiderVerificationState,
} from "./rider-verification";

const NOW = "2026-10-10T12:00:00.000Z";
const doc = (status: RiderStoredDocument["status"], note: string | null = null): RiderStoredDocument => ({
  path: `u1/x/${status}.jpg`,
  status,
  note,
  uploaded_at: "2026-10-01T00:00:00.000Z",
});
const all = (status: RiderStoredDocument["status"]): RiderStoredDocuments => ({
  license_front: doc(status),
  license_back: doc(status),
  id_front: doc(status),
  id_back: doc(status),
});
const state = (
  documents: RiderStoredDocuments,
  verification_status: RiderVerificationState["verification_status"] = "not_submitted"
): RiderVerificationState => ({ documents, verification_status });

describe("deriveVerificationStatus", () => {
  it("is not_submitted until all four documents exist", () => {
    assert.equal(deriveVerificationStatus({ license_front: doc("pending") }, "not_submitted"), "not_submitted");
  });
  it("is pending once all four exist and none is rejected", () => {
    assert.equal(deriveVerificationStatus(all("pending"), "not_submitted"), "pending");
  });
  it("is rejected as soon as one document is rejected", () => {
    assert.equal(deriveVerificationStatus({ ...all("verified"), id_back: doc("rejected") }, "approved"), "rejected");
  });
  it("is approved when all four are verified", () => {
    assert.equal(deriveVerificationStatus(all("verified"), "pending"), "approved");
  });
  it("keeps an approved rider approved while a replacement is pending", () => {
    assert.equal(deriveVerificationStatus({ license_front: doc("pending") }, "approved"), "approved");
  });
});

describe("applyUploads", () => {
  it("stores a new document as pending with no note", () => {
    const next = applyUploads(state({}), { license_front: "u1/license_front/1.jpg" }, NOW);
    assert.deepEqual(next.documents.license_front, {
      path: "u1/license_front/1.jpg",
      status: "pending",
      note: null,
      uploaded_at: NOW,
    });
    assert.equal(next.verification_status, "not_submitted");
  });
  it("moves to pending when the fourth document arrives", () => {
    const three = { license_front: doc("pending"), license_back: doc("pending"), id_front: doc("pending") };
    const next = applyUploads(state(three), { id_back: "u1/id_back/9.jpg" }, NOW);
    assert.equal(next.verification_status, "pending");
  });
  it("a re-upload of a rejected document resets it and the rider to pending", () => {
    const before = state({ ...all("pending"), license_back: doc("rejected", "Too blurry") }, "rejected");
    const next = applyUploads(before, { license_back: "u1/license_back/2.jpg" }, NOW);
    assert.equal(next.documents.license_back?.status, "pending");
    assert.equal(next.documents.license_back?.note, null);
    assert.equal(next.verification_status, "pending");
  });
  it("ignores a path that is already stored (no reset)", () => {
    const before = state(all("verified"), "approved");
    const next = applyUploads(before, { id_front: before.documents.id_front!.path }, NOW);
    assert.deepEqual(next, before);
  });
  it("a migrated approved rider uploading one document stays approved", () => {
    const next = applyUploads(state({}, "approved"), { license_front: "u1/license_front/3.jpg" }, NOW);
    assert.equal(next.verification_status, "approved");
  });
});

describe("applyReview", () => {
  it("refuses a document that was never uploaded", () => {
    assert.deepEqual(applyReview(state({}), "id_front", { status: "verified" }), {
      ok: false,
      error: "not_uploaded",
    });
  });
  it("verifying the last pending document approves the rider", () => {
    const before = state({ ...all("verified"), id_back: doc("pending") }, "pending");
    const res = applyReview(before, "id_back", { status: "verified", note: "ignored" });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.verification_status, "approved");
    assert.equal(res.state.documents.id_back?.note, null);
  });
  it("rejecting a document rejects the rider and keeps the trimmed note", () => {
    const res = applyReview(state(all("pending"), "pending"), "license_front", {
      status: "rejected",
      note: "  Photo is blurry  ",
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.verification_status, "rejected");
    assert.equal(res.state.documents.license_front?.note, "Photo is blurry");
  });
  it("rejecting an approved rider's document revokes the approval", () => {
    const res = applyReview(state(all("verified"), "approved"), "id_front", { status: "rejected" });
    assert.equal(res.ok && res.state.verification_status, "rejected");
  });
});

describe("reviewNoticeKind", () => {
  it("tells the rider about a rejection", () => {
    assert.equal(reviewNoticeKind("pending", "rejected", "rejected"), "document_rejected");
  });
  it("announces the approval once", () => {
    assert.equal(reviewNoticeKind("pending", "approved", "verified"), "approved");
    assert.equal(reviewNoticeKind("approved", "approved", "verified"), "document_verified");
  });
  it("otherwise reports a verified document", () => {
    assert.equal(reviewNoticeKind("pending", "pending", "verified"), "document_verified");
  });
});

describe("isOwnDocumentPath", () => {
  it("accepts a path in the rider's folder only", () => {
    assert.equal(isOwnDocumentPath("u1", "u1/license_front/1.jpg"), true);
    assert.equal(isOwnDocumentPath("u1", "u2/license_front/1.jpg"), false);
    assert.equal(isOwnDocumentPath("u1", "u1/../u2/a.jpg"), false);
    assert.equal(isOwnDocumentPath("u1", "u1"), false);
  });
});

describe("riderRequiredActions", () => {
  it("lists everything for a brand-new rider", () => {
    const res = riderRequiredActions({ vehicleType: null, documents: {}, verificationStatus: "not_submitted" });
    assert.deepEqual(
      res.actions.map((a) => [a.key, a.status, a.missing]),
      [
        ["vehicle_type", "missing_info", ["vehicle_type"]],
        ["driving_license", "missing_info", ["front", "back"]],
        ["national_id", "missing_info", ["front", "back"]],
        ["verification", "missing_info", ["license_front", "license_back", "id_front", "id_back"]],
      ]
    );
    assert.equal(res.completed, 0);
    assert.equal(res.total, 4);
    assert.equal(res.verification_status, "not_submitted");
  });
  it("shows the staff note of a rejected side", () => {
    const res = riderRequiredActions({
      vehicleType: "bicycle",
      documents: { ...all("pending"), id_front: doc("rejected", "Expired card") },
      verificationStatus: "rejected",
    });
    const id = res.actions.find((a) => a.key === "national_id")!;
    assert.equal(id.status, "rejected");
    assert.equal(id.reason, "Expired card");
    assert.deepEqual(res.actions.find((a) => a.key === "verification")!.missing, ["id_front"]);
  });
  it("is in progress while staff review", () => {
    const res = riderRequiredActions({ vehicleType: "motorcycle", documents: all("pending"), verificationStatus: "pending" });
    assert.deepEqual(
      res.actions.map((a) => a.status),
      ["done", "in_progress", "in_progress", "in_progress"]
    );
    assert.equal(res.completed, 1);
  });
  it("does not nag a migrated approved rider about missing documents", () => {
    const res = riderRequiredActions({ vehicleType: "motorcycle", documents: {}, verificationStatus: "approved" });
    assert.ok(res.actions.every((a) => a.status === "done"));
    assert.equal(res.completed, 4);
  });
});
