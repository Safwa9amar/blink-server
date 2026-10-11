// Staff review of merchant stores, kept pure so it's unit-testable (see
// store-review.test.ts). A new store waits in `under_review`; staff approve it
// (`active`) or reject it (`inactive` + a mandatory note, kept as
// `stores.review_note`); a live store can be deactivated the same way. The
// merchant resubmits a rejected / deactivated store (back to `under_review`,
// note kept so the reviewer sees the earlier reason); only a staff approval
// clears the note. An `inactive` store with no note was hidden for another
// reason (an account deletion request) and can neither be approved here nor
// resubmitted. While the owner is leaving Blink (an account deletion request
// pending or completed) no store of theirs can be approved or resubmitted;
// rejecting / deactivating stays allowed. PATCH /merchant/admin/stores/{id}/status
// writes the columns of `resolveStaffStoreReview`, POST
// /merchant/stores/{id}/resubmit those of `resolveStoreResubmit`. An approval
// also verifies every document the store has at that moment (what the
// reviewer saw — src/lib/store-documents.ts); staff verify / reject documents
// one by one with PATCH /merchant/admin/stores/{id}/documents.
import { sameInstant } from "./product-review";
import { verifyAllPresent, type StoreDocumentReview } from "./store-documents";
import { storeReviewKind, type StoreReviewKind, type StoreReviewStatus } from "./store-review-copy";

/** The `stores` columns the rules read. */
export interface StoreReviewState {
  status: StoreReviewStatus;
  review_note: string | null;
  updated_at?: string | null;
  /** stores.documents — what an approval verifies. */
  documents?: unknown;
  /** stores.document_review — staff's verdict per document. */
  document_review?: unknown;
}

/** Who decides, and when (an approval stamps the documents it verifies). */
export interface StoreReviewer {
  id: string | null;
  now: Date | string;
}

/** What the rules need to know about the store's owner (loaded by the route). */
export interface StoreOwnerState {
  /** The owner has an account deletion request `pending` or `completed`. */
  leaving: boolean;
}

/** `code` of a refused store review / resubmit (400 note_required, 409 otherwise). */
export type StoreReviewErrorCode = "note_required" | "stale" | "invalid_state" | "owner_leaving";

export type StoreReviewFailure = { ok: false; status: 400 | 409; code: StoreReviewErrorCode; error: string };

const failure = (status: 400 | 409, code: StoreReviewErrorCode, error: string): StoreReviewFailure => ({
  ok: false,
  status,
  code,
  error,
});

/** Staff took the store down (rejected / deactivated it, with a note) and haven't approved it since. */
export const onStoreHold = (store: Pick<StoreReviewState, "status" | "review_note">) =>
  store.status === "inactive" && !!store.review_note?.trim();

// ─── Staff review (PATCH /merchant/admin/stores/{id}/status) ─────────

export interface StaffStoreReview {
  /** active = approve; inactive = reject one in review, or deactivate a live one. */
  status: "active" | "inactive";
  /** Why (shown to the merchant). Required for inactive. */
  note?: string | null;
  /** The store's `updated_at` the reviewer saw. */
  expected_updated_at?: string;
}

export interface StaffStoreColumns {
  status: "active" | "inactive";
  is_open: boolean;
  /**
   * Approval only: false so the store follows its opening hours from then on
   * (storeOpenState in store-categories.ts; without hours `is_open` decides).
   */
  manual_override?: false;
  review_note: string | null;
  /**
   * Approval only: every document present is verified (verifyAllPresent) —
   * the reviewer approved the store on what they saw (expected_updated_at).
   */
  document_review?: StoreDocumentReview;
}

/**
 * `columns: null` = nothing to change (no write, no notification). `kind` =
 * the notification to send the owner (null with no columns).
 */
export type StaffStoreReviewResult =
  | { ok: true; columns: StaffStoreColumns; kind: StoreReviewKind | null }
  | { ok: true; columns: null; kind: null }
  | StoreReviewFailure;

/**
 * A staff store decision against the store's current state:
 * - approve: a store in review (new or resubmitted), or one staff rejected /
 *   deactivated (inactive with a note) — it opens on its schedule (the
 *   merchant's manual open/closed override is cleared), its note is
 *   cleared, and every document it has is verified. Already live: nothing
 *   to change. Inactive without a note: 409.
 *   Refused (409 owner_leaving) while the owner is leaving Blink.
 * - reject / deactivate (note required): a store in review or a live one — it
 *   closes and keeps the note; document verdicts stay as they are. Already off
 *   with the same note: nothing to change; off otherwise: 409. Allowed whether
 *   or not the owner is leaving.
 * `expected_updated_at` must be the store's current updated_at (409 stale).
 */
export function resolveStaffStoreReview(
  current: StoreReviewState,
  body: StaffStoreReview,
  owner: StoreOwnerState,
  reviewer: StoreReviewer
): StaffStoreReviewResult {
  const note = body.note?.trim() || null;
  if (body.status === "inactive" && !note) {
    return failure(400, "note_required", "A note is required to reject or deactivate a store");
  }
  // Reloading won't change this, so it comes before the staleness check.
  if (body.status === "active" && owner.leaving) {
    return failure(
      409,
      "owner_leaving",
      "The store owner asked to delete their Blink account, so this store can't be approved"
    );
  }
  if (body.expected_updated_at !== undefined && !sameInstant(current.updated_at, body.expected_updated_at)) {
    return failure(409, "stale", "This store changed since you opened it. Reload and review it again.");
  }

  if (body.status === "active") {
    if (current.status === "active") return { ok: true, columns: null, kind: null };
    if (current.status === "inactive" && !onStoreHold(current)) {
      return failure(
        409,
        "invalid_state",
        "This store was taken offline for another reason (e.g. an account deletion request) and can't be approved"
      );
    }
    const columns: StaffStoreColumns = {
      status: "active",
      is_open: true,
      manual_override: false,
      review_note: null,
      document_review: verifyAllPresent(current.document_review, current.documents, reviewer.id, reviewer.now),
    };
    return { ok: true, columns, kind: storeReviewKind({ from: current.status, to: "active" }) };
  }

  if (current.status === "inactive") {
    if (onStoreHold(current) && current.review_note!.trim() === note) return { ok: true, columns: null, kind: null };
    return failure(409, "invalid_state", "This store is already inactive");
  }
  const columns: StaffStoreColumns = { status: "inactive", is_open: false, review_note: note };
  return { ok: true, columns, kind: storeReviewKind({ from: current.status, to: "inactive" }) };
}

// ─── Merchant resubmit (POST /merchant/stores/{id}/resubmit) ─────────

export type StoreResubmitResult =
  | { ok: true; columns: { status: "under_review"; is_open: false } }
  | StoreReviewFailure;

/**
 * The merchant sends a store staff rejected / deactivated back to review. The
 * note stays (the reviewer sees the earlier reason); staff approval clears it.
 * Refused (409 owner_leaving) while the merchant is leaving Blink.
 */
export function resolveStoreResubmit(current: StoreReviewState, owner: StoreOwnerState): StoreResubmitResult {
  if (owner.leaving) {
    return failure(
      409,
      "owner_leaving",
      "You asked to delete your Blink account, so this store can't be sent for review"
    );
  }
  if (onStoreHold(current)) return { ok: true, columns: { status: "under_review", is_open: false } };
  const error =
    current.status === "under_review"
      ? "This store is already waiting for review"
      : current.status === "active"
        ? "This store is already live"
        : "This store can't be resubmitted: it was taken offline for another reason";
  return failure(409, "invalid_state", error);
}
