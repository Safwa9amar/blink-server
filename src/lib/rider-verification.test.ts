import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReview,
  applyUploads,
  applyVerificationRequest,
  statusAfterVerificationRequest,
  deriveVerificationStatus,
  hasPendingDocuments,
  isOwnDocumentPath,
  requiredDocumentKeys,
  reviewNoticeKind,
  RIDER_DOCUMENT_KEYS,
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
  gray_card_front: doc(status),
  gray_card_back: doc(status),
  insurance: doc(status),
});
const state = (
  documents: RiderStoredDocuments,
  verification_status: RiderVerificationState["verification_status"] = "not_submitted"
): RiderVerificationState => ({ documents, verification_status });

describe("deriveVerificationStatus", () => {
  it("is not_submitted until all seven documents exist", () => {
    assert.equal(deriveVerificationStatus({ license_front: doc("pending") }, "not_submitted"), "not_submitted");
  });
  it("is pending once all seven exist and none is rejected", () => {
    assert.equal(deriveVerificationStatus(all("pending"), "not_submitted"), "pending");
  });
  it("is rejected as soon as one document is rejected", () => {
    assert.equal(deriveVerificationStatus({ ...all("verified"), id_back: doc("rejected") }, "approved"), "rejected");
  });
  it("is approved when all seven are verified", () => {
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
  it("moves to pending when the last required document arrives", () => {
    const { insurance: _omit, ...six } = all("pending");
    const next = applyUploads(state(six), { insurance: "u1/insurance/9-9.jpg" }, NOW);
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

describe("review audit fields", () => {
  it("records reviewer on a decision and uploads clear it", () => {
    const before = state(all("pending"), "pending");
    const res = applyReview(before, "id_front", {
      status: "verified",
      path: doc("pending").path,
      reviewer: { id: "staff1", at: NOW },
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.documents.id_front?.reviewed_by, "staff1");
    assert.equal(res.state.documents.id_front?.reviewed_at, NOW);
    const up = applyUploads(res.state, { id_front: "u1/id_front/9-9.jpg" }, NOW);
    assert.equal(up.documents.id_front?.reviewed_by, undefined);
    assert.equal(up.documents.id_front?.reviewed_at, undefined);
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
        ["vehicle_documents", "missing_info", ["gray_card_front", "gray_card_back", "insurance"]],
        ["verification", "missing_info", [...RIDER_DOCUMENT_KEYS]],
      ]
    );
    assert.equal(res.completed, 0);
    assert.equal(res.total, 5);
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
      ["done", "in_progress", "in_progress", "in_progress", "in_progress"]
    );
    assert.equal(res.completed, 1);
  });
  it("does not nag a migrated approved rider about missing documents", () => {
    const res = riderRequiredActions({ vehicleType: "motorcycle", documents: {}, verificationStatus: "approved" });
    assert.ok(res.actions.every((a) => a.status === "done"));
    assert.equal(res.completed, 5);
  });
  it("tells an approved motorcycle rider with identity docs only to upload the vehicle papers", () => {
    const res = riderRequiredActions({
      vehicleType: "motorcycle",
      documents: { license_front: doc("verified"), license_back: doc("verified"), id_front: doc("verified"), id_back: doc("verified") },
      verificationStatus: "approved",
    });
    // Approved riders are not nagged (grace period), same as the other actions.
    assert.equal(res.actions.find((a) => a.key === "vehicle_documents")!.status, "done");
  });
  it("motorcycle missing insurance -> vehicle_documents missing_info", () => {
    const { insurance: _omit, ...six } = all("pending");
    const res = riderRequiredActions({ vehicleType: "motorcycle", documents: six, verificationStatus: "not_submitted" });
    const a = res.actions.find((x) => x.key === "vehicle_documents")!;
    assert.deepEqual([a.status, a.missing, a.reason], ["missing_info", ["insurance"], null]);
  });
  it("rejected insurance -> vehicle_documents rejected with the staff note", () => {
    const res = riderRequiredActions({
      vehicleType: "motorcycle",
      documents: { ...all("pending"), insurance: doc("rejected", "Expired") },
      verificationStatus: "rejected",
    });
    const a = res.actions.find((x) => x.key === "vehicle_documents")!;
    assert.deepEqual([a.status, a.missing, a.reason], ["rejected", [], "Expired"]);
    assert.deepEqual(res.actions.find((x) => x.key === "verification")!.missing, ["insurance"]);
  });
  it("bicycle has no vehicle_documents action", () => {
    const res = riderRequiredActions({ vehicleType: "bicycle", documents: {}, verificationStatus: "not_submitted" });
    assert.ok(!res.actions.some((a) => a.key === "vehicle_documents"));
  });
});

describe("vehicle documents (gray card + insurance)", () => {
  const identity = (status: RiderStoredDocument["status"]): RiderStoredDocuments => ({
    license_front: doc(status),
    license_back: doc(status),
    id_front: doc(status),
    id_back: doc(status),
  });
  it("requires all seven keys for motorcycle, unknown and other types", () => {
    assert.deepEqual(requiredDocumentKeys("motorcycle"), [...RIDER_DOCUMENT_KEYS]);
    assert.deepEqual(requiredDocumentKeys(null), [...RIDER_DOCUMENT_KEYS]);
    assert.ok(requiredDocumentKeys("motorcycle").includes("insurance"));
  });
  it("an approved rider missing vehicle docs stays approved", () => {
    assert.equal(deriveVerificationStatus(identity("verified"), "approved", "motorcycle"), "approved");
    assert.equal(deriveVerificationStatus({}, "approved", "motorcycle"), "approved");
  });
  it("a new motorcycle rider with only identity docs verified is not approved", () => {
    assert.equal(deriveVerificationStatus(identity("verified"), "not_submitted", "motorcycle"), "not_submitted");
    assert.equal(deriveVerificationStatus(identity("verified"), "pending", "motorcycle"), "not_submitted");
  });
  it("a rejected insurance gives rejected, even for an approved rider", () => {
    assert.equal(deriveVerificationStatus({ ...all("verified"), insurance: doc("rejected") }, "approved", "motorcycle"), "rejected");
  });
  it("a bicycle rider ignores a rejected insurance", () => {
    const id = { id_front: doc("verified"), id_back: doc("verified"), insurance: doc("rejected") };
    assert.equal(deriveVerificationStatus(id, "pending", "bicycle"), "approved");
  });
  it("isOwnDocumentPath accepts the new keys", () => {
    assert.equal(isOwnDocumentPath("u1", "insurance", "u1/insurance/1-2.pdf"), true);
    assert.equal(isOwnDocumentPath("u1", "gray_card_front", "u1/gray_card_back/1-2.jpg"), false);
  });
});

describe("bicycle riders (national ID only)", () => {
  const id = (status: RiderStoredDocument["status"]): RiderStoredDocuments => ({ id_front: doc(status), id_back: doc(status) });
  it("requiredDocumentKeys", () => {
    assert.deepEqual(requiredDocumentKeys("bicycle"), ["id_front", "id_back"]);
    assert.equal(requiredDocumentKeys("motorcycle").length, 7);
    assert.equal(requiredDocumentKeys(null).length, 7);
    assert.equal(requiredDocumentKeys(undefined).length, 7);
  });
  it("is pending with only the ID uploaded, approved once verified", () => {
    assert.equal(deriveVerificationStatus(id("pending"), "not_submitted", "bicycle"), "pending");
    assert.equal(deriveVerificationStatus(id("verified"), "pending", "bicycle"), "approved");
    assert.equal(deriveVerificationStatus(id("pending"), "not_submitted", "motorcycle"), "not_submitted");
  });
  it("is not_submitted with one ID side, rejected on a rejected ID", () => {
    assert.equal(deriveVerificationStatus({ id_front: doc("pending") }, "not_submitted", "bicycle"), "not_submitted");
    assert.equal(deriveVerificationStatus({ ...id("verified"), id_back: doc("rejected") }, "approved", "bicycle"), "rejected");
  });
  it("ignores a rejected licence", () => {
    assert.equal(deriveVerificationStatus({ ...id("verified"), license_front: doc("rejected") }, "pending", "bicycle"), "approved");
  });
  it("applyUploads moves to pending with just the ID", () => {
    const next = applyUploads(state({}), { id_front: "u1/id_front/1-1.jpg", id_back: "u1/id_back/1-1.jpg" }, NOW, "bicycle");
    assert.equal(next.verification_status, "pending");
  });
  it("applyReview approves on the last ID verification", () => {
    const res = applyReview(state({ id_front: doc("verified"), id_back: doc("pending") }, "pending"), "id_back",
      { status: "verified", path: doc("pending").path }, "bicycle");
    assert.ok(res.ok && res.state.verification_status === "approved");
  });
  it("checklist has no driving_license and lists only ID keys", () => {
    const r = riderRequiredActions({ vehicleType: "bicycle", documents: {}, verificationStatus: "not_submitted" });
    assert.deepEqual(r.actions.map((a) => a.key), ["vehicle_type", "national_id", "verification"]);
    assert.deepEqual(r.actions[2].missing, ["id_front", "id_back"]);
    assert.deepEqual(r.required_documents, ["id_front", "id_back"]);
    assert.equal(r.total, 3);
  });
  it("motorcycle checklist keeps all seven documents", () => {
    const r = riderRequiredActions({ vehicleType: "motorcycle", documents: {}, verificationStatus: "not_submitted" });
    assert.equal(r.actions.length, 5);
    assert.equal(r.required_documents.length, 7);
  });
});

describe("applyVerificationRequest", () => {
  it("rejects uploaded docs with note + reviewer, lists missing, leaves others", () => {
    const docs: RiderStoredDocuments = { id_front: doc("verified"), insurance: doc("verified") };
    const r = applyVerificationRequest(docs, ["insurance", "gray_card_front"], "Expired", "staff1", NOW);
    assert.deepEqual(r.invalidated, ["insurance"]);
    assert.deepEqual(r.missing, ["gray_card_front"]);
    assert.equal(r.documents.insurance?.status, "rejected");
    assert.equal(r.documents.insurance?.note, "Expired");
    assert.equal(r.documents.insurance?.reviewed_by, "staff1");
    assert.equal(r.documents.insurance?.reviewed_at, NOW);
    assert.equal(r.documents.gray_card_front, undefined);
    assert.deepEqual(r.documents.id_front, docs.id_front);
  });

  it("approved rider with all verified, requesting insurance -> rejected", () => {
    const r = applyVerificationRequest(all("verified"), ["insurance"], "n", "s", NOW);
    assert.equal(statusAfterVerificationRequest(r.documents, "motorcycle"), "rejected");
  });

  it("approved rider missing vehicle docs, requesting gray_card_front -> not_submitted", () => {
    const docs: RiderStoredDocuments = {
      license_front: doc("verified"),
      license_back: doc("verified"),
      id_front: doc("verified"),
      id_back: doc("verified"),
    };
    const r = applyVerificationRequest(docs, ["gray_card_front"], "n", "s", NOW);
    assert.equal(statusAfterVerificationRequest(r.documents, "motorcycle"), "not_submitted");
  });
});
