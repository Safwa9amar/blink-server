// Rider verification rules (Become a Partner piece 3). Pure — no DB — so the
// routes (riders/documents, riders/required-actions, riders/admin-review) only
// load a row, call these and write the result with the service role.
//
// rider_profiles.documents = { license_front, license_back, id_front, id_back,
// gray_card_front, gray_card_back, insurance },
// each { path, status: pending|verified|rejected, note, uploaded_at }; `path`
// is an object in the private `rider-documents` bucket ("<userId>/<key>/<file>").

export const RIDER_DOCUMENT_KEYS = [
  "license_front",
  "license_back",
  "id_front",
  "id_back",
  "gray_card_front",
  "gray_card_back",
  "insurance",
] as const;
export type RiderDocumentKey = (typeof RIDER_DOCUMENT_KEYS)[number];
export type RiderDocumentStatus = "pending" | "verified" | "rejected";

export const RIDER_VERIFICATION_STATUSES = ["not_submitted", "pending", "approved", "rejected"] as const;
export type RiderVerificationStatus = (typeof RIDER_VERIFICATION_STATUSES)[number];

export interface RiderStoredDocument {
  path: string;
  status: RiderDocumentStatus;
  /** Staff note, kept only on a rejection. */
  note: string | null;
  uploaded_at: string;
  /** Staff audit: who made the last verified/rejected decision, and when. Cleared by a new upload. */
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}
export type RiderStoredDocuments = Partial<Record<RiderDocumentKey, RiderStoredDocument>>;

export interface RiderVerificationState {
  documents: RiderStoredDocuments;
  verification_status: RiderVerificationStatus;
}

/**
 * Documents a rider must provide. A bicycle needs only the national ID; a
 * motorcycle (or an unknown vehicle) needs the ID, the driving licence and the
 * vehicle papers (gray card front/back + insurance certificate).
 */
export function requiredDocumentKeys(vehicleType: string | null | undefined): RiderDocumentKey[] {
  return vehicleType === "bicycle" ? ["id_front", "id_back"] : [...RIDER_DOCUMENT_KEYS];
}

/**
 * Overall status from the REQUIRED documents (see requiredDocumentKeys; other
 * stored documents are ignored). An approved rider stays approved while a
 * replacement waits for review (migrated riders have no documents at all):
 * only a staff rejection revokes an approval.
 */
export function deriveVerificationStatus(
  docs: RiderStoredDocuments,
  previous: RiderVerificationStatus,
  vehicleType?: string | null
): RiderVerificationStatus {
  const keys = requiredDocumentKeys(vehicleType);
  const present = keys.map((k) => docs[k]).filter((d): d is RiderStoredDocument => !!d);
  if (present.some((d) => d.status === "rejected")) return "rejected";
  if (present.length === keys.length && present.every((d) => d.status === "verified")) {
    return "approved";
  }
  if (previous === "approved") return "approved";
  if (present.length === keys.length) return "pending";
  return "not_submitted";
}

/** New uploads (PATCH /riders/documents): each changed path goes (back) to pending. */
export function applyUploads(
  state: RiderVerificationState,
  paths: Partial<Record<RiderDocumentKey, string>>,
  nowIso: string,
  vehicleType?: string | null
): RiderVerificationState {
  const documents: RiderStoredDocuments = { ...state.documents };
  let changed = false;
  for (const key of RIDER_DOCUMENT_KEYS) {
    const path = paths[key];
    if (!path || documents[key]?.path === path) continue;
    documents[key] = { path, status: "pending", note: null, uploaded_at: nowIso };
    changed = true;
  }
  if (!changed) return state;
  return { documents, verification_status: deriveVerificationStatus(documents, state.verification_status, vehicleType) };
}

