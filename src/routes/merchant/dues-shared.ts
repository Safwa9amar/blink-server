import { addSale, allocateDues, feeFromSales, type SalesByRate, type StoreDuesAllocation, type StoreSales } from "../../lib/merchant-dues";
import { supabaseAdmin } from "../../lib/supabase";
import { getPrice } from "../../lib/pricing";
import { orderSale, round2, snapshotRate, storeRatesFor } from "./shared";

const PAGE = 1000;
const CHUNK = 100;

const chunks = <T>(xs: readonly T[], n = CHUNK) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Every row of a query, by keyset pages on `id` (`page(after)` must filter
 * `id > after` when given and order by id). A failed page THROWS: dues read
 * short would look lower than they are (and could let an account be deleted
 * with dues outstanding). Stops on an empty page, so a server row cap below
 * PAGE can't end it early either.
 */
async function allRows<T extends { id: string }>(label: string, page: (after: string | null) => Page<T>) {
  const rows: T[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, error } = await page(after);
    if (error) throw new Error(`[dues] ${label} read failed: ${error.message}`);
    if (!data?.length) return rows;
    rows.push(...data);
    after = data[data.length - 1].id;
  }
}

/**
 * Lifetime delivered sales (goods subtotal) per store, and the commission owed
 * on them: each order at the rate snapshotted when it was placed, else the
 * store's current rate (`fallback`).
 */
async function deliveredSales(storeIds: string[], fallback: ReadonlyMap<string, number>) {
  const sales = new Map<string, StoreSales>();
  const byRate = new Map<string, SalesByRate>();
  for (const ids of chunks(storeIds)) {
    const orders = await allRows<{
      id: string;
      store_id: string;
      subtotal: number | string;
      merchant_commission_rate: number | string | null;
    }>("orders", (after) => {
      let q = supabaseAdmin
        .from("orders")
        .select("id, store_id, subtotal, merchant_commission_rate")
        .in("store_id", ids)
        .eq("status", "delivered");
      if (after) q = q.gt("id", after);
      return q.order("id").limit(PAGE);
    });
    for (const o of orders) {
      const sale = orderSale({ subtotal: Number(o.subtotal) });
      const prev = sales.get(o.store_id) ?? { sales: 0, commission: 0 };
      sales.set(o.store_id, { sales: prev.sales + sale, commission: 0 });
      const rates = byRate.get(o.store_id) ?? new Map<number, number>();
      byRate.set(o.store_id, rates);
      addSale(rates, snapshotRate(o.merchant_commission_rate, fallback.get(o.store_id) ?? 0), sale);
    }
  }
  for (const [storeId, rates] of byRate) sales.get(storeId)!.commission = feeFromSales(rates);
  return sales;
}

/** Completed dues payments of the given merchants. */
async function completedPayments(merchantIds: string[]) {
  type Row = { id: string; merchant_id: string; store_id: string | null; amount: number; created_at: string };
  const rows: Row[] = [];
  for (const ids of chunks(merchantIds)) {
    rows.push(
      ...(await allRows<Row>("dues payments", (after) => {
        let q = supabaseAdmin
          .from("merchant_dues_payments")
          .select("id, merchant_id, store_id, amount, created_at")
          .in("merchant_id", ids)
          .eq("status", "completed");
        if (after) q = q.gt("id", after);
        return q.order("id").limit(PAGE);
      }))
    );
  }
  return rows;
}

export interface DuesStoreRow {
  id: string;
  name: string;
  owner_id: string | null;
  /** For the store's current commission rate (a fallback for orders without a snapshot). */
  wilaya?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

export type OwnedStoreDues = StoreDuesAllocation & { merchant_id: string };

/**
 * Outstanding dues for a set of stores, each allocated within its owner's
 * stores (see allocateDues). `stores` must be in allocation order — primary
 * first, then oldest — as ownedStores returns them. Ownerless stores are skipped.
 */
export async function duesForStores(stores: readonly DuesStoreRow[]): Promise<OwnedStoreDues[]> {
  const owned = stores.filter((s): s is DuesStoreRow & { owner_id: string } => !!s.owner_id);
  const owners = [...new Set(owned.map((s) => s.owner_id))];
  const fallback = new Map(
    await Promise.all(owned.map(async (s) => [s.id, (await storeRatesFor(s)).commission] as const))
  );
  const [sales, payments, feeRate] = await Promise.all([
    deliveredSales(owned.map((s) => s.id), fallback),
    completedPayments(owners),
    getPrice("dues_payment_fee_rate").then((p) => p.value.rate),
  ]);

  return owners.flatMap((owner) =>
    allocateDues(
      owned.filter((s) => s.owner_id === owner),
      sales,
      payments.filter((p) => p.merchant_id === owner),
      feeRate
    ).map((row) => ({ ...row, merchant_id: owner }))
  );
}

/**
 * The merchant's stores in allocation order (primary first, then oldest).
 * Throws on a failed read: no stores would mean no dues.
 */
async function duesStoresOf(userId: string): Promise<DuesStoreRow[]> {
  const { data, error } = await supabaseAdmin
    .from("stores")
    .select("id, name, owner_id, wilaya, latitude, longitude")
    .eq("owner_id", userId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[dues] stores read failed: ${error.message}`);
  return (data ?? []) as DuesStoreRow[];
}

/**
 * Outstanding dues per store: commission on all delivered sales minus every
 * completed dues payment for that store. Payments without a store (a lump
 * "all stores" payment) are spread across stores in order, oldest first.
 */
export async function computeDues(userId: string) {
  const stores = await duesStoresOf(userId);
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const dues = await duesForStores(stores);

  const rows = dues.map((d) => ({
    store_id: d.store_id,
    store_name: d.store_name,
    total_profit: d.total_profit,
    dues_payable: d.dues_payable,
    fees: d.fees,
  }));

  return {
    total_dues: round2(rows.reduce((sum, r) => sum + r.dues_payable, 0)),
    // The store's current effective rate (orders keep the rate they were placed under).
    commission_rate: (await storeRatesFor(stores[0] ?? {})).commission,
    stores: rows,
    names,
  };
}
