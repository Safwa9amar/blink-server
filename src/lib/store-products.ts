// The products a customer can actually order. GET /marketplace/stores/{id}/products,
// POST /marketplace/products/lookup and POST /orders all use this rule: available,
// and manual merchant products only once staff approved them.
import { supabaseAdmin } from "./supabase";

/** Orderable products of one store, by id and/or exact title (order creation). Throws on a query error. */
export async function loadOrderableStoreProducts(
  storeId: string,
  ids: string[],
  titles: string[]
): Promise<{ id: string; title: string; price: number | string }[]> {
  const find = async (column: "id" | "title", values: string[]) => {
    if (!values.length) return [];
    const { data, error } = await supabaseAdmin
      .from("store_products")
      .select("id, title, price")
      .eq("store_id", storeId)
      .eq("is_available", true)
      .eq("review_status", "approved")
      .in(column, values)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  const [byId, byTitle] = await Promise.all([find("id", ids), find("title", titles)]);
  return [...new Map([...byTitle, ...byId].map((p) => [p.id, p])).values()];
}
