// The merchant's "to do" list — derived from their real stores, catalog, packs,
// PIN and dues so the app's Required Actions screen (and its badge) can't drift
// from the data. Kept pure so it's unit-testable (see
// merchant-required-actions.test.ts); GET /merchant/required-actions loads the
// rows. Only actions that apply are returned; the app localizes them by `kind`.
import { currentDocValue, documentsStatus, STORE_DOC_FIELDS, STORE_DOC_KEYS, type StoreDocKey } from "./store-documents";

export type RequiredActionKind =
  | "store_under_review"
  | "store_rejected"
  | "store_documents_missing"
  | "store_documents_rejected"
  | "store_documents_pending"
  | "hours_not_set"
  | "no_products"
  | "products_rejected"
  | "price_suggestions_rejected"
  | "packs_rejected"
  | "pin_not_set"
  | "dues_outstanding";

export type RequiredActionSeverity = "blocking" | "warning" | "info";
export type RequiredActionStatus = "todo" | "in_review" | "rejected";

export interface RequiredActionParams {
  store_name?: string;
  missing?: string[];
  /**
   * store_documents_rejected: the documents Blink rejected, with why;
   * store_documents_pending: the documents Blink is still checking.
   */
  documents?: { key: StoreDocKey; reason: string | null }[] | StoreDocKey[];
  count?: number;
  note?: string | null;
  amount?: number;
}

export interface MerchantRequiredAction {
  id: string;
  kind: RequiredActionKind;
  severity: RequiredActionSeverity;
  status: RequiredActionStatus;
  params: RequiredActionParams;
  store_id?: string;
}

export interface RequiredActionStore {
  id: string;
  name: string;
  status: string;
  hours: unknown;
  documents: unknown;
  /** Staff's verdict per document (stores.document_review, src/lib/store-documents.ts). */
  document_review?: unknown;
  /**
   * Why staff rejected / deactivated the store (stores.review_note). Set on an
   * `inactive` store = to fix and resubmit; kept on a resubmitted store (back
   * in `under_review`) until staff approve it.
   */
  review_note?: string | null;
}

export interface RequiredActionProduct {
  store_id: string;
  review_status: string;
  suggestion_status: string | null;
  review_note: string | null;
  updated_at?: string | null;
}

export interface RequiredActionPack {
  store_id: string;
  status: string;
  review_note: string | null;
  updated_at?: string | null;
}

export interface RequiredActionsInput {
  /** The stores to evaluate, in display order. */
  stores: readonly RequiredActionStore[];
  /** Products of those stores (at least the rejected / price-declined ones). */
  products: readonly RequiredActionProduct[];
  /** Product count per store id, when `products` is only the flagged ones. */
  productCounts?: ReadonlyMap<string, number>;
  /** Packs of those stores. */
  packs: readonly RequiredActionPack[];
  /** Outstanding dues per store id. */
  dues: ReadonlyMap<string, number>;
  /** users.pin_hash is set (needed to pay dues in Blink Cash). */
  pinSet: boolean;
}

/** The documents staff need to verify a store (StoreDocuments). */
export const REQUIRED_DOCUMENTS = [
  "commercial_register_front_url",
  "commercial_register_back_url",
  "nif",
  "nis",
] as const;

const SEVERITY_ORDER: Record<RequiredActionSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** Required documents not provided yet (their `stores.documents` field names). */
export function missingDocuments(documents: unknown): string[] {
  return STORE_DOC_KEYS.filter((k) => currentDocValue(documents, k) === null).map((k) => STORE_DOC_FIELDS[k]);
}

/** At least one enabled day with a shift. */
export function hoursSet(hours: unknown): boolean {
  if (!hours || typeof hours !== "object") return false;
  return Object.values(hours as Record<string, { enabled?: boolean; shifts?: unknown[] } | null>).some(
    (d) => !!d?.enabled && Array.isArray(d.shifts) && d.shifts.length > 0
  );
}

