// Pure fare arithmetic over a configured rate leg (courier_fare / ride_fare),
// shared by the staff preview. Same maths as courier-pricing.ts / ride-pricing.ts:
// base + metres beyond the included km + extra stops, rounded UP to 10 DA — the
// manual `fare_multiplier` scales the raw fare before rounding (1 = today's fare).

/** One vehicle's rate (the value shape of courier_fare.bicycle, ride_fare.motorcycle, …). */
export type FareLeg = { base: number; included_km: number; per_km: number; max_km: number };

const FARE_STEP = 10;

export function legFare(leg: FareLeg, km: number, opts: { stops?: number; extraStopFee?: number; multiplier?: number } = {}) {
  const { stops = 1, extraStopFee = 0, multiplier = 1 } = opts;
  const raw = leg.base + Math.max(0, km - leg.included_km) * leg.per_km + Math.max(0, stops - 1) * extraStopFee;
  return Math.ceil((raw * multiplier) / FARE_STEP) * FARE_STEP;
}
