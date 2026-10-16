// Append-only audit of every staff write on Blink Cash money
// (finance_audit_events, spec §7). An audit failure must never undo or block
// the action that already happened, so it is logged and swallowed.
import { supabaseAdmin } from "./supabase";

export type FinanceAuditInput = {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  amount?: number | null;
  reason?: string | null;
  details?: Record<string, unknown> | null;
};

export function buildAuditRow(input: FinanceAuditInput) {
  return {
    actor_id: input.actorId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    amount: input.amount ?? null,
    reason: input.reason?.trim() || null,
    details: input.details ?? {},
  };
}

export async function recordFinanceAudit(input: FinanceAuditInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("finance_audit_events").insert(buildAuditRow(input));
    if (error) console.error(`[finance-audit] ${input.action} ${input.targetType}:${input.targetId} not recorded: ${error.message}`);
  } catch (e) {
    console.error(`[finance-audit] ${input.action} ${input.targetType}:${input.targetId} not recorded:`, e);
  }
}
