// Money rules of a rider's job, kept pure so they're unit-testable without a
// database (see cash-jobs.test.ts): Blink's commission on the fare, the coupon
// discount Blink funds on a cash job, and when a coupon goes back to the
// customer. Used by src/lib/dispatch.ts (trips, Blink Cash balance), the
// search-timeouts cron and PATCH /orders/{id}/status.

type Row = Record<string, any>;

/**
 * Jobs the customer pays the rider in cash, fare minus the coupon discount:
 * the rider collects `total` (fare − discount) but Blink's commission is on
 * the whole fare, so Blink funds the discount (blinkFundedDiscount).
 */
export const CASH_FARE_TYPES = ["courier", "ride"] as const;

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What a trip pays on `fare`: gross (estimated_payout) and after Blink's
 * commission at `rate` (net_payout). The rate is the configured
 * `rider_commission_rate` for the job (src/lib/pricing).
 */
export function tripPayout(fare: number, rate: number) {
  return { estimated_payout: fare, net_payout: Math.round(fare * (1 - rate)) };
}

/**
 * The coupon discount on a cash job that Blink owes the rider: the rider
 * collected `fare − discount` in cash, so without it they'd be out of pocket.
 * Courier and ride orders only; a store order's discount isn't the rider's.
 * Never more than the fare.
 */
export function blinkFundedDiscount(o: Row | null | undefined) {
  if (!o || !(CASH_FARE_TYPES as readonly string[]).includes(o.type)) return 0;
  return Math.min(Math.max(0, num(o.discount)), Math.max(0, num(o.delivery_fee)));
}

/**
 * One trip's effect on the rider's Blink Cash balance. A completed trip
 * charges Blink's commission (estimated − net payout) minus the discount Blink
 * funds on it (`fundedDiscount`, see blinkFundedDiscount) — it's a credit when
 * the discount is larger. A penalty (a dropped job) is charged whatever the
 * status.
 */
export function tripWalletDelta(
  trip: { status?: string | null; estimated_payout?: unknown; net_payout?: unknown; penalty_amount?: unknown },
  fundedDiscount = 0
) {
  let delta = 0;
  if (trip.status === "completed") {
    const commission = Math.max(0, num(trip.estimated_payout) - num(trip.net_payout));
    delta -= commission - Math.max(0, fundedDiscount);
  }
  return delta - num(trip.penalty_amount);
}

/**
 * Whether a cancel hands the order's coupon back to the customer: a courier or
 * ride that never happened — no rider took it in time (system, no_rider), or
 * the customer canceled while it was still `searching`. Never on a rider's
 * no-show report (the passenger stood the rider up) nor once a rider is under
 * way, so a coupon can't be replayed by canceling late.
 */
export function releasesCoupon(
  o: { type?: string | null; coupon_id?: string | null },
  cancel: { by: string | null | undefined; reason?: string | null; fromStatus: string | null | undefined }
) {
  if (!o.coupon_id || !(CASH_FARE_TYPES as readonly string[]).includes(o.type ?? "")) return false;
  if (cancel.by === "system") return cancel.reason === "no_rider" && cancel.fromStatus === "searching";
  if (cancel.by === "customer") return cancel.fromStatus === "searching";
  return false;
}
