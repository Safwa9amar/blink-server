// What a merchant's product edit does to its price and review state, kept pure
// so it's unit-testable (see product-review.test.ts). PATCH
// /merchant/products/{id} writes the columns `resolveProductUpdate` returns.
//
// - The live `price` is never written by the merchant directly: a new price is
//   a price suggestion. Within ±PRICE_TOLERANCE of Blink's reference price it
//   is applied at once, otherwise it waits for staff review.
// - A Blink Library product keeps the library's content: the merchant only
//   sets its price, stock, availability and store category.
// - A rejected product whose content changes is resubmitted (pending again);
//   an approved manual product whose identity (name, photos, brand, barcode)
//   changes goes back to review too.

/** A suggested price within ±20% of the Blink reference is auto-accepted. */
export const PRICE_TOLERANCE = 0.2;

export type ProductReviewStatus = "approved" | "pending" | "rejected";

/** The `store_products` columns the rules read. */
export interface ProductReviewState {
  price: number | string;
  blink_price: number | string;
  review_status: ProductReviewStatus;
  /** Set when the product was added from the Blink Library (its content is Blink's). */
  library_product_id?: string | null;
  title?: string | null;
  description?: string | null;
  photos?: string[] | null;
  brand?: string | null;
  barcode?: string | null;
  category?: string | null;
  unit?: string | null;
}

/** The merchant's PATCH body fields the rules read. */
export interface ProductEdit {
  price?: number;
  suggested_price?: number;
  title?: string;
  description?: string | null;
  photos?: string[];
  brand?: string;
  barcode?: string;
  category?: string;
  unit?: string | null;
}

export interface PriceSuggestionColumns {
  suggested_price: number;
  suggestion_status: "accepted" | "pending";
  /** Set when the suggestion is applied right away. */
  price?: number;
  /**
   * Set when the product had no Blink reference price yet: the price the
   * suggestion was measured against (the live price, or the suggestion itself
   * when there was no price at all) becomes the reference, so repeated ±20%
   * steps can't compound.
   */
  blink_price?: number;
}

/** Two money amounts are the same price once rounded to 2 decimals. */
export const samePrice = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/**
 * Auto-accept a suggested price within ±tolerance of Blink's reference price
 * (`blink_price`, else the current price); anything further waits for staff.
 */
export function decidePriceSuggestion(
  product: Pick<ProductReviewState, "price" | "blink_price">,
  suggested: number,
  tolerance = PRICE_TOLERANCE
): PriceSuggestionColumns {
  const blink = Number(product.blink_price) || 0;
  const ref = blink || Number(product.price) || 0;
  // No reference yet: pin the one this suggestion is judged against.
  const pin = blink === 0 ? { blink_price: ref || suggested } : {};
  const within = ref === 0 || (suggested >= ref * (1 - tolerance) && suggested <= ref * (1 + tolerance));
  if (!within) return { suggested_price: suggested, suggestion_status: "pending", ...pin };
  return { suggested_price: suggested, suggestion_status: "accepted", price: suggested, ...pin };
}

/**
 * The price the merchant is proposing, if any: an explicit `suggested_price`,
 * else a `price` that differs from the current one. An unchanged `price` is
 * ignored (forms send the whole product back).
 */
export function proposedPrice(
  product: Pick<ProductReviewState, "price">,
  edit: Pick<ProductEdit, "price" | "suggested_price">
): number | undefined {
  if (edit.suggested_price !== undefined) return edit.suggested_price;
  if (edit.price === undefined || samePrice(edit.price, Number(product.price))) return undefined;
  return edit.price;
}

/**
 * What a merchant may set on a Blink Library product (adding it, or editing it
 * later) besides the price: the name, photos, description, brand, barcode and
 * unit stay the library's.
 */
export const LIBRARY_MERCHANT_FIELDS = ["category", "stock", "is_available"] as const;

/**
 * The merchant-sent fields that may be written: every defined field of a
 * manual product, only LIBRARY_MERCHANT_FIELDS of a library one. `price` is
 * not handled here (adding: `newProductPriceError`; edits: suggestions).
 */
