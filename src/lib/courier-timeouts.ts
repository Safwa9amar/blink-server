// Courier requests no rider took in time are canceled (canceled_by system,
// cancel_reason no_rider) and the customer is told, so the app stops
// searching. Driven by POST /cron/courier-timeouts every minute, and lazily by
// GET /orders/{id} so the customer's screen moves on even without the cron.
// Rule: isCourierSearchExpired (src/lib/courier.ts).
import { COURIER_SEARCH_TIMEOUT_MS, isCourierSearchExpired, NO_RIDER_REASON } from "./courier";
import { notifyCourier } from "./dispatch";
import { CLEAR_OFFER } from "./rider-offer";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

/**
 * Cancel one expired request. Conditional on it still being unclaimed, so a
 * rider accepting meanwhile wins. Returns the canceled row, or null.
 */
export async function expireCourierOrder(o: Row, now = Date.now()): Promise<Row | null> {
  if (!isCourierSearchExpired(o, now)) return null;
  const { data } = await supabaseAdmin
    .from("orders")
    .update({
      status: "canceled",
      canceled_at: new Date(now).toISOString(),
      canceled_by: "system",
      cancel_reason: NO_RIDER_REASON,
      ...CLEAR_OFFER,
    })
    .eq("id", o.id)
    .eq("status", "searching")
    .is("rider_id", null)
    .select()
    .maybeSingle();
  if (!data) return null;
  await notifyCourier(data as { id: string; customer_id: string }, { kind: "no_rider" });
  return data;
}

export async function processCourierTimeouts(now = Date.now()) {
  const cutoff = new Date(now - COURIER_SEARCH_TIMEOUT_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, type, status, rider_id, created_at, scheduled_at, accepted_at")
    .eq("type", "courier")
    .eq("status", "searching")
    .is("rider_id", null)
    .lt("created_at", cutoff)
    .limit(200);
  if (error) return { checked: 0, canceled: 0, error: error.message };
  let canceled = 0;
  for (const o of data ?? []) {
    if (await expireCourierOrder(o, now)) canceled++;
  }
  return { checked: data?.length ?? 0, canceled };
}

/** In-process variant of the cron (ENABLE_INPROCESS_CRON hosts only). */
export function startCourierTimeoutsCron() {
  const timer = setInterval(() => {
    processCourierTimeouts().catch((e) => console.error("[cron] courier timeouts failed", (e as Error).message));
  }, 60_000);
  timer.unref?.();
}
