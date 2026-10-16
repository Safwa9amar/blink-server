// Ledger backfill + reconciliation (spec §1). The derived rider balance is passed
// in (riderWallet today, riderWalletDerived after the ledger lands) so this file
// stays free of the dispatch import and the maths stays in blink-cash-admin.ts.
import { fetchAllRows } from "./agent-finance";
import {
  extraEntriesTotal,
  mapLimit,
  openingAmount,
  reconcileWallet,
  reconciliationTotals,
  type LedgerEntryLite,
  type ReconciliationTotals,
} from "./blink-cash-admin";
import { supabaseAdmin } from "./supabase";

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
 * One-off: for each rider post `opening:<user>` = derived total − Σ already
 * posted entries, then stamp `backfilled_at`. Wallets already stamped are
 * skipped, so re-running is safe (the entry itself is idempotent by key too).
 */
export async function backfillWallets(derived: DerivedWallet, actorId: string): Promise<BackfillResult> {
  const ids = await riderIds();
  const result: BackfillResult = { riders: ids.length, backfilled: 0, already_backfilled: 0, zero_opening: 0, failed: [] };

  await mapLimit(ids, CONCURRENCY, async (userId) => {
    try {
      const { error: upsertError } = await supabaseAdmin
        .from("blink_wallets")
        .upsert({ user_id: userId, role: "rider" }, { onConflict: "user_id,role", ignoreDuplicates: true });
      if (upsertError) throw new Error(upsertError.message);

      const { data: wallet, error: walletError } = await supabaseAdmin
        .from("blink_wallets")
        .select("id, backfilled_at")
        .eq("user_id", userId)
        .eq("role", "rider")
        .single();
      if (walletError || !wallet) throw new Error(walletError?.message ?? "wallet missing");
      if (wallet.backfilled_at) {
        result.already_backfilled++;
        return;
      }

      const posted = await fetchAllRows<{ amount: number | string }>((from, to) =>
        supabaseAdmin.from("blink_wallet_entries").select("amount").eq("wallet_id", wallet.id).order("created_at").range(from, to) as any
      );
      const postedSum = posted.reduce((a, e) => a + Number(e.amount), 0);
      const opening = openingAmount((await derived(userId)).total, postedSum);

      if (opening !== 0) {
        const { error } = await supabaseAdmin.rpc("blink_wallet_post", {
          p_user: userId,
          p_role: "rider",
          p_amount: opening,
          p_kind: "opening_balance",
          p_idem: `opening:${userId}`,
          p_memo: "Opening balance (ledger backfill)",
          p_actor: actorId,
          p_allow_negative: true,
        });
        if (error) throw new Error(error.message);
      } else {
        result.zero_opening++;
      }

      const { error: stampError } = await supabaseAdmin
        .from("blink_wallets")
        .update({ backfilled_at: new Date().toISOString() })
        .eq("id", wallet.id);
      if (stampError) throw new Error(stampError.message);
      result.backfilled++;
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
