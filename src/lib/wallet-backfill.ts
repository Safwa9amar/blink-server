// Moving a rider from the derived balance onto the ledger: one `opening_balance`
// entry (`opening:<user_id>`) holding whatever the derived balance has that the
// ledger has not posted yet, then `backfilled_at` marks the wallet as the
// source of truth. Safe to re-run. Used by the staff backfill and, lazily, by
// the first withdrawal of a rider who was not backfilled yet.
import { riderWalletDerived } from "./dispatch";
import { fetchAllRows } from "./agent-finance";
import { supabaseAdmin } from "./supabase";

/** Entry kinds the derived balance does not know about (reconciliation adds them back). */
export const NON_DERIVED_KINDS = ["adjustment", "offer_bonus"] as const;

/**
 * The opening entry: what the derived balance holds that the posted entries
 * (excluding the opening itself and the kinds derived never counts) do not.
 */
export function openingAmount(
  derivedTotal: number,
  entries: readonly { kind: string; amount: number | string }[]
) {
  const posted = entries
    .filter((e) => e.kind !== "opening_balance" && !(NON_DERIVED_KINDS as readonly string[]).includes(e.kind))
    .reduce((sum, e) => sum + Number(e.amount), 0);
  return Math.round((derivedTotal - posted) * 100) / 100;
}

export interface BackfillResult {
  wallet_id: string;
  opening: number;
  already: boolean;
}

export async function backfillRider(userId: string): Promise<BackfillResult> {
  const { data: locked, error: lockError } = await supabaseAdmin.rpc("blink_wallet_lock", {
    p_user: userId,
    p_role: "rider",
  });
  if (lockError || !locked) throw new Error(`[backfill] wallet lock failed: ${lockError?.message}`);
  const wallet = locked as { id: string; backfilled_at: string | null };
  if (wallet.backfilled_at) return { wallet_id: wallet.id, opening: 0, already: true };

  const [derived, entries] = await Promise.all([
    riderWalletDerived(userId),
    fetchAllRows<{ kind: string; amount: number }>((from, to) =>
      supabaseAdmin
        .from("blink_wallet_entries")
        .select("kind, amount")
        .eq("wallet_id", wallet.id)
        .order("created_at")
        .range(from, to)
    ),
  ]);
  const opening = openingAmount(derived.total, entries);
  if (opening !== 0) {
    const { error } = await supabaseAdmin.rpc("blink_wallet_post", {
      p_user: userId,
      p_role: "rider",
      p_amount: opening,
      p_kind: "opening_balance",
      p_idem: `opening:${userId}`,
      p_ref_type: "backfill",
      p_allow_negative: true,
    });
    if (error) throw new Error(`[backfill] opening not posted: ${error.message}`);
  }
  const { error } = await supabaseAdmin
    .from("blink_wallets")
    .update({ backfilled_at: new Date().toISOString() })
    .eq("id", wallet.id)
    .is("backfilled_at", null);
  if (error) throw new Error(`[backfill] could not mark wallet: ${error.message}`);
  return { wallet_id: wallet.id, opening, already: false };
}