/** `path` is the document path the reviewer actually saw; it guards against a concurrent replacement. */
export type ReviewDecision = { status: "verified" | "rejected"; note?: string | null; path: string; reviewer?: { id: string; at: string } };
export type ReviewResult =
  | { ok: true; state: RiderVerificationState; unchanged: boolean }
  | { ok: false; error: "not_uploaded" | "stale" };

/** True when any stored document still waits for staff review (even for an approved rider). */
export function hasPendingDocuments(docs: RiderStoredDocuments): boolean {
  return RIDER_DOCUMENT_KEYS.some((k) => docs[k]?.status === "pending");
}

/**
 * Staff decision on one document (PATCH /riders/admin/riders/{id}/documents).
 * `stale` when the rider replaced the file after the reviewer loaded it.
 * `unchanged` when the decision changes neither status nor note (skip write + notice).
 *
 * Note (deliberate): reversing the rejection of a migrated, document-less
 * approved rider ends in `not_submitted` — they must upload the full set.
 */
export function applyReview(
  state: RiderVerificationState,
  key: RiderDocumentKey,
  decision: ReviewDecision,
  vehicleType?: string | null
): ReviewResult {
  const current = state.documents[key];
  if (!current) return { ok: false, error: "not_uploaded" };
  if (current.path !== decision.path) return { ok: false, error: "stale" };
  const note = decision.status === "rejected" ? decision.note?.trim() || null : null;
  const unchanged = current.status === decision.status && current.note === note;
  const documents: RiderStoredDocuments = { ...state.documents, [key]: {
      ...current,
      status: decision.status,
      note,
      ...(decision.reviewer ? { reviewed_by: decision.reviewer.id, reviewed_at: decision.reviewer.at } : {}),
    },
  };
  return {
    ok: true,
    unchanged,
    state: { documents, verification_status: deriveVerificationStatus(documents, state.verification_status, vehicleType) },
  };
}

/**
 * Staff asks for a fresh upload of some documents (POST
 * /riders/admin/riders/{id}/verification-request). Uploaded ones become
 * rejected with the staff note; keys with no upload stay absent (`missing`).
 */
export function applyVerificationRequest(
  docs: RiderStoredDocuments,
  keys: RiderDocumentKey[],
  note: string,
  reviewerId: string,
  nowIso: string
): { documents: RiderStoredDocuments; invalidated: RiderDocumentKey[]; missing: RiderDocumentKey[] } {
  const documents: RiderStoredDocuments = { ...docs };
  const invalidated: RiderDocumentKey[] = [];
  const missing: RiderDocumentKey[] = [];
  for (const key of keys) {
    const current = docs[key];
    if (!current?.path) {
      missing.push(key);
      continue;
    }
    documents[key] = { ...current, status: "rejected", note, reviewed_by: reviewerId, reviewed_at: nowIso };
    invalidated.push(key);
  }
  return { documents, invalidated, missing };
}

/** Status after a verification request: no approval grace, never stays approved. */
export function statusAfterVerificationRequest(
  docs: RiderStoredDocuments,
  vehicleType?: string | null
): RiderVerificationStatus {
  const status = deriveVerificationStatus(docs, "not_submitted", vehicleType);
  return status === "approved" ? "not_submitted" : status;
}

export type ReviewNoticeKind = "approved" | "document_rejected" | "document_verified";

/** Which notification a staff decision sends the rider. */
export function reviewNoticeKind(
  before: RiderVerificationStatus,
  after: RiderVerificationStatus,
  decision: ReviewDecision["status"]
): ReviewNoticeKind {
  if (decision === "rejected") return "document_rejected";
  if (after === "approved" && before !== "approved") return "approved";
  return "document_verified";
}

const DOCUMENT_PATH_EXT = "(?:jpg|png|webp|pdf)";

/**
 * A rider may only attach the exact object shape POST /riders/uploads makes:
 * `<userId>/<key>/<digits>-<digits>.<jpg|png|webp|pdf>`.
 */
