// "Get it all from one branch": a cart can hold several stores of the same
// merchant account. When one of those stores (already in the cart) sells
// every item of the merchant's other in-cart stores, moving them there drops a
// pickup stop and a delivery fee. Suggested only when the new total (item
// prices + delivery fees) is the same or lower. Products match on the shared
// catalog id (`library_product_id`), else on a non-empty barcode.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_CART_LINES = 60;

export interface CartLine {
  product_id: string;
  store_id: string;
  quantity: number;
  /** The product's current price (database, not the client's copy). */
  price: number;
  library_product_id: string | null;
  barcode: string;
}

export interface BranchStore {
  id: string;
  name: string;
  owner_id: string | null;
  delivery_fee: number;
  /** Active and open right now (storeOpenState). */
  open: boolean;
}

/** A storefront-visible product of a candidate target store. */
export interface BranchProduct {
  id: string;
  store_id: string;
  title: string;
  price: number;
  image: string;
  library_product_id: string | null;
  barcode: string;
}

export interface BranchSuggestion {
  to_store: { id: string; name: string };
  from_store_ids: string[];
  swaps: {
    from_product_id: string;
    to_product: { id: string; title: string; price: number; image: string };
  }[];
  /** old total − new total, ≥ 0. */
  saving: number;
}

/** `"<uuid>:<qty>,<uuid>:<qty>"` → lines; malformed pairs are dropped. */
export function parseCartItems(raw: string): { product_id: string; quantity: number }[] {
  const out: { product_id: string; quantity: number }[] = [];
  for (const pair of raw.split(",")) {
    const [id, qty] = pair.trim().split(":");
    const quantity = Number(qty);
    if (!id || !UUID_RE.test(id) || !Number.isInteger(quantity) || quantity <= 0) continue;
    out.push({ product_id: id, quantity });
    if (out.length === MAX_CART_LINES) break;
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Stores with `delivery_fee` replaced by what checkout charges for them (the
 * quoteStoreDelivery fee at the customer point), so the saving matches the
 * order: a store absent from `fees` keeps its merchant fee.
 */
export function withQuotedFees(stores: Map<string, BranchStore>, fees: Map<string, number>): Map<string, BranchStore> {
  return new Map([...stores].map(([id, s]) => [id, fees.has(id) ? { ...s, delivery_fee: fees.get(id)! } : s]));
}

function findMatch(line: CartLine, products: BranchProduct[]): BranchProduct | undefined {
  if (line.library_product_id) {
    const byLibrary = products.find((p) => p.library_product_id === line.library_product_id);
    if (byLibrary) return byLibrary;
  }
  if (line.barcode) return products.find((p) => p.barcode === line.barcode);
  return undefined;
}

interface Candidate extends BranchSuggestion {
  targetLines: number;
}

/** The best single-branch move for the cart, or null when none is worth it. */
export function bestBranchMove(
  lines: CartLine[],
  stores: Map<string, BranchStore>,
  products: BranchProduct[]
): BranchSuggestion | null {
  const storesByOwner = new Map<string, string[]>();
  for (const l of lines) {
    const owner = stores.get(l.store_id)?.owner_id;
    if (!owner) continue;
    const list = storesByOwner.get(owner) ?? [];
    if (!list.includes(l.store_id)) list.push(l.store_id);
    storesByOwner.set(owner, list);
  }

  let best: Candidate | null = null;
  for (const storeIds of storesByOwner.values()) {
    if (storeIds.length < 2) continue;
    const ownerLines = lines.filter((l) => storeIds.includes(l.store_id));
    const fees = storeIds.reduce((n, id) => n + (stores.get(id)?.delivery_fee ?? 0), 0);
    const oldTotal = ownerLines.reduce((n, l) => n + l.price * l.quantity, 0) + fees;

    for (const targetId of [...storeIds].sort()) {
      const target = stores.get(targetId);
      if (!target?.open) continue;
      const targetProducts = products.filter((p) => p.store_id === targetId);
      const swaps: BranchSuggestion["swaps"] = [];
      let newTotal = target.delivery_fee;
      let ok = true;
      for (const l of ownerLines) {
        if (l.store_id === targetId) {
          newTotal += l.price * l.quantity;
          continue;
        }
        const match = findMatch(l, targetProducts);
        if (!match) {
          ok = false;
          break;
        }
        swaps.push({
          from_product_id: l.product_id,
          to_product: { id: match.id, title: match.title, price: match.price, image: match.image },
        });
        newTotal += match.price * l.quantity;
      }
      if (!ok) continue;
      const saving = round2(oldTotal - newTotal);
      if (saving < 0) continue;
      const targetLines = ownerLines.filter((l) => l.store_id === targetId).length;
      const better =
        !best ||
        saving > best.saving ||
        (saving === best.saving && targetLines > best.targetLines);
      if (better) {
        best = {
          to_store: { id: target.id, name: target.name },
          from_store_ids: storeIds.filter((id) => id !== targetId),
          swaps,
          saving,
          targetLines,
        };
      }
    }
  }
  if (!best) return null;
  const { targetLines: _targetLines, ...suggestion } = best;
  return suggestion;
}
