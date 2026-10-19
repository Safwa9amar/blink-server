// Ordinary (non-pack) product lines of a store order, priced from the live
// store_products rows — never from the client. Pure, so it's unit-testable
// (see product-pricing.test.ts); POST /orders loads the rows with
// src/lib/store-products.ts and feeds the result to priceStoreOrder.
import { samePrice } from "./product-review";

/** The `store_products` columns pricing reads (already filtered to orderable rows). */
export interface OrderableProduct {
  id: string;
  title: string;
  price: number | string;
}

/** A create-order line as the client sends it (src/lib/pack-pricing.ts OrderLineInput). */
interface ProductLineInput {
  name: string;
  quantity: number;
  unit_price: number;
  pack_id?: string;
  product_id?: string;
}

/** What the 409 `product_changed` lists for an offending line. */
export interface ProductChange {
  product_id: string;
  name: string;
  /** The live price; null when it's no longer sold. */
  price: number | null;
  available: boolean;
}

export type ProductPricing<L extends ProductLineInput> =
  | { ok: true; lines: L[] }
  /** Lines with a product_id whose product is gone / unavailable or whose price moved. */
  | { ok: false; reason: "changed"; products: ProductChange[] }
  /** An older-app line (no product_id) matching no product by title. */
  | { ok: false; reason: "unavailable"; name: string };

/**
 * Replace each ordinary line with the live product: `product_id`, the product
 * title as `name`, the live price. Pack lines pass through untouched.
 *
 * A line with `product_id` must match a product in `products` at the client's
 * price, else it's listed in `changed`. A line without one (older apps, which
 * can't handle a 409) is matched by exact title and silently charged the live
 * price; no match at all is `unavailable`.
 */
export function priceProductLines<L extends ProductLineInput>(
  lines: readonly L[],
  products: readonly OrderableProduct[]
): ProductPricing<L> {
  const byId = new Map(products.map((p) => [p.id, p]));
  const byTitle = new Map<string, OrderableProduct>();
  for (const p of products) if (!byTitle.has(p.title)) byTitle.set(p.title, p);

  const out: L[] = [];
  const changed: ProductChange[] = [];
  let unknownName: string | null = null;

  for (const line of lines) {
    if (line.pack_id) {
      out.push(line);
      continue;
    }
    if (line.product_id) {
      const product = byId.get(line.product_id);
      if (!product) {
        changed.push({ product_id: line.product_id, name: line.name, price: null, available: false });
        continue;
      }
      const price = Number(product.price);
      if (!samePrice(line.unit_price, price)) {
        changed.push({ product_id: product.id, name: product.title, price, available: true });
        continue;
      }
      out.push({ ...line, product_id: product.id, name: product.title, unit_price: price });
      continue;
    }
    const product = byTitle.get(line.name);
    if (!product) {
      unknownName ??= line.name;
      continue;
    }
    out.push({ ...line, product_id: product.id, name: product.title, unit_price: Number(product.price) });
  }

  if (changed.length) return { ok: false, reason: "changed", products: changed };
  if (unknownName !== null) return { ok: false, reason: "unavailable", name: unknownName };
  return { ok: true, lines: out };
}

/** Product stock an order's product lines use up, by product id. */
export function productStockUsage(lines: readonly { product_id?: string; pack_id?: string; quantity: number }[]) {
  const usage = new Map<string, number>();
  for (const l of lines) {
    if (!l.product_id || l.pack_id) continue;
    usage.set(l.product_id, (usage.get(l.product_id) ?? 0) + l.quantity);
  }
  return usage;
}