/** The most recent non-empty note among rows (newest `updated_at` first). */
function latestNote(rows: readonly { review_note: string | null; updated_at?: string | null }[]) {
  const withNote = rows.filter((r) => r.review_note?.trim());
  withNote.sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "") || 0);
  return withNote[0]?.review_note?.trim() ?? null;
}

export function buildMerchantRequiredActions(input: RequiredActionsInput): MerchantRequiredAction[] {
  const actions: MerchantRequiredAction[] = [];
  const add = (
    kind: RequiredActionKind,
    severity: RequiredActionSeverity,
    status: RequiredActionStatus,
    params: RequiredActionParams,
    store?: RequiredActionStore
  ) =>
    actions.push({
      id: store ? `${kind}:${store.id}` : kind,
      kind,
      severity,
      status,
      params: store ? { store_name: store.name, ...params } : params,
      ...(store ? { store_id: store.id } : {}),
    });

  for (const store of input.stores) {
    const underReview = store.status === "under_review";
    const storeNote = store.review_note?.trim() || null;
    // Staff rejected / deactivated it: fix and resubmit. An inactive store with
    // no note was hidden for another reason (account deletion request).
    const rejected = store.status === "inactive" && !!storeNote;
    const products = input.products.filter((p) => p.store_id === store.id);
    const packs = input.packs.filter((p) => p.store_id === store.id);

    if (rejected) add("store_rejected", "blocking", "rejected", { note: storeNote }, store);
    // A resubmitted store carries the earlier reason until staff approve it.
    if (underReview) add("store_under_review", "blocking", "in_review", storeNote ? { note: storeNote } : {}, store);

    const missing = missingDocuments(store.documents);
    if (missing.length) {
      // Blink needs them to approve the store (resubmitting doesn't check them), so
      // they block a store in review or rejected; a live store should still add them.
      add("store_documents_missing", underReview || rejected ? "blocking" : "warning", "todo", { missing }, store);
    }

    // Provided documents only count once Blink verified them in their current form.
    const docs = documentsStatus(store.documents, store.document_review);
    const docsRejected = STORE_DOC_KEYS.filter((k) => docs[k].status === "rejected");
    if (docsRejected.length) {
      // Same weight as a missing document: Blink won't approve the store with it.
      add(
        "store_documents_rejected",
        underReview || rejected ? "blocking" : "warning",
        "rejected",
        { documents: docsRejected.map((key) => ({ key, reason: docs[key].reason })) },
        store
      );
    }
    const docsPending = STORE_DOC_KEYS.filter((k) => docs[k].status === "pending");
    if (docsPending.length) add("store_documents_pending", "info", "in_review", { documents: docsPending }, store);

    const productCount = input.productCounts?.get(store.id) ?? products.length;
    if (productCount === 0) add("no_products", "blocking", "todo", {}, store);

    if (!hoursSet(store.hours)) add("hours_not_set", "warning", "todo", {}, store);

    const productsRejected = products.filter((p) => p.review_status === "rejected");
    if (productsRejected.length) {
      add(
        "products_rejected",
        "warning",
        "rejected",
        { count: productsRejected.length, note: latestNote(productsRejected) },
        store
      );
    }

    const declined = products.filter((p) => p.suggestion_status === "rejected");
    if (declined.length) {
      add(
        "price_suggestions_rejected",
        "info",
        "rejected",
        { count: declined.length, note: latestNote(declined) },
        store
      );
    }

    const packsRejected = packs.filter((p) => p.status === "inactive" && p.review_note != null);
    if (packsRejected.length) {
      add("packs_rejected", "info", "rejected", { count: packsRejected.length, note: latestNote(packsRejected) }, store);
    }

    const owed = input.dues.get(store.id) ?? 0;
    if (owed > 0) add("dues_outstanding", "warning", "todo", { amount: owed }, store);
  }

  if (!input.pinSet) add("pin_not_set", "warning", "todo", {});

  // Stable: blocking first, then warning, then info; store order within each.
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY_ORDER[x.a.severity] - SEVERITY_ORDER[y.a.severity] || x.i - y.i)
    .map(({ a }) => a);
}