export function merchantWritableFields(
  fromLibrary: boolean,
  fields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const allowed = fromLibrary ? new Set<string>(LIBRARY_MERCHANT_FIELDS) : null;
  return Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => v !== undefined && (!allowed || allowed.has(k)))
  );
}

/**
 * Why a new product's price is refused, or null. Every new product needs a
 * price > 0: a manual one's becomes Blink's reference, and a library one goes
 * live at once — without a price it would be sold at 0 DA.
 */
export function newProductPriceError(fromLibrary: boolean, price: number | undefined): string | null {
  if (Number(price) > 0) return null;
  return fromLibrary
    ? "price must be greater than 0 for library products"
    : "price must be greater than 0 for manual products";
}

const CONTENT_FIELDS = ["title", "description", "photos", "brand", "barcode", "category", "unit"] as const;
/** What identifies a product to a customer: changing one re-reviews an approved manual product. */
const IDENTITY_FIELDS = ["title", "photos", "brand", "barcode"] as const;

const norm = (v: unknown) => (Array.isArray(v) ? JSON.stringify(v) : v == null ? "" : String(v).trim());

const changed = (product: ProductReviewState, edit: ProductEdit, fields: readonly (keyof ProductEdit & keyof ProductReviewState)[]) =>
  fields.some((k) => edit[k] !== undefined && norm(edit[k]) !== norm(product[k]));

/** Does the edit change what staff reviewed (name, description, photos, brand, barcode, category, unit)? */
export function contentChanged(product: ProductReviewState, edit: ProductEdit): boolean {
  return changed(product, edit, CONTENT_FIELDS);
}

/** Does the edit change the product's identity (name, photos, brand, barcode)? */
export function identityChanged(product: ProductReviewState, edit: ProductEdit): boolean {
  return changed(product, edit, IDENTITY_FIELDS);
}

export type ProductUpdateResult =
  | { ok: true; columns: Record<string, unknown> }
  | { ok: false; code: "price_invalid"; error: string };

/**
 * The price + review columns a merchant edit writes (on top of the plain
 * content fields, which the route copies itself — never `price`). Pass the
 * edit already filtered by `merchantWritableFields`.
 */
export function resolveProductUpdate(product: ProductReviewState, edit: ProductEdit): ProductUpdateResult {
  const columns: Record<string, unknown> = {};

  const proposed = proposedPrice(product, edit);
  if (proposed !== undefined) {
    if (!(proposed > 0)) return { ok: false, code: "price_invalid", error: "price must be greater than 0" };
    Object.assign(columns, decidePriceSuggestion(product, proposed));
    // A new suggestion replaces the note on the last declined one.
    if (product.review_status !== "rejected") columns.review_note = null;
  }

  const resubmitted = product.review_status === "rejected" && contentChanged(product, edit);
  const reidentified =
    product.review_status === "approved" && !product.library_product_id && identityChanged(product, edit);
  if (resubmitted || reidentified) {
    columns.review_status = "pending";
    columns.review_note = null;
  }

  return { ok: true, columns };
}

// ─── Staff review (PATCH /merchant/admin/products/{id}/review) ───────

/** A staff decision on a product and/or its pending price suggestion. */
export interface StaffProductReview {
  review_status?: ProductReviewStatus;
  suggestion_status?: "accepted" | "rejected";
  /** Why (shown to the merchant). Required to reject a product or a price. */
  note?: string | null;
  /** The suggested price the reviewer saw (checked on suggestion decisions). */
  expected_suggested_price?: number;
  /** The product's `updated_at` the reviewer saw (checked on review_status decisions). */
  expected_updated_at?: string;
}

/** The `store_products` columns a staff review reads. */
export interface StaffReviewState {
  price: number | string;
  review_status: ProductReviewStatus;
  suggested_price: number | string | null;
  suggestion_status: "pending" | "accepted" | "rejected" | null;
  review_note: string | null;
  updated_at?: string | null;
}

