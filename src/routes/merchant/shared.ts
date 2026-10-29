// Shared helpers for the merchant endpoints: ownership checks, period ranges,
// store sales stats and money constants.
import { normalizeWilaya, wilayaAt } from "../../lib/geo/wilaya";
import { getPrices, placeContext, pricingPlace } from "../../lib/pricing";
import { withDocumentsStatus } from "../../lib/store-documents";
import { supabaseAdmin } from "../../lib/supabase";

/** A suggested price within ±20% of the Blink reference is auto-accepted (src/lib/product-review.ts). */
export { PRICE_TOLERANCE } from "../../lib/product-review";

/** Orders the merchant still has to act on or that are on their way. */
export const ACTIVE_ORDER_STATUSES = [
  "processing",
  "searching",
  "heading_to_store",
  "preparation",
  "pickup",
  "on_the_way",
] as const;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The commission (what the merchant owes as dues) and stamp-duty rates
 * currently in force for a store (pricing config, by its owner + wilaya). Orders
 * carry their own snapshot; this is the fallback for orders created before
 * snapshots, and the "current rate" shown on the dues screen.
 */
export async function storeRatesFor(store: {
  owner_id?: string | null;
  wilaya?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}) {
  let wilaya = normalizeWilaya(typeof store.wilaya === "string" ? store.wilaya : null);
  const point =
    store.latitude != null && store.longitude != null ? { lat: Number(store.latitude), lng: Number(store.longitude) } : null;
  if (!wilaya && point) wilaya = wilayaAt(point.lat, point.lng);
  // The store's zone/tier, so a zone- or tier-scoped commission deal applies.
  const place = point ? await pricingPlace(point, { wilaya }) : null;
  const p = await getPrices(["merchant_commission_rate", "stamp_duty_rate"] as const, {
    merchantId: store.owner_id ?? null,
    ...(place ? placeContext(place) : { wilaya }),
  });
  return { commission: p.merchant_commission_rate.value.rate, stamp: p.stamp_duty_rate.value.rate };
}

/** An order's snapshot rate when it has one, else the store's current rate. */
export const snapshotRate = (snapshot: number | string | null | undefined, fallback: number) =>
  snapshot == null ? fallback : Number(snapshot);

export interface StoreRow {
  id: string;
  owner_id: string | null;
  name: string;
  status: string;
  created_at: string;
  hours: unknown;
  documents: unknown;
  [key: string]: unknown;
}

