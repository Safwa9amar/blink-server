// Is a user leaving Blink — or leaving `role`? True while they have an account
// deletion request (account_deletion_requests,
// src/db/schema/account-deletion-requests.ts) for the whole account that is
// `pending` (filed, staff haven't processed it) or `completed` (staff wiped the
// account), or a still-`pending` request to remove just `role` (once staff
// remove it, the role is gone; unlocking it again starts afresh). A
// `cancelled` request doesn't count. Used to refuse store approval / resubmit
// (src/lib/store-review.ts, owner_leaving).
import type { AppRole } from "./roles";
import { supabaseAdmin } from "./supabase";

export const LEAVING_DELETION_STATUSES = ["pending", "completed"] as const;

export async function isLeavingBlink(userId: string, role: AppRole): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("account_deletion_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", [...LEAVING_DELETION_STATUSES])
    .or(`scope.eq.account,and(role.eq.${role},status.eq.pending)`);
  // Fail closed: an unknown answer must not let a leaving owner's store go live.
  if (error) throw new Error(`[account-deletion] lookup failed: ${error.message}`);
  return (count ?? 0) > 0;
}
