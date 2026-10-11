// Per-document verification of a store's required documents, kept pure so it's
// unit-testable (see store-documents.test.ts). Uploading a document doesn't
// make it valid: it only counts as verified once Blink staff verified it.
//
// `stores.document_review` (20261010163208_store_document_review.sql) holds
// staff's verdict per document:
//   { "<key>": { status: "verified" | "rejected", reason, value, reviewed_at, reviewed_by } }
// `value` is the exact value staff looked at (the scan URL, or the NIF / NIS
// number). A verdict only counts while it matches the CURRENT value in
// `stores.documents`: when the merchant uploads a new scan or edits a number,
// that document is "pending" again until staff review it — no reset needed.
//
// Writers: PATCH /merchant/admin/stores/{id}/documents (one document,
// `resolveStoreDocumentReview`) and a staff store approval (every document
// present, `verifyAllPresent` via resolveStaffStoreReview). Only blink-server
// writes the column; the merchant gets the computed `documents_status`, never
// the raw review (it carries staff ids).

/** The documents Blink verifies, in display order. */
export const STORE_DOC_KEYS = ["commercial_register_front", "commercial_register_back", "nif", "nis"] as const;
export type StoreDocKey = (typeof STORE_DOC_KEYS)[number];

/** Where each document's current value lives in `stores.documents` (StoreDocuments). */
export const STORE_DOC_FIELDS: Record<StoreDocKey, string> = {
  commercial_register_front: "commercial_register_front_url",
  commercial_register_back: "commercial_register_back_url",
  nif: "nif",
  nis: "nis",
};

/** The scanned documents (a file to upload again); the others are numbers to correct. */
export const isScanDocument = (key: StoreDocKey) =>
  key === "commercial_register_front" || key === "commercial_register_back";

export type StoreDocVerdict = "verified" | "rejected";

/** One entry of `stores.document_review`. */
export interface StoreDocReviewEntry {
  status: StoreDocVerdict;
  /** Why it was rejected (shown to the merchant); null when verified. */
  reason: string | null;
  /** The document value staff looked at. */
  value: string;
  reviewed_at: string;
  /** The staff user (null when unknown). */
  reviewed_by: string | null;
}

export type StoreDocumentReview = Partial<Record<StoreDocKey, StoreDocReviewEntry>>;

/**
 * missing: no current value; pending: present but not reviewed in its current
 * form; verified / rejected: staff's verdict on the current value.
 */
export type StoreDocStatus = "missing" | "pending" | "verified" | "rejected";

export interface StoreDocState {
  status: StoreDocStatus;
  /** Staff's reason when rejected; null otherwise. */
  reason: string | null;
}

