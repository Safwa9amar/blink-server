// Customer pack pricing, kept pure so it's unit-testable without a database
// (see pack-pricing.test.ts). GET /marketplace/stores/{id}/packs and
// POST /orders both price packs here (loaded by src/lib/store-packs.ts), so
// the price a customer sees is the price an order is checked against.
//
// A pack is priced from its products' LIVE prices: original = Σ price × qty,
// minus the pack's % discount. Buy-X-get-Y free units are given on top and
// never charged — the same way the merchant app prices a pack.

/** One `store_packs.items[]` entry (src/db/schema/merchant.ts PackItem). */
export interface PackItemLike {
  product_id: string;
  quantity: number;
  qty_promo_enabled?: boolean | null;
  buy_qty?: number | null;
  get_qty?: number | null;
}

/** The `store_packs` columns pricing reads. */
export interface PackRowLike {
  id: string;
  store_id: string;
  name: string;
  description?: string | null;
  image?: string | null;
  items: PackItemLike[] | null;
  discount_enabled: boolean;
  discount_percent: number;
  free_delivery: boolean;
  created_at?: string | null;
}

/** The `store_products` columns pricing reads (already filtered to customer-visible rows). */
export interface PackProductLike {
  id: string;
  title: string;
  price: number | string;
  image?: string | null;
  photos?: string[] | null;
  unit?: string | null;
}

export interface CustomerPackItem {
  product_id: string;
  name: string;
  image: string | null;
  unit: string | null;
  /** The product's live price. */
  unit_price: number;
  /** Charged units. */
  quantity: number;
  /** Free units on top (buy-X-get-Y), not charged. */
  free_qty: number;
}

export interface CustomerPack {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  image: string | null;
  /** 0 when the discount is off. */
  discount_percent: number;
  free_delivery: boolean;
  /** Σ quantity (charged units), like the merchant's "N items". */
  item_count: number;
  /** Σ unit_price × quantity — what the items cost bought separately. */
  original_price: number;
  /** original_price − savings: what one pack costs. */
  price: number;
  savings: number;
  items: CustomerPackItem[];
}

/** Snapshot of a pack's contents written on an order line (`pack_items`). */
export interface PackContent {
  name: string;
  quantity: number;
  free_qty: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Two money amounts are the same price once rounded to 2 decimals. */
export function samePrice(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Buy-X-get-Y: free units given on top of `quantity`. */
export function freeUnits(item: PackItemLike): number {
  const buy = Number(item.buy_qty ?? 0);
  const get = Number(item.get_qty ?? 0);
  if (!item.qty_promo_enabled || !(buy > 0) || !(get > 0)) return 0;
  return Math.floor(Number(item.quantity) / buy) * get;
}

/** The pack's % discount in effect: 0 when switched off. */
export function effectiveDiscountPercent(pack: Pick<PackRowLike, "discount_enabled" | "discount_percent">): number {
  const pct = Number(pack.discount_percent ?? 0);
  return pack.discount_enabled && pct > 0 ? pct : 0;
}

/**
 * Price one pack against the customer-visible products of its store. Null
 * when the pack can't be sold: no items, a bad quantity, or any product
 * missing / not visible (unavailable, not approved, another store's).
 */
export function pricePack(
  pack: PackRowLike,
  products: ReadonlyMap<string, PackProductLike>
): CustomerPack | null {
  const rows = pack.items ?? [];
  if (rows.length === 0) return null;

  const items: CustomerPackItem[] = [];
  for (const row of rows) {
    const product = products.get(row.product_id);
    const quantity = Number(row.quantity);
    if (!product || !Number.isInteger(quantity) || quantity <= 0) return null;
    items.push({
      product_id: product.id,
      name: product.title,
      image: product.image || product.photos?.[0] || null,
      unit: product.unit ?? null,
      unit_price: Number(product.price),
      quantity,
      free_qty: freeUnits(row),
    });
  }

  const originalPrice = round2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0));
  const discountPercent = effectiveDiscountPercent(pack);
  const savings = discountPercent > 0 ? Math.round((originalPrice * discountPercent) / 100) : 0;

  return {
    id: pack.id,
    store_id: pack.store_id,
    name: pack.name,
    description: pack.description ?? null,
    image: pack.image || null,
    discount_percent: discountPercent,
    free_delivery: !!pack.free_delivery,
    item_count: items.reduce((s, i) => s + i.quantity, 0),
    original_price: originalPrice,
    price: round2(originalPrice - savings),
    savings,
    items,
  };
}

