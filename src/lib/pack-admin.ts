// Staff pack authoring — the dashboard creates, edits and deletes a store's
// packs on its behalf — kept pure so it's unit-testable (see
// pack-admin.test.ts). A staff write is itself the review: it never sends a
// pack to review (so no staff-inbox event either) and stamps `reviewed_at`
// whenever the result is a live free-delivery pack, so the merchant's own
// later edits go through the usual rules (src/lib/pack-review.ts). Applied by
// POST /merchant/admin/stores/{id}/packs, PATCH and DELETE
// /merchant/admin/packs/{id} (src/routes/merchant/admin-packs.ts).
import type { PackItem } from "../db/schema/merchant";
import type { PackStatus } from "./pack-review";
import { sameInstant } from "./product-review";

/** `code` of a refused staff pack write. */
export const ADMIN_PACK_ERROR_CODES = ["not_found", "duplicate_items", "invalid_items", "empty", "stale"] as const;
export type AdminPackErrorCode = (typeof ADMIN_PACK_ERROR_CODES)[number];

export type AdminPackFailure = {
  status: 400;
  code: AdminPackErrorCode;
  error: string;
  details?: { path: string; message: string }[];
};

/** An item as staff send it: the promo fields may be left out. */
export interface AdminPackItemInput {
  product_id: string;
  quantity: number;
  qty_promo_enabled?: boolean | null;
  buy_qty?: number | null;
  get_qty?: number | null;
}

/** The pack columns staff may edit. */
export const ADMIN_PACK_FIELDS = [
  "name",
  "description",
  "image",
  "items",
  "discount_enabled",
  "discount_percent",
  "free_delivery",
  "status",
] as const;
export type AdminPackField = (typeof ADMIN_PACK_FIELDS)[number];

/**
 * Items as stored (`store_packs.items`): every field set, ids lowercased (the
 * customer side matches products by the id string, as PostgREST returns it).
 */
export function normalizePackItems(items: readonly AdminPackItemInput[]): PackItem[] {
  return items.map((i) => ({
    product_id: i.product_id.toLowerCase(),
    quantity: Number(i.quantity),
    qty_promo_enabled: !!i.qty_promo_enabled,
    buy_qty: Number(i.buy_qty ?? 0),
    get_qty: Number(i.get_qty ?? 0),
  }));
}

/** A product goes in one line, with its quantity: listing it twice is refused. */
export function duplicateItems(items: readonly PackItem[]): AdminPackFailure | null {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const { product_id } of items) (seen.has(product_id) ? dupes : seen).add(product_id);
  if (dupes.size === 0) return null;
  return {
    status: 400,
    code: "duplicate_items",
    error: `Each product can only be listed once: ${[...dupes].join(", ")}`,
  };
}

/**
 * Every item must be a product of the pack's store: `storeProductIds` are the
 * ids found among them. The refusal names each foreign item (path
 * `items.<index>.product_id`).
 */
export function foreignItems(items: readonly PackItem[], storeProductIds: Iterable<string>): AdminPackFailure | null {
  const known = new Set([...storeProductIds].map((id) => id.toLowerCase()));
  const foreign = items.flatMap((item, index) => (known.has(item.product_id) ? [] : [{ index, id: item.product_id }]));
  if (foreign.length === 0) return null;
  return {
    status: 400,
    code: "invalid_items",
    error: `Pack items must be products of this store: ${foreign.map((f) => f.id).join(", ")}`,
    details: foreign.map(({ index }) => ({ path: `items.${index}.product_id`, message: "Not a product of this store" })),
  };
}

/** The body edits at least one pack column (`null` clears one, so it counts). */
export function hasEditableField(body: Readonly<Record<string, unknown>>): boolean {
  return ADMIN_PACK_FIELDS.some((k) => body[k] !== undefined);
}

/** Postgres "invalid input syntax" (relayed by PostgREST): e.g. an id that isn't a uuid. */
export const INVALID_INPUT_SYNTAX = "22P02";

