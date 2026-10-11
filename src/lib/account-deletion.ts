// Is a user leaving Blink? True while they have an account deletion request
// (account_deletion_requests, src/db/schema/account-deletion-requests.ts) that
// is `pending` (filed, staff haven't processed it) or `completed` (staff wiped
// the account). A `cancelled` request doesn't count. Any role: the request is
// for the whole account. Used to refuse store approval / resubmit
// (src/lib/store-review.ts, owner_leaving).
import { supabaseAdmin } from "./supabase";

export const LEAVING_DELETION_STATUSES = ["pending", "completed"] as const;

export async function isLeavingBlink(userId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("account_deletion_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", [...LEAVING_DELETION_STATUSES]);
  // Fail closed: an unknown answer must not let a leaving owner's store go live.
  if (error) throw new Error(`[account-deletion] lookup failed: ${error.message}`);
  return (count ?? 0) > 0;
}