/** The merchant's stores (any status), primary first then newest. */
export async function ownedStores(userId: string): Promise<StoreRow[]> {
  const { data } = await supabaseAdmin
    .from("stores")
    .select("*")
    .eq("owner_id", userId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  return (data ?? []) as StoreRow[];
}

/** The store if the merchant owns it, else null. */
export async function ownedStore(userId: string, storeId: string): Promise<StoreRow | null> {
  const { data } = await supabaseAdmin
    .from("stores")
    .select("*")
    .eq("id", storeId)
    .eq("owner_id", userId)
    .maybeSingle();
  return (data as StoreRow) ?? null;
}

/** A product row if it belongs to one of the merchant's stores, else null. */
export async function ownedProduct(userId: string, productId: string) {
  const { data } = await supabaseAdmin
    .from("store_products")
    .select("*, store:stores!inner(owner_id)")
    .eq("id", productId)
    .eq("store.owner_id", userId)
    .maybeSingle();
  if (!data) return null;
  const { store: _store, ...product } = data as Record<string, unknown>;
  return product as Record<string, any>;
}

/** A pack row if it belongs to one of the merchant's stores, else null. */
export async function ownedPack(userId: string, packId: string) {
  const { data } = await supabaseAdmin
    .from("store_packs")
    .select("*, store:stores!inner(owner_id)")
    .eq("id", packId)
    .eq("store.owner_id", userId)
    .maybeSingle();
  if (!data) return null;
  const { store: _store, ...pack } = data as Record<string, unknown>;
  return pack as Record<string, any>;
}

/**
 * A store row as the merchant gets it (MerchantStore): stored rows may predate
 * the merchant columns, and Blink's raw per-document verdicts
 * (`document_review`, with staff ids) are replaced by the computed
 * `documents_status` (src/lib/store-documents.ts).
 */
export function normalizeStore<T extends Record<string, unknown>>(row: T) {
  return withDocumentsStatus({
    ...row,
    hours: (row.hours as unknown) ?? null,
    documents: (row.documents as unknown) ?? {},
    menu_categories: (row.menu_categories as unknown) ?? [],
  });
}

// ─── Periods ─────────────────────────────────────────────────────────

export type Period = "today" | "this_week" | "this_month" | "this_year" | "custom";

export interface Range {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
}

/** [start, end) of the period plus the equally long period right before it. */
export function periodRange(period: Period, from?: string, to?: string, now = new Date()): Range {
  let start: Date;
  let end = now;
  switch (period) {
    case "today":
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "this_week": {
      // Algerian week starts on Saturday.
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const back = (d.getDay() + 1) % 7; // Sat=0 … Fri=6
      d.setDate(d.getDate() - back);
      start = d;
      break;
    }
    case "this_month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "this_year":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "custom":
      start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
      end = to ? new Date(to) : now;
      break;
  }
  const span = Math.max(end.getTime() - start.getTime(), 60 * 60 * 1000);
  return {
    start,
    end,
    prevStart: new Date(start.getTime() - span),
    prevEnd: start,
  };
}

// ─── Orders / sales ──────────────────────────────────────────────────

export interface StoreOrder {
  id: string;
  store_id: string;
  status: string;
  merchant_status: string | null;
  subtotal: number;
  discount: number;
  total: number;
  /** `pack_id` marks a pack line (its name is the pack's name). */
  items: { name: string; quantity: number; unit_price: number; pack_id?: string }[];
  store_rating: number | null;
  created_at: string;
  /** Rates snapshotted at order time (null on orders created before snapshots). */
  merchant_commission_rate: number | null;
  stamp_duty_rate: number | null;
}

/** Orders of the given stores created in [since, until). */
export async function storeOrders(
  storeIds: string[],
  since?: Date,
  until?: Date
): Promise<StoreOrder[]> {
  if (storeIds.length === 0) return [];
  let q = supabaseAdmin
    .from("orders")
    .select(
      "id, store_id, status, merchant_status, subtotal, discount, total, items, store_rating, created_at, merchant_commission_rate, stamp_duty_rate"
    )
    .in("store_id", storeIds)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (since) q = q.gte("created_at", since.toISOString());
  if (until) q = q.lt("created_at", until.toISOString());
  const { data } = await q;
  return ((data ?? []) as StoreOrder[]).map((o) => ({
    ...o,
    subtotal: Number(o.subtotal),
    discount: Number(o.discount),
    total: Number(o.total),
    merchant_commission_rate: o.merchant_commission_rate == null ? null : Number(o.merchant_commission_rate),
    stamp_duty_rate: o.stamp_duty_rate == null ? null : Number(o.stamp_duty_rate),
  }));
}

/** Per-store lifetime delivered sales + order count. */
export async function storeSalesStats(storeIds: string[]) {
  const orders = await storeOrders(storeIds);
  const stats = new Map<string, { total_sales: number; orders_count: number }>();
  for (const id of storeIds) stats.set(id, { total_sales: 0, orders_count: 0 });
  for (const o of orders) {
    if (o.status !== "delivered") continue;
    const s = stats.get(o.store_id)!;
    s.total_sales = round2(s.total_sales + o.subtotal);
    s.orders_count += 1;
  }
  return stats;
}

/** Merchant's net from an order: goods subtotal (delivery/service fees are Blink's). */
export const orderSale = (o: Pick<StoreOrder, "subtotal">) => o.subtotal;

/** Short human reference for an order id ("#A1B2C3"). */
export const orderRef = (id: string) => `#${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
