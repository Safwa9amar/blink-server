// Blink Cash wallet ledger: wrappers over the blink_* SQL functions
// (supabase/migrations/20261016120000_blink_cash_full.sql), the error-code →
// HTTP mapping, and the best-effort postings from trips and challenges.
//
// The functions lock the wallet and transaction rows and raise P0001 with a
// code as the message; walletError() turns that into the response a route
// returns. Postings from other flows (trip completed, challenge won) are
// idempotent by key and NEVER break the calling flow: a failure is logged and
// the reconciliation report shows the drift.
import { blinkFundedDiscount, tripWalletDelta } from "./cash-jobs";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

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

/** HTTP status + message each database code answers with. */
export const WALLET_ERROR_HTTP: Record<WalletErrorCode, { status: 400 | 403 | 404 | 409 | 410; message: string }> = {
  insufficient_funds: { status: 400, message: "Insufficient Blink Cash balance" },
  wallet_frozen: { status: 403, message: "Your Blink Cash wallet is frozen. Please contact support." },
  not_pending: { status: 409, message: "Transaction not found or already processed" },
  expired: { status: 410, message: "This request has expired" },
  wrong_agent: { status: 403, message: "This request was sent to another agent" },
  not_found: { status: 404, message: "Transaction not found" },
  not_completed: { status: 409, message: "Only a completed transaction can be reversed" },
  not_in_review: { status: 409, message: "This request is not awaiting review" },
};

/** The wallet code in a Postgres / PostgREST error (raised with P0001), or null for any other error. */
export function walletErrorCode(error: { message?: string; code?: string } | null | undefined): WalletErrorCode | null {
  if (!error) return null;
  const message = (error.message ?? "").trim();
  if (error.code && error.code !== "P0001") return null;
  return (WALLET_ERROR_CODES as readonly string[]).includes(message) ? (message as WalletErrorCode) : null;
}

/** The `{ status, body }` a route answers with for a wallet function error, or null if it is not one. */
export function walletError(error: { message?: string; code?: string } | null | undefined) {
  const code = walletErrorCode(error);
  if (!code) return null;
  const { status, message } = WALLET_ERROR_HTTP[code];
  return { status, body: { error: message, code } };
}

const asRow = (data: unknown): Row | null => (data && typeof data === "object" ? (data as Row) : null);

/** Agent confirms a pending request: status, money and offer bonus in one DB transaction. */
export async function completeTransaction(txnId: string, agentId: string, shopId: string | null) {
  const { data, error } = await supabaseAdmin.rpc("blink_cash_complete", {
    p_txn: txnId,
    p_agent: agentId,
    p_shop: shopId,
  });
  return { data: asRow(data), error };
}

export type CancelReason = "rider" | "agent" | "expired" | "staff" | "rejected";

/** Cancels a pending / in-review request and releases its hold. */
export async function cancelTransaction(txnId: string, reason: CancelReason, actorId: string | null) {
  const { data, error } = await supabaseAdmin.rpc("blink_cash_cancel", {
    p_txn: txnId,
    p_reason: reason,
    p_actor: actorId,
  });
  return { data: asRow(data), error };
}

export interface CreateWithdrawalArgs {
  userId: string;
  amount: number;
  fees: number;
  method: "agent" | "electronic";
  agentId: string | null;
  shopId: string | null;
  status: "pending" | "review";
  expiresAt: string | null;
  clientRef: string | null;
  payoutAccount: Row | null;
  pendingId: string | null;
}

/** The withdrawal row and its hold, atomically. */
export async function createWithdrawal(a: CreateWithdrawalArgs) {
  const { data, error } = await supabaseAdmin.rpc("blink_cash_create_withdrawal", {
    p_user: a.userId,
    p_amount: a.amount,
    p_fees: a.fees,
    p_method: a.method,
    p_agent: a.agentId,
    p_shop: a.shopId,
    p_status: a.status,
    p_expires_at: a.expiresAt,
    p_client_ref: a.clientRef,
    p_payout_account: a.payoutAccount,
    p_pending_id: a.pendingId,
  });
  return { data: asRow(data), error };
}

