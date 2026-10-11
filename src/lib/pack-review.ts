// Staff review of packs, kept pure so it's unit-testable (see
// pack-review.test.ts). Free delivery is paid by Blink, so a free-delivery
// pack may only be live once staff approved it (`reviewed_at` set). Any
// material edit — items, discount or free delivery — voids that approval and,
// if the pack wants to be live, sends it back to review. A pack staff took
// down (rejected / deactivated, `review_note` set) only goes live again
// through staff review, free delivery or not. PATCH /merchant/packs/{id}
// writes the columns `resolvePackUpdate` returns; PATCH
// /merchant/admin/packs/{id}/status those of `resolveStaffPackReview`.
import { sameInstant, staffReviewFailure, type StaffReviewFailure } from "./product-review";

export type PackStatus = "active" | "under_review" | "inactive" | "archived";

/** One `store_packs.items[]` entry (src/db/schema/merchant.ts PackItem). */
export interface ReviewPackItem {
  product_id: string;
  quantity: number;
  qty_promo_enabled?: boolean | null;
  buy_qty?: number | null;
  get_qty?: number | null;
}

/** The `store_packs` columns the rule reads. */
export interface PackReviewState {
  status: PackStatus;
  free_delivery: boolean;
  discount_enabled: boolean;
  discount_percent: number;
  items: ReviewPackItem[] | null;
  reviewed_at: string | null;
  /**
   * Why staff rejected / deactivated the pack. Only staff set it, and only a
   * staff approval clears it: while set, the pack is on a staff hold.
   */
  review_note?: string | null;
}

/** What the merchant may send (PATCH /merchant/packs/{id}). */
export interface PackReviewPatch {
  status?: "active" | "inactive" | "archived";
  free_delivery?: boolean;
  discount_enabled?: boolean;
  discount_percent?: number;
  items?: ReviewPackItem[];
}

/** Columns to write. `reviewed_at` / `review_note` are left out when unchanged. */
export interface PackReviewColumns {
  status: PackStatus;
  reviewed_at?: null;
  review_note?: null;
}

export interface PackReviewDecision extends PackReviewColumns {
  /** The pack wants to be live but needs staff approval first. */
  sent_to_review: boolean;
}

/** An item as it affects what the customer gets: promo fields only count while the promo is on. */
function itemKey(item: ReviewPackItem): string {
  const promo = !!item.qty_promo_enabled;
  return JSON.stringify([
    item.product_id,
    Number(item.quantity),
    promo,
    promo ? Number(item.buy_qty ?? 0) : 0,
    promo ? Number(item.get_qty ?? 0) : 0,
  ]);
}