/**
 * The row a read by id found, else null — also for a malformed id (22P02),
 * which can't name a row. Any other read failure throws (a 500 from the error
 * handler), so a database blip never answers "not found".
 */
export function foundRow<R extends { data: unknown; error: { code?: string; message: string } | null }>(
  { data, error }: R,
  what: string
): R["data"] | null {
  if (!error) return data;
  if (error.code === INVALID_INPUT_SYNTAX) return null;
  throw new Error(`[admin-packs] ${what} lookup failed: ${error.message}`);
}

/** The reviewer sent the `updated_at` they saw and the row has moved on since. */
export function isStale(updatedAt: string | null | undefined, expected: string | undefined): boolean {
  return expected !== undefined && !sameInstant(updatedAt, expected);
}

/**
 * The fields of the edit that change the pack (items compared line by line,
 * defaults filled), so a form saved as-is writes nothing.
 */
export function changedPackFields<T extends Partial<Record<AdminPackField, unknown>>>(
  current: Readonly<Record<string, unknown>>,
  edit: T
): Partial<T> {
  const same = (key: string, before: unknown, after: unknown) =>
    key === "items"
      ? JSON.stringify(normalizePackItems((before as AdminPackItemInput[] | null) ?? [])) ===
        JSON.stringify(normalizePackItems(after as AdminPackItemInput[]))
      : (before ?? null) === (after ?? null);
  return Object.fromEntries(
    Object.entries(edit).filter(
      ([k, v]) => v !== undefined && (ADMIN_PACK_FIELDS as readonly string[]).includes(k) && !same(k, current[k], v)
    )
  ) as Partial<T>;
}

/** Status / review columns of a staff write. Left out = unchanged. */
export type AdminPackReviewColumns = {
  status: PackStatus;
  reviewed_at?: string | null;
  review_note?: null;
};

/**
 * A pack staff create: the status they chose, approved when it goes live with
 * free delivery, no review note.
 */
export function newAdminPackColumns(
  status: "active" | "inactive",
  freeDelivery: boolean,
  now: string = new Date().toISOString()
): Required<AdminPackReviewColumns> {
  return { status, reviewed_at: status === "active" && freeDelivery ? now : null, review_note: null };
}

/**
 * A staff edit: the status is the one sent, else the current one (an edit
 * never moves a pack implicitly — one waiting in review stays there until
 * approved via PATCH /merchant/admin/packs/{id}/status or a status is sent).
 * - live with free delivery → approved now (`reviewed_at` stamped);
 * - no free delivery → `reviewed_at` cleared (nothing to approve);
 * - otherwise (free delivery, not live) → `reviewed_at` unchanged.
 * A live result also lifts any staff hold (`review_note` cleared).
 */
export function resolveAdminPackUpdate(
  current: { status: PackStatus; free_delivery: boolean },
  edit: { status?: "active" | "inactive" | "archived"; free_delivery?: boolean },
  now: string = new Date().toISOString()
): AdminPackReviewColumns {
  const status: PackStatus = edit.status ?? current.status;
  const freeDelivery = edit.free_delivery ?? current.free_delivery;
  const columns: AdminPackReviewColumns = { status };
  if (status === "active" && freeDelivery) columns.reviewed_at = now;
  else if (!freeDelivery) columns.reviewed_at = null;
  if (status === "active") columns.review_note = null;
  return columns;
}

/**
 * The notification a staff edit sends the merchant: turning on a pack that
 * waited in review approves it, so it's the review's own `pack_approved` (as
 * PATCH /merchant/admin/packs/{id}/status sends); any other edit is
 * `pack_updated_by_staff`.
 */
export function adminPackUpdateKind(
  before: { status: PackStatus },
  after: { status: PackStatus }
): "pack_approved" | "pack_updated_by_staff" {
  return before.status === "under_review" && after.status === "active" ? "pack_approved" : "pack_updated_by_staff";
}