export type StoreDocumentsStatus = Record<StoreDocKey, StoreDocState> & {
  /** Every required document is verified in its current form. */
  all_verified: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isDocKey = (k: string): k is StoreDocKey => (STORE_DOC_KEYS as readonly string[]).includes(k);

const iso = (now: Date | string) => (typeof now === "string" ? now : now.toISOString());

/** The document's current value in `stores.documents` (trimmed), or null when absent / blank. */
export function currentDocValue(documents: unknown, key: StoreDocKey): string | null {
  if (!isRecord(documents)) return null;
  const v = documents[STORE_DOC_FIELDS[key]];
  if (typeof v === "string") return v.trim() || null;
  // A number typed as one (jsonb keeps whatever was sent).
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** A well-formed review entry, or null (malformed jsonb is ignored). */
function reviewEntry(review: unknown, key: StoreDocKey): StoreDocReviewEntry | null {
  if (!isRecord(review)) return null;
  const e = review[key];
  if (!isRecord(e)) return null;
  if (e.status !== "verified" && e.status !== "rejected") return null;
  if (typeof e.value !== "string") return null;
  const reason = typeof e.reason === "string" ? e.reason.trim() || null : null;
  return {
    status: e.status,
    reason: e.status === "rejected" ? reason : null,
    value: e.value.trim(),
    reviewed_at: typeof e.reviewed_at === "string" ? e.reviewed_at : "",
    reviewed_by: typeof e.reviewed_by === "string" ? e.reviewed_by : null,
  };
}

/** The review with only well-formed entries for known documents. */
export function sanitizeReview(review: unknown): StoreDocumentReview {
  const out: StoreDocumentReview = {};
  if (!isRecord(review)) return out;
  for (const key of Object.keys(review)) {
    if (!isDocKey(key)) continue;
    const e = reviewEntry(review, key);
    if (e) out[key] = e;
  }
  return out;
}

/** What the merchant sees for one document (see StoreDocStatus). */
export function effectiveDocStatus(documents: unknown, review: unknown, key: StoreDocKey): StoreDocState {
  const value = currentDocValue(documents, key);
  if (value === null) return { status: "missing", reason: null };
  const e = reviewEntry(review, key);
  if (!e || e.value !== value) return { status: "pending", reason: null };
  return { status: e.status, reason: e.status === "rejected" ? e.reason : null };
}

/** Every required document's state, plus whether all of them are verified. */
export function documentsStatus(documents: unknown, review: unknown): StoreDocumentsStatus {
  const out = {} as Record<StoreDocKey, StoreDocState>;
  for (const key of STORE_DOC_KEYS) out[key] = effectiveDocStatus(documents, review, key);
  return { ...out, all_verified: STORE_DOC_KEYS.every((k) => out[k].status === "verified") };
}

/**
 * The review after staff's verdict on the document's current value (the
 * reason is kept for a rejection only). A document with no current value has
 * nothing to review: the review comes back unchanged (callers refuse first).
 */
export function markReviewed(
  review: unknown,
  documents: unknown,
  key: StoreDocKey,
  status: StoreDocVerdict,
  reason: string | null | undefined,
  staffId: string | null,
  now: Date | string
): StoreDocumentReview {
  const next = sanitizeReview(review);
  const value = currentDocValue(documents, key);
  if (value === null) return next;
  next[key] = {
    status,
    reason: status === "rejected" ? reason?.trim() || null : null,
    value,
    reviewed_at: iso(now),
    reviewed_by: staffId,
  };
  return next;
}

/**
 * The review after staff approved the store: every document present right now
 * is verified (what staff saw when they approved it). A document already
 * verified in its current form keeps its original verdict (who / when).
 */
export function verifyAllPresent(
  review: unknown,
  documents: unknown,
  staffId: string | null,
  now: Date | string
): StoreDocumentReview {
  let next = sanitizeReview(review);
  for (const key of STORE_DOC_KEYS) {
    if (effectiveDocStatus(documents, next, key).status === "verified") continue;
    next = markReviewed(next, documents, key, "verified", null, staffId, now);
  }
  return next;
}

/** A merchant store row as the merchant sees it: `documents_status` instead of the raw review. */
export function withDocumentsStatus<T extends Record<string, unknown>>(row: T) {
  const { document_review: review, ...rest } = row as T & { document_review?: unknown };
  return { ...rest, documents_status: documentsStatus(row.documents, review) };
}

// ─── Staff decision (PATCH /merchant/admin/stores/{id}/documents) ────

export interface StoreDocumentReviewBody {
  document: StoreDocKey;
  status: StoreDocVerdict;
  /** Why (shown to the merchant). Required to reject. */
  reason?: string | null;
  /** The document value the reviewer saw. */
  expected_value?: string | null;
}

export interface StoreDocumentsState {
  documents: unknown;
  document_review: unknown;
}

export type StoreDocumentReviewErrorCode = "note_required" | "document_missing" | "stale";

export type StoreDocumentNotification = "store_document_rejected" | "store_documents_verified";

export type StoreDocumentReviewResult =
  /** `review: null` = nothing changes (no write, no notification). */
  | { ok: true; review: StoreDocumentReview; notify: StoreDocumentNotification | null }
  | { ok: true; review: null; notify: null }
  | { ok: false; status: 400 | 409; code: StoreDocumentReviewErrorCode; error: string };

/**
 * Staff's verdict on one document, against the store's current documents:
 * - reject needs a reason (400 note_required);
 * - the document must be present (400 document_missing);
 * - `expected_value`, when sent, must be its current value (409 stale): staff
 *   decide on what they looked at;
 * - the same verdict (and reason) on the same value changes nothing.
 * Notify the owner of a rejection, and when this verdict makes every required
 * document verified.
 */
export function resolveStoreDocumentReview(
  current: StoreDocumentsState,
  body: StoreDocumentReviewBody,
  reviewer: { id: string | null; now: Date | string }
): StoreDocumentReviewResult {
  const reason = body.reason?.trim() || null;
  if (body.status === "rejected" && !reason) {
    return { ok: false, status: 400, code: "note_required", error: "A reason is required to reject a document" };
  }
  const value = currentDocValue(current.documents, body.document);
  if (value === null) {
    return {
      ok: false,
      status: 400,
      code: "document_missing",
      error: "This store hasn't provided this document yet",
    };
  }
  if (body.expected_value != null && body.expected_value.trim() !== value) {
    return {
      ok: false,
      status: 409,
      code: "stale",
      error: "The merchant changed this document since you opened it. Reload and review it again.",
    };
  }

  const before = effectiveDocStatus(current.documents, current.document_review, body.document);
  const sameReason = body.status === "verified" || before.reason === reason;
  if (before.status === body.status && sameReason) return { ok: true, review: null, notify: null };

  const review = markReviewed(
    current.document_review,
    current.documents,
    body.document,
    body.status,
    reason,
    reviewer.id,
    reviewer.now
  );
  const wasAllVerified = documentsStatus(current.documents, current.document_review).all_verified;
  const nowAllVerified = documentsStatus(current.documents, review).all_verified;
  const notify: StoreDocumentNotification | null =
    body.status === "rejected"
      ? "store_document_rejected"
      : nowAllVerified && !wasAllVerified
        ? "store_documents_verified"
        : null;
  return { ok: true, review, notify };
}