export function isOwnDocumentPath(userId: string, key: RiderDocumentKey, path: string) {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/${key}/\\d+-\\d+\\.${DOCUMENT_PATH_EXT}$`).test(path);
}

// ─── Activation checklist (GET /riders/required-actions) ─────────────

export type RiderActionKey =
  | "vehicle_type"
  | "driving_license"
  | "national_id"
  | "vehicle_documents"
  | "verification";
export type RiderActionStatus = "done" | "missing_info" | "in_progress" | "rejected";
export interface RiderRequiredAction {
  key: RiderActionKey;
  status: RiderActionStatus;
  /** Missing pieces: ["vehicle_type"], ["front", "back"], or document keys. */
  missing: string[];
  reason: string | null;
}

function documentPair(
  key: "driving_license" | "national_id",
  front: RiderStoredDocument | undefined,
  back: RiderStoredDocument | undefined,
  approved: boolean
): RiderRequiredAction {
  const sides = { front, back };
  const missing = approved
    ? []
    : Object.entries(sides)
        .filter(([, d]) => !d)
        .map(([side]) => side);
  const rejected = [front, back].find((d) => d?.status === "rejected");
  let status: RiderActionStatus = "done";
  if (rejected) status = "rejected";
  else if (missing.length) status = "missing_info";
  else if ([front, back].some((d) => d?.status === "pending")) status = "in_progress";
  return { key, status, missing, reason: rejected?.note ?? null };
}

const VEHICLE_DOCUMENT_KEYS = ["gray_card_front", "gray_card_back", "insurance"] as const;

/** Gray card + insurance as one action; `missing` lists the document keys. */
function vehicleDocuments(docs: RiderStoredDocuments, approved: boolean): RiderRequiredAction {
  const stored = VEHICLE_DOCUMENT_KEYS.map((k) => docs[k]);
  const missing = approved ? [] : VEHICLE_DOCUMENT_KEYS.filter((k) => !docs[k]);
  const rejected = stored.find((d) => d?.status === "rejected");
  let status: RiderActionStatus = "done";
  if (rejected) status = "rejected";
  else if (missing.length) status = "missing_info";
  else if (stored.some((d) => d?.status === "pending")) status = "in_progress";
  return { key: "vehicle_documents", status, missing: [...missing], reason: rejected?.note ?? null };
}

export function riderRequiredActions(input: {
  vehicleType: string | null | undefined;
  documents: RiderStoredDocuments;
  verificationStatus: RiderVerificationStatus;
}) {
  const docs = input.documents;
  const approved = input.verificationStatus === "approved";
  const required = requiredDocumentKeys(input.vehicleType);
  const verification: RiderRequiredAction = (() => {
    switch (input.verificationStatus) {
      case "approved":
        return { key: "verification", status: "done", missing: [], reason: null };
      case "pending":
        return { key: "verification", status: "in_progress", missing: [], reason: null };
      case "rejected":
        return {
          key: "verification",
          status: "rejected",
          missing: required.filter((k) => docs[k]?.status === "rejected"),
          reason: null,
        };
      default:
        return {
          key: "verification",
          status: "missing_info",
          missing: required.filter((k) => !docs[k]),
          reason: null,
        };
    }
  })();
  const actions: RiderRequiredAction[] = [
    {
      key: "vehicle_type",
      status: input.vehicleType ? "done" : "missing_info",
      missing: input.vehicleType ? [] : ["vehicle_type"],
      reason: null,
    },
    ...(required.includes("license_front")
      ? [documentPair("driving_license", docs.license_front, docs.license_back, approved)]
      : []),
    documentPair("national_id", docs.id_front, docs.id_back, approved),
    ...(required.includes("insurance") ? [vehicleDocuments(docs, approved)] : []),
    verification,
  ];
  return {
    verification_status: input.verificationStatus,
    required_documents: required,
    actions,
    completed: actions.filter((a) => a.status === "done").length,
    total: actions.length,
  };
}
