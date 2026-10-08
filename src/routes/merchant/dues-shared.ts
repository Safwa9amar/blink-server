import { supabaseAdmin } from "../../lib/supabase";
import {
  COMMISSION_RATE,
  DUES_FEE_RATE,
  orderSale,
  ownedStores,
  round2,
  storeOrders,
} from "./shared";

/**
 * Outstanding dues per store: commission on all delivered sales minus every
 * completed dues payment for that store. Payments without a store (a lump
 * "all stores" payment) are spread across stores in order, oldest first.
 */
export async function computeDues(userId: string) {
  const stores = await ownedStores(userId);
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const orders = await storeOrders([...names.keys()]);

  const profit = new Map<string, number>(stores.map((s) => [s.id, 0]));
  for (const o of orders) {
    if (o.status === "delivered") profit.set(o.store_id, profit.get(o.store_id)! + orderSale(o));
  }

  const { data: payments } = await supabaseAdmin
    .from("merchant_dues_payments")
    .select("store_id, amount, status")
    .eq("merchant_id", userId)
    .eq("status", "completed");

  const owed = new Map<string, number>();
  for (const s of stores) owed.set(s.id, round2(profit.get(s.id)! * COMMISSION_RATE));

  let unassigned = 0;
  for (const p of payments ?? []) {
    const amount = Number(p.amount);
    if (p.store_id && owed.has(p.store_id)) {
      owed.set(p.store_id, owed.get(p.store_id)! - amount);
    } else {
      unassigned += amount;
    }
  }
  for (const s of stores) {
    if (unassigned <= 0) break;
    const left = owed.get(s.id)!;
    if (left <= 0) continue;
    const take = Math.min(left, unassigned);
    owed.set(s.id, left - take);
    unassigned -= take;
  }

  const rows = stores.map((s) => {
    const duesPayable = round2(Math.max(0, owed.get(s.id)!));
    return {
      store_id: s.id,
      store_name: s.name,
      total_profit: round2(profit.get(s.id)!),
      dues_payable: duesPayable,
      fees: round2(duesPayable * DUES_FEE_RATE),
    };
  });

  return {
    total_dues: round2(rows.reduce((sum, r) => sum + r.dues_payable, 0)),
    commission_rate: COMMISSION_RATE,
    stores: rows,
    names,
  };
}
