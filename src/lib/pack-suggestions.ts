// Pack (bundle) ideas for a store, built from its real catalog and delivered
// orders — kept pure so it's unit-testable (see pack-suggestions.test.ts).
// GET /merchant/stores/{id}/pack-suggestions returns them; the merchant app
// localizes each one by `kind` (no free text here) and can create it as is
// (POST /merchant/stores/{id}/packs).
//
// - bought_together: two products found in the same order at least twice.
// - top_sellers: the store's best sellers (by units) together.
// - category_multibuy: buy 2 get 1 on the best-selling category's top items.
// - starter: catalog picks for a store with no order history to learn from.
import { createHash } from "node:crypto";

export type PackSuggestionKind = "bought_together" | "top_sellers" | "category_multibuy" | "starter";

/** The `store_products` columns the builder reads. */
export interface SuggestionProduct {
  id: string;
  title: string;
  price: number | string;
  image?: string | null;
  photos?: string[] | null;
  category?: string | null;
  is_available: boolean;
  review_status: string;
}

/** A delivered order of the store (order lines match products by title). */
export interface SuggestionOrder {
  items: { name: string; quantity: number; pack_id?: string | null }[] | null;
}

/** An existing pack of the store (non-archived ones block a duplicate idea). */
export interface ExistingPack {
  status: string;
  items: { product_id: string }[] | null;
}

export interface PackSuggestionItem {
  product_id: string;
  name: string;
  image: string | null;
  unit_price: number;
  /** Charged units. */
  quantity: number;
  qty_promo_enabled: boolean;
  buy_qty: number;
  get_qty: number;
}

export interface PackSuggestion {
  /** Stable across calls for the same idea (kind + products). */
  id: string;
  kind: PackSuggestionKind;
  product_ids: string[];
  items: PackSuggestionItem[];
  discount_percent: number;
  /** Σ unit_price × quantity. */
  original_price: number;
  /** What one pack would cost (same rule as src/lib/pack-pricing.ts). */
  price: number;
  params: { category?: string; orders_count?: number };
}

export const MAX_SUGGESTIONS = 6;
/** Pairs bought together in at least this many orders. */
export const MIN_PAIR_ORDERS = 2;
const BUNDLE_DISCOUNT = 10;
/** Cap per order on the products considered for pairs (keeps pairing O(n²) small). */
const MAX_LINES_PER_ORDER = 30;

const round2 = (n: number) => Math.round(n * 100) / 100;
const titleKey = (s: string) => s.trim().toLowerCase();

function suggestionId(kind: PackSuggestionKind, productIds: string[]) {
  const hash = createHash("sha1").update(`${kind}:${productIds.join(",")}`).digest("hex").slice(0, 12);
  return `${kind}-${hash}`;
}

const setKey = (ids: readonly string[]) => [...new Set(ids)].sort().join(",");

function suggestion(
  kind: PackSuggestionKind,
  lines: { product: SuggestionProduct; quantity: number; promo?: [number, number] }[],
  discountPercent: number,
  params: PackSuggestion["params"]
): PackSuggestion {
  const items: PackSuggestionItem[] = lines.map(({ product, quantity, promo }) => ({
    product_id: product.id,
    name: product.title,
    image: product.image || product.photos?.[0] || null,
    unit_price: Number(product.price),
    quantity,
    qty_promo_enabled: !!promo,
    buy_qty: promo?.[0] ?? 2,
    get_qty: promo?.[1] ?? 1,
  }));
  const originalPrice = round2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0));
  const savings = discountPercent > 0 ? Math.round((originalPrice * discountPercent) / 100) : 0;
  const productIds = [...new Set(items.map((i) => i.product_id))].sort();
  return {
    id: suggestionId(kind, productIds),
    kind,
    product_ids: productIds,
    items,
    discount_percent: discountPercent,
    original_price: originalPrice,
    price: round2(originalPrice - savings),
    params,
  };
}