/** Same pack contents, whatever the order of the lines. */
export function sameItems(a: readonly ReviewPackItem[] | null, b: readonly ReviewPackItem[] | null): boolean {
  const ka = (a ?? []).map(itemKey).sort();
  const kb = (b ?? []).map(itemKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** The % discount in effect: 0 while the discount is switched off. */
const effectiveDiscount = (enabled: boolean, percent: number) => (enabled ? Number(percent) || 0 : 0);

/**
 * Does the patch change what the customer gets (items, discount, free
 * delivery)? Name / description / image edits are not material.
 */
export function isMaterialChange(current: PackReviewState, patch: PackReviewPatch): boolean {
  if (patch.items !== undefined && !sameItems(current.items, patch.items)) return true;
  if (patch.free_delivery !== undefined && patch.free_delivery !== current.free_delivery) return true;
  const before = effectiveDiscount(current.discount_enabled, current.discount_percent);
  const after = effectiveDiscount(
    patch.discount_enabled ?? current.discount_enabled,
    patch.discount_percent ?? current.discount_percent
  );
  return before !== after;
}

/** Staff took the pack down (rejected / deactivated it, with a note) and haven't approved it since. */
export const onStaffHold = (pack: Pick<PackReviewState, "review_note">) => !!pack.review_note?.trim();

/**
 * The status / review columns a merchant edit leads to.
 *
 * - On a staff hold (see onStaffHold): asking for it to be live (or editing it
 *   while it waits in review) sends it to staff review, free delivery or not;
 *   it may be paused or archived. The staff note stays until staff approve it,
 *   so cancelling the request and re-activating can't skip the review.
 * - Not free delivery: the requested status (a pack waiting in review with no
 *   status in the patch goes live); any old review note is cleared.
 * - Free delivery, switched off (inactive / archived): that status; a material
 *   edit voids the approval.
 * - Free delivery, wants to be live (status active, or already active / in
 *   review with no status in the patch): live when approved and unchanged,
 *   otherwise back to staff review.
 */
export function resolvePackUpdate(current: PackReviewState, patch: PackReviewPatch): PackReviewDecision {
  const material = isMaterialChange(current, patch);
  const nextFree = patch.free_delivery ?? current.free_delivery;
  const approved = current.reviewed_at != null && !material;
  const requested: PackStatus = patch.status ?? current.status;

  if (onStaffHold(current)) {
    if (requested === "inactive" || requested === "archived") {
      return material && current.reviewed_at != null
        ? { status: requested, reviewed_at: null, sent_to_review: false }
        : { status: requested, sent_to_review: false };
    }
    return { status: "under_review", reviewed_at: null, sent_to_review: true };
  }

  if (!nextFree) {
    const status: PackStatus =
      current.status === "under_review" && patch.status === undefined ? "active" : requested;
    return { status, review_note: null, sent_to_review: false };
  }

  if (requested === "inactive" || requested === "archived") {
    return material
      ? { status: requested, reviewed_at: null, sent_to_review: false }
      : { status: requested, sent_to_review: false };
  }

  // requested is active, or under_review (already in review, no status sent).
  if (approved) return { status: "active", sent_to_review: false };
  return { status: "under_review", reviewed_at: null, review_note: null, sent_to_review: true };
}

/** A new pack: free delivery waits for staff review, anything else is live. */
export function newPackStatus(freeDelivery: boolean | undefined): PackStatus {
  return freeDelivery ? "under_review" : "active";
}

/**
 * Drop the columns that already hold the given value (status / reviewed_at /
 * review_note), so an edit that changes nothing writes nothing.
 */
export function changedColumns<T extends Record<string, unknown>>(
  current: Readonly<Record<string, unknown>>,
  columns: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(columns).filter(([k, v]) => v !== undefined && v !== (current[k] ?? null))
  ) as Partial<T>;
}

// ─── Staff review (PATCH /merchant/admin/packs/{id}/status) ──────────

export interface StaffPackReview {
  /** active = approve a pack in review; inactive = reject it, or take a live pack down. */
  status: "active" | "inactive";
  /** Why (shown to the merchant). Required for inactive. */
  note?: string | null;
  /** The pack's `updated_at` the reviewer saw. */
  expected_updated_at?: string;
}

export interface StaffPackColumns {
  status: "active" | "inactive";
  reviewed_at: string | null;
  review_note: string | null;
}

export type StaffPackReviewResult = { ok: true; columns: StaffPackColumns } | StaffReviewFailure;

/**
 * A staff pack decision against the pack's current state: approve only a pack
 * waiting in review (stamps `reviewed_at`, clears the note); reject one in
 * review or deactivate a live one, with a note. A pack the merchant paused or
 * archived can't be decided on (409).
 */
export function resolveStaffPackReview(
  current: { status: PackStatus; updated_at?: string | null },
  body: StaffPackReview,
  now: string = new Date().toISOString()
): StaffPackReviewResult {
  const note = body.note?.trim() || null;
  if (body.status === "inactive" && !note) {
    return staffReviewFailure(400, "note_required", "A note is required to reject or deactivate a pack");
  }
  if (body.expected_updated_at !== undefined && !sameInstant(current.updated_at, body.expected_updated_at)) {
    return staffReviewFailure(409, "stale", "This pack changed since you opened it. Reload and review it again.");
  }
  if (body.status === "active") {
    if (current.status !== "under_review") {
      return staffReviewFailure(409, "invalid_state", "Only a pack waiting for review can be approved");
    }
    return { ok: true, columns: { status: "active", reviewed_at: now, review_note: null } };
  }
  if (current.status !== "under_review" && current.status !== "active") {
    return staffReviewFailure(
      409,
      "invalid_state",
      current.status === "archived" ? "This pack is archived" : "This pack is already off"
    );
  }
  return { ok: true, columns: { status: "inactive", reviewed_at: null, review_note: note } };
}
