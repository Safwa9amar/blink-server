// Pure rules behind the staff Blink Cash API (routes/blink-cash/admin-*.ts):
// reconciliation math, who may adjust a wallet and by how much, and mapping the
// ledger's SQL errors (spec 2026-10-16-blink-cash-full-design §1, §7) to HTTP.
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** |ledger − expected| above this is drift. */
export const DRIFT_TOLERANCE = 0.01;

// ─── Reconciliation ──────────────────────────────────────────────────

export type LedgerEntryLite = { kind: string; amount: number | string; idempotency_key?: string | null };

/**
 * Entries the derived formula (deposits, withdrawals, trips, rewards) can't see:
 * staff adjustments, offer bonuses and the reversal of a bonus. A reversal of a
 * deposit / withdrawal is NOT counted — the derived path drops reversed rows too.
 */
export function isExtraEntry(e: LedgerEntryLite): boolean {
  if (e.kind === "adjustment" || e.kind === "offer_bonus") return true;
  return e.kind === "reversal" && (e.idempotency_key ?? "").startsWith("reverse-bonus:");
}

export function extraEntriesTotal(entries: readonly LedgerEntryLite[]): number {
  let t = 0;
  for (const e of entries) if (isExtraEntry(e)) t += Number(e.amount);
  return round2(t);
}

export type WalletReconciliation = { ledger: number; expected: number; diff: number; drift: boolean };

/** ledger.balance vs riderWalletDerived().total + Σ(adjustment, offer_bonus). */
export function reconcileWallet(input: {
  ledgerBalance: number;
  derivedTotal: number;
  extras: number;
}): WalletReconciliation {
  const ledger = round2(input.ledgerBalance);
  const expected = round2(input.derivedTotal + input.extras);
  const diff = round2(ledger - expected);
  return { ledger, expected, diff, drift: Math.abs(diff) > DRIFT_TOLERANCE };
}

export type ReconciliationTotals = { circulation: number; held: number; wallets: number; drift_count: number };

export function reconciliationTotals(
  wallets: readonly { balance: number; held: number; drift: boolean }[]
): ReconciliationTotals {
  let circulation = 0;
  let held = 0;
  let drift_count = 0;
  for (const w of wallets) {
    circulation += w.balance;
    held += w.held;
    if (w.drift) drift_count++;
  }
  return { circulation: round2(circulation), held: round2(held), wallets: wallets.length, drift_count };
}

// ─── Adjustments ─────────────────────────────────────────────────────

export type AdjustDecision =
  | { ok: true; allowNegative: boolean }
  | { ok: false; status: 400 | 403 | 409; code: "invalid_amount" | "adjust_limit_exceeded" | "insufficient_funds" };

/**
 * super_admin: unlimited, may take a wallet negative. finance_admin: at most
 * `limit` (adjust_limit_finance_admin) per adjustment, and never below 0.
 */
export function checkAdjust(input: {
  staffRole: string | null | undefined;
  amount: number;
  limit: number;
  balance: number;
}): AdjustDecision {
  const { staffRole, amount, limit, balance } = input;
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, status: 400, code: "invalid_amount" };
  if (staffRole === "super_admin") return { ok: true, allowNegative: true };
  if (Math.abs(amount) > limit) return { ok: false, status: 403, code: "adjust_limit_exceeded" };
  if (round2(balance + amount) < 0) return { ok: false, status: 409, code: "insufficient_funds" };
  return { ok: true, allowNegative: false };
}

// ─── SQL error mapping ───────────────────────────────────────────────

export const WALLET_ERROR_CODES = [
  "insufficient_funds",
  "wallet_frozen",
  "not_pending",
  "expired",
  "wrong_agent",
  "not_found",
  "not_completed",
  "not_in_review",
] as const;
export type WalletErrorCode = (typeof WALLET_ERROR_CODES)[number];

const MESSAGES: Record<WalletErrorCode, string> = {
  insufficient_funds: "Insufficient funds in the wallet",
  wallet_frozen: "The wallet is frozen",
  not_pending: "The transaction is not pending",
  expired: "The transaction has expired",
  wrong_agent: "The transaction belongs to another agent",
  not_found: "Not found",
  not_completed: "The transaction is not completed",
  not_in_review: "The transaction is not awaiting review",
};

/**
 * A Postgres `raise exception` from blink_wallet_post / blink_cash_* (code P0001,
 * message = one of WALLET_ERROR_CODES) → 404 / 409 body. Null for anything else
 * (the caller rethrows it).
 */
export function mapWalletError(
  err: { code?: string | null; message?: string | null } | null | undefined
): { status: 404 | 409; body: { error: string; code: WalletErrorCode } } | null {
  if (!err || err.code !== "P0001") return null;
  const msg = (err.message ?? "").trim();
  const code = WALLET_ERROR_CODES.find((c) => msg === c) ?? WALLET_ERROR_CODES.find((c) => msg.includes(c));
  if (!code) return null;
  return { status: code === "not_found" ? 404 : 409, body: { error: MESSAGES[code], code } };
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}