/**
 * Cancels the lapsed pending requests (all of them, or those where `userId` is
 * the owner or the agent). Lazy backstop for the pg_cron job; never throws.
 */
export async function expirePending(userId?: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc(
    "blink_cash_expire_pending",
    userId ? { p_user: userId } : {}
  );
  if (error) console.error("[wallet] expire pending failed", error.message);
}

export interface PostArgs {
  userId: string;
  amount: number;
  kind: "trip" | "challenge_reward" | "adjustment" | "offer_bonus" | "opening_balance";
  idem: string;
  refType?: string;
  refId?: string;
  memo?: string;
  actorId?: string | null;
  allowNegative?: boolean;
}

/** One idempotent ledger entry on the rider's wallet. */
export async function postToWallet(a: PostArgs) {
  const { data, error } = await supabaseAdmin.rpc("blink_wallet_post", {
    p_user: a.userId,
    p_role: "rider",
    p_amount: a.amount,
    p_kind: a.kind,
    p_idem: a.idem,
    p_ref_type: a.refType ?? null,
    p_ref_id: a.refId ?? null,
    p_memo: a.memo ?? null,
    p_actor: a.actorId ?? null,
    p_allow_negative: a.allowNegative ?? false,
  });
  return { data: asRow(data), error };
}

/** Like postToWallet but logs instead of failing: for postings beside another flow. */
async function postQuietly(what: string, a: PostArgs) {
  try {
    const { error } = await postToWallet(a);
    if (error) console.error(`[wallet] ${what} not posted (${a.idem})`, error.message);
  } catch (e) {
    console.error(`[wallet] ${what} not posted (${a.idem})`, (e as Error).message);
  }
}

/** The coupon discount Blink funds on a delivered cash job (0 for anything else). */
export async function fundedDiscountForOrder(orderId: string | null | undefined): Promise<number> {
  if (!orderId) return 0;
  const { data } = await supabaseAdmin
    .from("orders")
    .select("type, discount, delivery_fee")
    .eq("id", orderId)
    .maybeSingle();
  return blinkFundedDiscount(data);
}

/**
 * Post a trip that just completed: Blink's commission minus the discount it
 * funds, exactly as riderWalletDerived counts it. Idempotent (`trip:<id>`),
 * skips zero, never throws.
 */
export async function postTripToLedger(trip: Row | null | undefined, fundedDiscount = 0) {
  if (!trip?.id || !trip.rider_id) return;
  const delta = tripWalletDelta(trip, fundedDiscount);
  if (!delta) return;
  await postQuietly("trip", {
    userId: trip.rider_id,
    amount: delta,
    kind: "trip",
    idem: `trip:${trip.id}`,
    refType: "trip",
    refId: trip.id,
    allowNegative: true,
  });
}

/** Post the penalty charged for a job the rider dropped (derived balance counts it whatever the status). */
export async function postTripPenalty(tripId: string, riderId: string, penalty: number) {
  if (!penalty) return;
  await postQuietly("trip penalty", {
    userId: riderId,
    amount: -Math.abs(penalty),
    kind: "trip",
    idem: `penalty:${tripId}`,
    refType: "trip",
    refId: tripId,
    memo: "penalty",
    allowNegative: true,
  });
}

/** Post a challenge reward the moment it is won (`challenge:<challenge_id>:<rider_id>`). */
export async function postChallengeReward(challengeId: string, riderId: string, reward: number) {
  if (!reward) return;
  await postQuietly("challenge reward", {
    userId: riderId,
    amount: reward,
    kind: "challenge_reward",
    idem: `challenge:${challengeId}:${riderId}`,
    refType: "challenge",
    refId: challengeId,
    allowNegative: true,
  });
}

/** The rider's ledger balance when the wallet exists and was backfilled; null → use the derived path. */
export async function ledgerWallet(userId: string) {
  const { data } = await supabaseAdmin
    .from("blink_wallets")
    .select("balance, held, backfilled_at")
    .eq("user_id", userId)
    .eq("role", "rider")
    .maybeSingle();
  if (!data?.backfilled_at) return null;
  const total = Number(data.balance ?? 0);
  const held = Number(data.held ?? 0);
  return { total, available: total - held, pending: held, currency: "DZD" };
}
