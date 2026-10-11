// Loads a store's packs as customers can buy them. GET
// /marketplace/stores/{id}/packs and POST /orders (pack lines) both go
// through here, so an order is checked against exactly what the store page
// showed. Pricing is pure: src/lib/pack-pricing.ts.
import { pricePacks, type CustomerPack, type PackRowLike } from "./pack-pricing";
import { supabaseAdmin } from "./supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The store's sellable packs, priced, best savings first. Only `active`
 * packs, and only those whose every product is visible to customers (same
 * rule as GET /stores/{id}/products: this store's, available, approved).
 * `packIds` narrows the lookup (order creation). Throws on a query error.
 */
export async function loadVisiblePacks(storeId: string, packIds?: string[]): Promise<CustomerPack[]> {
  if (packIds && packIds.length === 0) return [];

  let query = supabaseAdmin
    .from("store_packs")
    .select("id, store_id, name, description, image, items, discount_enabled, discount_percent, free_delivery, created_at")
    .eq("store_id", storeId)
    .eq("status", "active");
  if (packIds) query = query.in("id", packIds);
  const { data: packs, error } = await query;
  if (error) throw new Error(error.message);
  if (!packs?.length) return [];

  // Pack items name products by a free-form string; a non-uuid can't match a
  // product (and would fail the uuid `in` filter), so its pack is just dropped.
  const productIds = [
    ...new Set(
      (packs as PackRowLike[]).flatMap((p) => (p.items ?? []).map((i) => i.product_id)).filter((id) => UUID.test(id))
    ),
  ];
  if (!productIds.length) return [];

  const { data: products, error: productsError } = await supabaseAdmin
    .from("store_products")
    .select("id, title, price, image, photos, unit")
    .eq("store_id", storeId)
    .eq("is_available", true)
    .eq("review_status", "approved")
    .in("id", productIds);
  if (productsError) throw new Error(productsError.message);

  return pricePacks(packs as PackRowLike[], products ?? []);
}
