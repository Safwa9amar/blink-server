import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReview,
  applyUploads,
  deriveVerificationStatus,
  hasPendingDocuments,
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
    assert.deepEqual(applyReview(state({}), "id_front", { status: "verified", path: "p" }), {
      ok: false,
      error: "not_uploaded",
    });
  });
  it("verifying the last pending document approves the rider", () => {
    const before = state({ ...all("verified"), id_back: doc("pending") }, "pending");
    const res = applyReview(before, "id_back", { status: "verified", note: "ignored", path: before.documents.id_back!.path });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.verification_status, "approved");
    assert.equal(res.state.documents.id_back?.note, null);
  });
  it("rejecting a document rejects the rider and keeps the trimmed note", () => {
    const res = applyReview(state(all("pending"), "pending"), "license_front", {
      status: "rejected",
      note: "  Photo is blurry  ",
      path: doc("pending").path,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.verification_status, "rejected");
    assert.equal(res.state.documents.license_front?.note, "Photo is blurry");
  });
  it("rejecting an approved rider's document revokes the approval", () => {
    const res = applyReview(state(all("verified"), "approved"), "id_front", { status: "rejected", path: doc("verified").path });
    assert.equal(res.ok && res.state.verification_status, "rejected");
  });
});

describe("applyReview guards", () => {
  it("refuses a decision made on a replaced document (stale)", () => {
    const before = state(all("pending"), "pending");
    assert.deepEqual(applyReview(before, "id_front", { status: "verified", path: "u1/id_front/old.jpg" }), {
      ok: false,
      error: "stale",
    });
  });
  it("accepts a decision on the current path", () => {
    const before = state(all("pending"), "pending");
    const res = applyReview(before, "id_front", { status: "verified", path: before.documents.id_front!.path });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.unchanged, false);
  });
  it("flags a decision that changes nothing as unchanged", () => {
    const before = state(all("verified"), "approved");
    const res = applyReview(before, "id_front", { status: "verified", path: before.documents.id_front!.path });
    assert.equal(res.ok && res.unchanged, true);
    const rej = state({ ...all("pending"), id_back: doc("rejected", "Blurry") }, "rejected");
    const same = applyReview(rej, "id_back", { status: "rejected", note: " Blurry ", path: rej.documents.id_back!.path });
    assert.equal(same.ok && same.unchanged, true);
    const diff = applyReview(rej, "id_back", { status: "rejected", note: "Other", path: rej.documents.id_back!.path });
    assert.equal(diff.ok && diff.unchanged, false);
  });
});

describe("hasPendingDocuments", () => {
  it("is true when any stored document is pending", () => {
    assert.equal(hasPendingDocuments({ ...all("verified"), id_back: doc("pending") }), true);
    assert.equal(hasPendingDocuments(all("verified")), false);
    assert.equal(hasPendingDocuments({}), false);
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
  const U = "0b9c1f0e-1234-4abc-9def-0123456789ab";
  it("accepts exactly the shape the upload route produces", () => {
    assert.equal(isOwnDocumentPath(U, "license_front", `${U}/license_front/1760000000000-4242.jpg`), true);
    assert.equal(isOwnDocumentPath(U, "id_back", `${U}/id_back/1-0.pdf`), true);
    assert.equal(isOwnDocumentPath("u1", "id_front", "u1/id_front/12-34.webp"), true);
  });
  it("rejects anything else", () => {
    const bad = [
      `${U}/license_front/%2e%2e/x.jpg`,
      `${U}/license_front/%2E%2E-1.jpg`,
      `${U}/license_front/.%2e-1.jpg`,
      `${U}/license_front/./1-1.jpg`,
      `${U}/license_front/1-1.jpg?x=1`,
      `${U}/license_front/1-1.jpg#frag`,
      `/${U}/license_front/1-1.jpg`,
      `${U}/license_back/1-1.jpg`,
      `other/license_front/1-1.jpg`,
      `${U}/license_front/1-1.JPG`,
      `${U.toUpperCase()}/license_front/1-1.jpg`,
      `${U}/license_front/1-1.gif`,
      `${U}/license_front/a-1.jpg`,
      `${U}`,
    ];
    for (const p of bad) assert.equal(isOwnDocumentPath(U, "license_front", p), false, p);
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
