// Pure bucketing for the staff Blink Cash summary
// (GET /blink-cash/admin/summary). Days are Africa/Algiers calendar dates
// (UTC+1, no DST), matching how the rest of the platform reads "today".

export const SUMMARY_TZ = "Africa/Algiers";
const ALGIERS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD of an instant in Algiers. */
export function algiersDate(at: Date | string | number): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

/** The `days` calendar dates ending at (and including) today, oldest first. */
export function windowDates(days: number, now: Date = new Date()): string[] {
  const today = Date.parse(`${algiersDate(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10)
  );
}

/** ISO instant of the window's first Algiers midnight. */
export function windowStartIso(days: number, now: Date = new Date()): string {
  return new Date(Date.parse(`${windowDates(days, now)[0]}T00:00:00Z`) - ALGIERS_OFFSET_MS).toISOString();
}

export interface DailyBucket {
  date: string;
  deposits: number;
  withdrawals: number;
  deposits_count: number;
  withdrawals_count: number;
}

/**
 * One bucket per day in the window (zeros included) from COMPLETED operations.
 * Rows outside the window are ignored.
 */
export function bucketDaily(
  rows: readonly { type: string; amount: number | string | null; created_at: string }[],
  days: number,
  now: Date = new Date()
): DailyBucket[] {
  const buckets = new Map<string, DailyBucket>(
    windowDates(days, now).map((date) => [
      date,
      { date, deposits: 0, withdrawals: 0, deposits_count: 0, withdrawals_count: 0 },
    ])
  );
  for (const r of rows) {
    const b = buckets.get(algiersDate(r.created_at));
    if (!b) continue;
    const amount = Number(r.amount ?? 0);
    if (r.type === "deposit") {
      b.deposits += amount;
      b.deposits_count++;
    } else if (r.type === "withdrawal") {
      b.withdrawals += amount;
      b.withdrawals_count++;
    }
  }
  return [...buckets.values()].map((b) => ({
    ...b,
    deposits: Math.round(b.deposits * 100) / 100,
    withdrawals: Math.round(b.withdrawals * 100) / 100,
  }));
}
