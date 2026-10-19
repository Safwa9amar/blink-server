// Product price history: who changed a product's price, and how a log row
// (store_product_price_changes, written by a DB trigger) reaches the API.
// Pure so it's unit-testable (see price-history.test.ts).
import type { PriceChangeSource } from "../db/schema";

/**
 * The attribution columns every writer of store_products.price / blink_price
 * sets in the same write — the trigger logs them with the change. `columns` is
 * what the write sets; it gets no attribution unless it touches a price.
 */
export function priceAttribution(
  columns: Record<string, unknown>,
  source: PriceChangeSource,
  userId: string | null
): { price_update_source?: PriceChangeSource; price_updated_by?: string | null } {
  if (!("price" in columns) && !("blink_price" in columns)) return {};
  return { price_update_source: source, price_updated_by: userId };
}

/** A store_product_price_changes row as PostgREST returns it (numeric → string). */
export interface PriceChangeRow {
  id: string;
  old_price: number | string | null;
  new_price: number | string;
  old_blink_price: number | string | null;
  new_blink_price: number | string;
  source: PriceChangeSource;
  changed_at: string;
}

const num = (v: number | string | null) => (v == null ? null : Number(v));

/** The API's ProductPriceChange: money as numbers, nulls kept (a product's first row has no "old"). */
export function toPriceChange(row: PriceChangeRow) {
  return {
    id: row.id,
    old_price: num(row.old_price),
    new_price: Number(row.new_price),
    old_blink_price: num(row.old_blink_price),
    new_blink_price: Number(row.new_blink_price),
    source: row.source,
    changed_at: row.changed_at,
  };
}

/**
 * A store_products row without its write-only attribution columns
 * (price_updated_by / price_update_source): they feed the audit trigger and are
 * never part of an API response.
 */
export function withoutPriceAttribution<T extends Record<string, any>>(
  row: T
): Omit<T, "price_updated_by" | "price_update_source"> {
  const { price_updated_by: _by, price_update_source: _source, ...rest } = row;
  return rest;
}