/** Up to `n` products, preferring a different category for each pick. */
function spread(pool: readonly SuggestionProduct[], n: number) {
  const picked: SuggestionProduct[] = [];
  const seen = new Set<string>();
  for (const p of pool) {
    if (picked.length >= n) break;
    const cat = titleKey(p.category ?? "");
    if (cat && seen.has(cat)) continue;
    picked.push(p);
    if (cat) seen.add(cat);
  }
  for (const p of pool) {
    if (picked.length >= n) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked;
}

export function buildPackSuggestions(
  products: readonly SuggestionProduct[],
  orders: readonly SuggestionOrder[],
  existingPacks: readonly ExistingPack[] = [],
  max = MAX_SUGGESTIONS
): PackSuggestion[] {
  const live = products.filter(
    (p) => p.review_status === "approved" && p.is_available && Number(p.price) > 0
  );
  const byTitle = new Map<string, SuggestionProduct>();
  for (const p of live) if (!byTitle.has(titleKey(p.title))) byTitle.set(titleKey(p.title), p);
  const byId = new Map(live.map((p) => [p.id, p]));

  // ── What sold, and what sold together ────────────────────────────
  const units = new Map<string, number>();
  const orderCount = new Map<string, number>();
  const pairs = new Map<string, number>();
  const orderSets: Set<string>[] = [];
  for (const o of orders) {
    const ids = new Set<string>();
    for (const line of o.items ?? []) {
      if (line.pack_id) continue;
      const p = byTitle.get(titleKey(line.name ?? ""));
      if (!p) continue;
      ids.add(p.id);
      units.set(p.id, (units.get(p.id) ?? 0) + (Number(line.quantity) || 0));
    }
    if (ids.size === 0) continue;
    orderSets.push(ids);
    for (const id of ids) orderCount.set(id, (orderCount.get(id) ?? 0) + 1);
    const sorted = [...ids].sort().slice(0, MAX_LINES_PER_ORDER);
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]},${sorted[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  const ordersWithAny = (ids: readonly string[]) => orderSets.filter((s) => ids.some((id) => s.has(id))).length;

  const ranked = [...units.keys()]
    .map((id) => byId.get(id)!)
    .sort(
      (a, b) =>
        (units.get(b.id) ?? 0) - (units.get(a.id) ?? 0) ||
        (orderCount.get(b.id) ?? 0) - (orderCount.get(a.id) ?? 0) ||
        a.id.localeCompare(b.id)
    );

  const ideas: PackSuggestion[] = [];

  // ── Bought together ──────────────────────────────────────────────
  const topPairs = [...pairs.entries()]
    .filter(([, n]) => n >= MIN_PAIR_ORDERS)
    .map(([key, n]) => ({ ids: key.split(","), n }))
    .sort(
      (a, b) =>
        b.n - a.n ||
        (units.get(b.ids[0])! + units.get(b.ids[1])!) - (units.get(a.ids[0])! + units.get(a.ids[1])!) ||
        a.ids.join().localeCompare(b.ids.join())
    )
    .slice(0, 2);
  for (const { ids, n } of topPairs) {
    ideas.push(
      suggestion(
        "bought_together",
        ids.map((id) => ({ product: byId.get(id)!, quantity: 1 })),
        BUNDLE_DISCOUNT,
        { orders_count: n }
      )
    );
  }

  // ── Top sellers ──────────────────────────────────────────────────
  if (ranked.length >= 2) {
    const top = ranked.slice(0, 3);
    ideas.push(
      suggestion(
        "top_sellers",
        top.map((product) => ({ product, quantity: 1 })),
        BUNDLE_DISCOUNT,
        { orders_count: ordersWithAny(top.map((p) => p.id)) }
      )
    );
  }

  // ── Buy 2 get 1 on the best-selling category ─────────────────────
  const categoryUnits = new Map<string, number>();
  for (const p of ranked) {
    const cat = (p.category ?? "").trim();
    if (cat) categoryUnits.set(cat, (categoryUnits.get(cat) ?? 0) + (units.get(p.id) ?? 0));
  }
  const bestCategory = [...categoryUnits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (bestCategory) {
    const inCategory = ranked.filter((p) => (p.category ?? "").trim() === bestCategory).slice(0, 2);
    ideas.push(
      suggestion(
        "category_multibuy",
        inCategory.map((product) => ({ product, quantity: 2, promo: [2, 1] as [number, number] })),
        0,
        { category: bestCategory, orders_count: ordersWithAny(inCategory.map((p) => p.id)) }
      )
    );
  }

  // ── Starter: nothing to learn from yet → catalog picks ───────────
  if (ideas.length === 0 && live.length > 0) {
    const pool = [...live].sort(
      (a, b) =>
        Number(!!(b.image || b.photos?.length)) - Number(!!(a.image || a.photos?.length)) ||
        Number(b.price) - Number(a.price) ||
        a.id.localeCompare(b.id)
    );
    if (pool.length === 1) {
      ideas.push(suggestion("starter", [{ product: pool[0], quantity: 2, promo: [2, 1] }], 0, {}));
    } else {
      const first = spread(pool, 3);
      ideas.push(suggestion("starter", first.map((product) => ({ product, quantity: 1 })), BUNDLE_DISCOUNT, {}));
      const rest = pool.filter((p) => !first.includes(p));
      if (rest.length >= 2) {
        const second = spread(rest, 3);
        ideas.push(suggestion("starter", second.map((product) => ({ product, quantity: 1 })), BUNDLE_DISCOUNT, {}));
      }
    }
  }

  // ── Skip ideas the store already has (or that repeat one another) ─
  const taken = new Set(
    existingPacks
      .filter((p) => p.status !== "archived")
      .map((p) => setKey((p.items ?? []).map((i) => i.product_id)))
  );
  const out: PackSuggestion[] = [];
  for (const idea of ideas) {
    const key = setKey(idea.product_ids);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(idea);
    if (out.length >= max) break;
  }
  return out;
}
