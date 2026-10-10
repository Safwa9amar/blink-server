// Courier requests and rides no rider took in time are canceled (canceled_by
// system, cancel_reason no_rider) and the customer is told, so the app stops
// searching. Driven by POST /cron/search-timeouts every minute (alias:
// /cron/courier-timeouts), and lazily by GET /orders and GET /orders/{id} so
// the customer's screen moves on even without the cron.
// Rules: isCourierSearchExpired (20 min, src/lib/courier.ts) and
// isRideSearchExpired (10 min, src/lib/ride.ts). The coupon of a request that
// never found a rider goes back to the customer (src/lib/cash-jobs.ts).
import { releasesCoupon } from "./cash-jobs";
import { releaseCoupon } from "./coupons";
import { COURIER_SEARCH_TIMEOUT_MS, isCourierSearchExpired, NO_RIDER_REASON } from "./courier";
import { notifyCourier, notifyRide } from "./dispatch";
import { isRideSearchExpired, RIDE_SEARCH_TIMEOUT_MS } from "./ride";
import { CLEAR_OFFER } from "./rider-offer";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

/** Order types with a search window, and how long it is. */
const SEARCH_WINDOWS = [
  { type: "courier", timeoutMs: COURIER_SEARCH_TIMEOUT_MS },
  { type: "ride", timeoutMs: RIDE_SEARCH_TIMEOUT_MS },
] as const;
/** Rows scanned per type and run. */
const BATCH = 200;

/** An unclaimed courier request or ride past its search window. */
export const isSearchExpired = (o: Row, now = Date.now()) =>
  isCourierSearchExpired(o, now) || isRideSearchExpired(o, now);

/**
 * Cancel one expired request. Conditional on it still being unclaimed, so a
 * rider accepting meanwhile wins. Returns the canceled row, or null.
 */
export async function expireSearchingOrder(o: Row, now = Date.now()): Promise<Row | null> {
  if (!isSearchExpired(o, now)) return null;
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
  const row = data as { id: string; customer_id: string; type: string; coupon_id: string | null };
  if (releasesCoupon(row, { by: "system", reason: NO_RIDER_REASON, fromStatus: "searching" })) {
    await releaseCoupon(row.coupon_id!, row.id);
  }
  if (row.type === "ride") await notifyRide(row, { kind: "no_rider" });
  else await notifyCourier(row, { kind: "no_rider" });
  return data;
}

/**
 * One query per type, shaped like its partial index (idx_orders_courier_searching
 * / idx_orders_ride_searching: type, searching, no rider, by created_at) and
 * with the whole live-at rule in SQL — created_at, scheduled_at and
 * accepted_at all past the window — so the oldest expired rows come first and
 * rows not yet expired (a scheduled or re-dropped request) can't fill the
 * batch and starve the rest. isSearchExpired re-checks each row.
 */
export async function processSearchTimeouts(now = Date.now()) {
  let checked = 0;
  let canceled = 0;
  const errors: string[] = [];
  for (const { type, timeoutMs } of SEARCH_WINDOWS) {
    const cutoff = new Date(now - timeoutMs).toISOString();
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("id, customer_id, type, status, rider_id, created_at, scheduled_at, accepted_at")
      .eq("type", type)
      .eq("status", "searching")
      .is("rider_id", null)
      .lt("created_at", cutoff)
      .or(`and(or(scheduled_at.is.null,scheduled_at.lt.${cutoff}),or(accepted_at.is.null,accepted_at.lt.${cutoff}))`)
      .order("created_at", { ascending: true })
      .limit(BATCH);
    if (error) {
      errors.push(`${type}: ${error.message}`);
      continue;
    }
    checked += data?.length ?? 0;
    for (const o of data ?? []) {
      if (await expireSearchingOrder(o, now)) canceled++;
    }
  }
  return errors.length ? { checked, canceled, error: errors.join("; ") } : { checked, canceled };
}

/** In-process variant of the cron (ENABLE_INPROCESS_CRON hosts only). */
export function startSearchTimeoutsCron() {
  const timer = setInterval(() => {
    processSearchTimeouts().catch((e) => console.error("[cron] search timeouts failed", (e as Error).message));
  }, 60_000);
  timer.unref?.();
}
