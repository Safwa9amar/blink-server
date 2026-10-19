// Merchant dues (the commission Blink takes on a store's delivered sales),
// kept pure so it's unit-testable (see merchant-dues.test.ts). The merchant's
// Blink Cash (GET /merchant/dues), paying dues, account deletion and the staff
// dues overview (GET /merchant/admin/dues) all allocate through `allocateDues`
// (loaded by src/routes/merchant/dues-shared.ts).

export interface DuesStoreLike {
  id: string;
  name: string;
}

export interface DuesPaymentLike {
  store_id: string | null;
  amount: number | string;
  created_at?: string | null;
}

/** A store's lifetime delivered sales and the commission owed on them (each order at its own rate). */
export interface StoreSales {
  sales: number;
  commission: number;
}

export interface StoreDuesAllocation {
  store_id: string;
  store_name: string;
  /** Lifetime delivered sales (goods subtotal). */
  total_profit: number;
  /** Commission owed on those sales. */
  commission: number;
  /** Completed payments counted against this store (its own + its share of all-stores payments). */
  paid: number;
  /** Still owed (never negative). */
  dues_payable: number;
  /** Processing fee on the outstanding amount. */
  fees: number;
  /** Latest payment counted against this store. */
  last_payment_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sales accumulated per distinct rate (so a single-rate book rounds exactly once, as it always did). */
export type SalesByRate = Map<number, number>;

export function addSale(by: SalesByRate, rate: number, sale: number): void {
  by.set(rate, (by.get(rate) ?? 0) + sale);
}

/** Σ round2(Σsales × rate) over the distinct rates; one rate == round2(Σsale × rate). */
export function feeFromSales(by: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const [rate, sum] of by) total += round2(sum * rate);
  return round2(total);
}

const later = (a: string | null, b: string | null | undefined) =>
  !b ? a : !a || Date.parse(b) > Date.parse(a) ? b : a;

/**
 * Outstanding dues per store of ONE merchant: commission on delivered sales
 * minus every completed payment for that store. Payments without a (known)
 * store — a lump "all stores" payment — are spread across the stores in the
 * given order (primary first, then oldest).
 */
export function allocateDues(
  stores: readonly DuesStoreLike[],
  salesByStore: ReadonlyMap<string, StoreSales>,
  payments: readonly DuesPaymentLike[],
  /** Processing fee rate on the outstanding amount (`dues_payment_fee_rate`). */
  feeRate: number
): StoreDuesAllocation[] {
  const owed = new Map<string, number>();
  const paid = new Map<string, number>();
  const lastAt = new Map<string, string | null>();
  for (const s of stores) {
    owed.set(s.id, round2(salesByStore.get(s.id)?.commission ?? 0));
    paid.set(s.id, 0);
    lastAt.set(s.id, null);
  }

  let unassigned = 0;
  let lumpAt: string | null = null;
  for (const p of payments) {
    const amount = Number(p.amount);
    if (p.store_id && owed.has(p.store_id)) {
      owed.set(p.store_id, owed.get(p.store_id)! - amount);
      paid.set(p.store_id, paid.get(p.store_id)! + amount);
      lastAt.set(p.store_id, later(lastAt.get(p.store_id)!, p.created_at));
    } else {
      unassigned += amount;
      lumpAt = later(lumpAt, p.created_at);
    }
  }
  for (const s of stores) {
    if (unassigned <= 0) break;
    const left = owed.get(s.id)!;
    if (left <= 0) continue;
    const take = Math.min(left, unassigned);
    owed.set(s.id, left - take);
    paid.set(s.id, paid.get(s.id)! + take);
    lastAt.set(s.id, later(lastAt.get(s.id)!, lumpAt));
    unassigned -= take;
  }

  return stores.map((s) => {
    const duesPayable = round2(Math.max(0, owed.get(s.id)!));
    return {
      store_id: s.id,
      store_name: s.name,
      total_profit: round2(salesByStore.get(s.id)?.sales ?? 0),
      commission: round2(salesByStore.get(s.id)?.commission ?? 0),
      paid: round2(paid.get(s.id)!),
      dues_payable: duesPayable,
      fees: round2(duesPayable * feeRate),
      last_payment_at: lastAt.get(s.id)!,
    };
  });
}

// ─── Staff reminder (POST /merchant/admin/dues/{store_id}/remind) ────

type Copy = { title: string; description: string };
export type DuesReminderCopy = { en: Copy; fr: Copy; ar: Copy };

/** The merchant app's Blink Cash screen, where dues are paid. */
export const BLINK_CASH_HREF = "/(merchant)/blink-cash";

/** At most one dues reminder per store per day. */
export const DUES_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Was this store's owner reminded less than DUES_REMINDER_COOLDOWN_MS ago?
 * `lastSentAt` = created_at of its latest `dues_reminder` notification.
 */
export function remindedRecently(
  lastSentAt: string | null | undefined,
  now: number = Date.now(),
  cooldownMs = DUES_REMINDER_COOLDOWN_MS
): boolean {
  const at = Date.parse(lastSentAt ?? "");
  return !Number.isNaN(at) && now - at < cooldownMs;
}

export function duesReminderCopy(amount: number, store: string): DuesReminderCopy {
  const a = String(round2(amount));
  return {
    en: {
      title: "Outstanding dues",
      description: `You have ${a} Da in outstanding dues for ${store}. Pay them from Blink Cash.`,
    },
    fr: {
      title: "Dus en attente",
      description: `Vous avez ${a} Da de dus en attente pour ${store}. Réglez-les depuis Blink Cash.`,
    },
    ar: {
      title: "مستحقات غير مسددة",
      description: `لديك ${a} دج من المستحقات غير المسددة لـ ${store}. سدّدها من Blink Cash.`,
    },
  };
}