/**
 * Price a store's packs, dropping the ones that can't be sold, best savings
 * first, then newest.
 */
export function pricePacks(
  packs: readonly PackRowLike[],
  products: readonly PackProductLike[]
): CustomerPack[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const priced: { pack: CustomerPack; createdAt: number }[] = [];
  for (const row of packs) {
    const pack = pricePack(row, byId);
    if (pack) priced.push({ pack, createdAt: row.created_at ? Date.parse(row.created_at) || 0 : 0 });
  }
  priced.sort((a, b) => b.pack.savings - a.pack.savings || b.createdAt - a.createdAt);
  return priced.map((p) => p.pack);
}

/** A store order line, for the delivery rule. `free_delivery` is the line's pack flag. */
export interface DeliveryLine {
  pack_id?: string | null;
  free_delivery?: boolean | null;
}

/**
 * The delivery fee of ONE store's order: free only when there is at least one
 * line and every line is a pack with free delivery; otherwise the store's
 * normal fee, charged once however many packs are taken.
 */
export function storeOrderDeliveryFee(lines: readonly DeliveryLine[], storeFee: number): number {
  const allFreePacks = lines.length > 0 && lines.every((l) => !!l.pack_id && l.free_delivery === true);
  return allFreePacks ? 0 : storeFee;
}

/** A create-order line as the client sends it. */
export interface OrderLineInput {
  name: string;
  quantity: number;
  unit_price: number;
  pack_id?: string;
}

/** A line as stored on the order. */
export interface PricedOrderLine extends OrderLineInput {
  pack_items?: PackContent[];
}

export type StoreOrderPricing =
  | {
      ok: true;
      items: PricedOrderLine[];
      subtotal: number;
      /** Always the store's fee: it's the rider's fare, even when waived. */
      delivery_fee: number;
      /** Fee the customer doesn't pay (free-delivery packs); the merchant covers it. */
      delivery_waived: number;
    }
  /** A pack line's pack is gone / not visible, or its price changed. */
  | { ok: false; pack_id: string };

/**
 * Check and price a store order's lines. Pack lines must name a pack in
 * `packs` (the store's sellable packs, priced by pricePack) at the same price;
 * they're stored with the server price, the pack name and a contents
 * snapshot. Ordinary lines keep the client's price (out of scope here).
 * Subtotal = Σ unit_price × quantity. The delivery fee stays the store's (the
 * rider is paid it); what storeOrderDeliveryFee waives is `delivery_waived`,
 * which the order takes off as a merchant-funded discount.
 */
export function priceStoreOrder(
  lines: readonly OrderLineInput[],
  packs: readonly CustomerPack[],
  storeFee: number
): StoreOrderPricing {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const items: PricedOrderLine[] = [];
  const delivery: DeliveryLine[] = [];

  for (const line of lines) {
    if (!line.pack_id) {
      items.push({ name: line.name, quantity: line.quantity, unit_price: line.unit_price });
      delivery.push({});
      continue;
    }
    const pack = byId.get(line.pack_id);
    if (!pack || !samePrice(line.unit_price, pack.price)) return { ok: false, pack_id: line.pack_id };
    items.push({
      name: pack.name,
      quantity: line.quantity,
      unit_price: pack.price,
      pack_id: pack.id,
      pack_items: pack.items.map((i) => ({ name: i.name, quantity: i.quantity, free_qty: i.free_qty })),
    });
    delivery.push({ pack_id: pack.id, free_delivery: pack.free_delivery });
  }

  return {
    ok: true,
    items,
    subtotal: round2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0)),
    delivery_fee: storeFee,
    delivery_waived: round2(storeFee - storeOrderDeliveryFee(delivery, storeFee)),
  };
}

/**
 * Product stock a store order's pack lines use up, by product id: each pack
 * sold takes its contents' charged and free units.
 */
export function packStockUsage(
  lines: readonly PricedOrderLine[],
  packs: readonly CustomerPack[]
): Map<string, number> {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const usage = new Map<string, number>();
  for (const line of lines) {
    const pack = line.pack_id ? byId.get(line.pack_id) : undefined;
    if (!pack) continue;
    for (const item of pack.items) {
      const used = (item.quantity + item.free_qty) * line.quantity;
      usage.set(item.product_id, (usage.get(item.product_id) ?? 0) + used);
    }
  }
  return usage;
}