/** What the merchant is told about (one notification each). */
export type StaffProductDecision = "product_approved" | "product_rejected" | "price_accepted" | "pricing_flagged";

/** `code` of a refused staff decision (400 note_required, 409 otherwise). */
export type StaffReviewErrorCode = "note_required" | "stale" | "not_pending" | "no_suggestion" | "invalid_state";

export type StaffReviewFailure = { ok: false; status: 400 | 409; code: StaffReviewErrorCode; error: string };

export type StaffProductReviewResult =
  | { ok: true; columns: Record<string, unknown>; decisions: StaffProductDecision[] }
  | StaffReviewFailure;

export const staffReviewFailure = (
  status: 400 | 409,
  code: StaffReviewErrorCode,
  error: string
): StaffReviewFailure => ({
  ok: false,
  status,
  code,
  error,
});

/** Two timestamps name the same instant (PostgREST and JS format them differently). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = Date.parse(a ?? "");
  return !Number.isNaN(ta) && ta === Date.parse(b ?? "");
}

/**
 * The columns a staff review writes, and the decisions to notify the merchant
 * of. The decision must still apply to what the reviewer saw (`expected_*`)
 * and to the row's current state:
 * - product: approve a pending / rejected one, reject a pending / approved
 *   one; anything else (incl. "pending") changes nothing;
 * - price: decline a pending suggestion; accept a pending or declined one
 *   (staff may overturn a refusal) — it becomes the live price.
 * A rejection (product or price) needs a note, stored as review_note.
 */
export function resolveStaffProductReview(
  product: StaffReviewState,
  body: StaffProductReview
): StaffProductReviewResult {
  const note = body.note?.trim() || null;
  if ((body.review_status === "rejected" || body.suggestion_status === "rejected") && !note) {
    return staffReviewFailure(400, "note_required", "A note is required to reject");
  }

  if (
    body.suggestion_status &&
    body.expected_suggested_price !== undefined &&
    (product.suggested_price == null || !samePrice(Number(product.suggested_price), body.expected_suggested_price))
  ) {
    return staffReviewFailure(409, "stale", "The suggested price changed since you opened it. Reload and review it again.");
  }
  if (body.review_status && body.expected_updated_at !== undefined && !sameInstant(product.updated_at, body.expected_updated_at)) {
    return staffReviewFailure(409, "stale", "This product changed since you opened it. Reload and review it again.");
  }

  if (body.suggestion_status === "accepted") {
    if (product.suggested_price == null) return staffReviewFailure(409, "no_suggestion", "There is no suggested price to accept");
    if (product.suggestion_status !== "pending" && product.suggestion_status !== "rejected") {
      return staffReviewFailure(409, "not_pending", "This price suggestion is not waiting for a decision");
    }
  } else if (body.suggestion_status === "rejected" && product.suggestion_status !== "pending") {
    return staffReviewFailure(409, "not_pending", "Only a pending price suggestion can be declined");
  }

  const columns: Record<string, unknown> = {};
  const decisions: StaffProductDecision[] = [];

  const from = product.review_status;
  if (body.review_status === "approved" && (from === "pending" || from === "rejected")) {
    columns.review_status = "approved";
    columns.review_note = null;
    decisions.push("product_approved");
  } else if (body.review_status === "rejected" && (from === "pending" || from === "approved")) {
    columns.review_status = "rejected";
    columns.review_note = note;
    decisions.push("product_rejected");
  }

  if (body.suggestion_status === "accepted") {
    columns.suggestion_status = "accepted";
    columns.price = Number(product.suggested_price);
    // Overturning a refusal: its note no longer applies (unless the product itself is rejected).
    const productRejected = (columns.review_status ?? from) === "rejected";
    if (product.suggestion_status === "rejected" && !productRejected) columns.review_note = null;
    decisions.push("price_accepted");
  } else if (body.suggestion_status === "rejected") {
    columns.suggestion_status = "rejected";
    columns.review_note = note;
    decisions.push("pricing_flagged");
  }

  return { ok: true, columns, decisions };
}
