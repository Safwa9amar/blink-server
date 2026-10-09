// One checkout can hold several stores of the same merchant account. The
// merchant sees each store's order on its own, plus its "own siblings": the
// other parts of that checkout in stores with the SAME OWNER as the order's
// store. The owner is compared through the stores, never through the caller,
// so the rule stays right once stores get their own staff accounts.

/** A checkout order row with its store's owner (from a `stores(owner_id)` embed). */
export interface SiblingRow {
  id: string;
  checkout_id: string | null;
  store_id: string | null;
  store_name: string;
  status: string;
  merchant_status: string | null;
  type: string;
  items: { quantity?: number | null }[] | null;
  subtotal: number;
  total: number;
  accepted_at: string | null;
  prepared_at: string | null;
  rider_assigned_at: string | null;
  owner_id: string | null;
}

export interface OrderSibling {
  id: string;
  store_id: string | null;
  store_name: string;
  status: string;
  merchant_status: string | null;
  type: string;
  item_count: number;
  subtotal: number;
  total: number;
  accepted_at: string | null;
  prepared_at: string | null;
  rider_assigned_at: string | null;
}

const itemCount = (items: SiblingRow["items"]) =>
  (items ?? []).reduce((n, it) => n + (Number(it?.quantity) || 1), 0);

/**
 * The other parts of `order`'s checkout whose store has the same owner as
 * `order`'s store, sorted by store name. `rows` must include `order`'s own row
 * (it carries the owner). Canceled / rejected parts stay in.
 */
export function ownSiblings(
  order: { id: string; checkout_id: string | null },
  rows: SiblingRow[]
): OrderSibling[] {
  if (!order.checkout_id) return [];
  const owner = rows.find((r) => r.id === order.id)?.owner_id;
  if (!owner) return [];
  return rows
    .filter((r) => r.checkout_id === order.checkout_id && r.id !== order.id && r.owner_id === owner)
    .sort((a, b) => a.store_name.localeCompare(b.store_name) || a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      store_id: r.store_id,
      store_name: r.store_name,
      status: r.status,
      merchant_status: r.merchant_status,
      type: r.type,
      item_count: itemCount(r.items),
      subtotal: Number(r.subtotal) || 0,
      total: Number(r.total) || 0,
      accepted_at: r.accepted_at,
      prepared_at: r.prepared_at,
      rider_assigned_at: r.rider_assigned_at,
    }));
}

/**
 * Every live part of `order`'s checkout (rejected / canceled stores drop out)
 * is in a store with the same owner as `order`'s store: the merchant may then
 * send its own driver for the whole checkout.
 */
export function ownsWholeCheckout(
  order: { id: string; checkout_id: string | null },
  rows: SiblingRow[]
): boolean {
  if (!order.checkout_id) return false;
  const owner = rows.find((r) => r.id === order.id)?.owner_id;
  if (!owner) return false;
  const live = rows.filter(
    (r) => r.checkout_id === order.checkout_id && r.status !== "canceled" && r.status !== "merchant_rejected"
  );
  return live.length > 0 && live.every((r) => r.owner_id === owner);
}
