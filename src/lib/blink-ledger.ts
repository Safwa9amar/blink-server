// Ledger backfill + reconciliation (spec §1). Backfill runs backfillRider (the
// same per-rider step a first withdrawal uses lazily); reconciliation takes the
// derived rider balance (riderWalletDerived) as a parameter, the maths stays in
// blink-cash-admin.ts.
import { fetchAllRows } from "./agent-finance";
import {
  extraEntriesTotal,
  mapLimit,
  reconcileWallet,
  reconciliationTotals,
  type LedgerEntryLite,
  type ReconciliationTotals,
} from "./blink-cash-admin";
import { supabaseAdmin } from "./supabase";
import { backfillRider } from "./wallet-backfill";

export type DerivedWallet = (riderId: string) => Promise<{ total: number }>;

const CONCURRENCY = 8;

type WalletRow = { id: string; user_id: string; balance: number | string; held: number | string; backfilled_at: string | null };

const riderIds = () =>
  fetchAllRows<{ user_id: string }>((from, to) =>
    supabaseAdmin.from("rider_profiles").select("user_id").order("user_id").range(from, to) as any
  ).then((rows) => rows.map((r) => r.user_id));

export type BackfillResult = {
  riders: number;
  backfilled: number;
  already_backfilled: number;
  zero_opening: number;
  failed: { user_id: string; error: string }[];
};

/**
 * One-off: backfillRider for every rider (opening = derived total − Σ posted
 * entries the derived formula knows about, then `backfilled_at`). Wallets
 * already stamped are skipped, so re-running is safe.
 */
export async function backfillWallets(): Promise<BackfillResult> {
  const ids = await riderIds();
  const result: BackfillResult = { riders: ids.length, backfilled: 0, already_backfilled: 0, zero_opening: 0, failed: [] };

  await mapLimit(ids, CONCURRENCY, async (userId) => {
    try {
      const r = await backfillRider(userId);
      if (r.already) result.already_backfilled++;
      else {
        result.backfilled++;
        if (r.opening === 0) result.zero_opening++;
      }
    } catch (e) {
      result.failed.push({ user_id: userId, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return result;
}

export type ReconciliationRow = {
  user_id: string;
  ledger: number;
  expected: number;
  diff: number;
};

export type ReconciliationReport = { generated_at: string; totals: ReconciliationTotals; mismatches: ReconciliationRow[] };

/** Per backfilled wallet: ledger balance vs derived total + staff / bonus entries. */
export async function reconcileWallets(derived: DerivedWallet): Promise<ReconciliationReport> {
  const wallets = await fetchAllRows<WalletRow>((from, to) =>
    supabaseAdmin
      .from("blink_wallets")
      .select("id, user_id, balance, held, backfilled_at")
      .eq("role", "rider")
      .not("backfilled_at", "is", null)
      .order("id")
      .range(from, to) as any
  );

  const rows = await mapLimit(wallets, CONCURRENCY, async (w) => {
    const [entries, d] = await Promise.all([
      fetchAllRows<LedgerEntryLite>((from, to) =>
        supabaseAdmin
          .from("blink_wallet_entries")
          .select("kind, amount, idempotency_key")
          .eq("wallet_id", w.id)
          .in("kind", ["adjustment", "offer_bonus", "reversal"])
          .order("created_at")
          .range(from, to) as any
      ),
      derived(w.user_id),
    ]);
    const rec = reconcileWallet({ ledgerBalance: Number(w.balance), derivedTotal: d.total, extras: extraEntriesTotal(entries) });
    return { w, rec };
  });

  return {
    generated_at: new Date().toISOString(),
    totals: reconciliationTotals(rows.map(({ w, rec }) => ({ balance: Number(w.balance), held: Number(w.held), drift: rec.drift }))),
    mismatches: rows
      .filter(({ rec }) => rec.drift)
      .map(({ w, rec }) => ({ user_id: w.user_id, ledger: rec.ledger, expected: rec.expected, diff: rec.diff })),
  };
}
