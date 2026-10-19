// Pure helpers for the staff MCP server (src/mcp). No I/O — unit-tested in mcp.test.ts.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/** limit: default 20, clamped to 1..50, non-numbers fall back to the default. */
export function clampLimit(limit: unknown): number {
  const n = typeof limit === "number" ? Math.trunc(limit) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

export function clampOffset(offset: unknown): number {
  const n = typeof offset === "number" ? Math.trunc(offset) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Bank RIB: never in full — "•••• 1234" (last 4 only). */
export function maskRib(rib: string | null | undefined): string | null {
  if (!rib) return null;
  const compact = rib.replace(/\s+/g, "");
  return compact.length <= 4 ? "••••" : `•••• ${compact.slice(-4)}`;
}

/** Audit args: long strings cut, big arrays/objects summarised, depth capped. */
export function truncateArgs(value: unknown, maxString = 200, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}…[+${value.length - maxString}]` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => truncateArgs(v, maxString, depth + 1));
    return value.length > 20 ? [...head, `…[+${value.length - 20} items]`] : head;
  }
  if (value && typeof value === "object") {
    if (depth >= 4) return "[object]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateArgs(v, maxString, depth + 1)])
    );
  }
  return value;
}

/** Recursively drop keys matching `re` (used to strip phone numbers from jsonb blobs). */
export function omitKeys(value: unknown, re: RegExp): unknown {
  if (Array.isArray(value)) return value.map((v) => omitKeys(v, re));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !re.test(k))
        .map(([k, v]) => [k, omitKeys(v, re)])
    );
  }
  return value;
}

/** Strip PostgREST filter metacharacters from user text used in .or()/ilike. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

const ALGIERS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no DST
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateInput(s: string): boolean {
  return (DATE_ONLY.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s)) && !Number.isNaN(Date.parse(s));
}

/**
 * Turn optional created_from / created_to into [gte, lt) ISO instants.
 * A bare YYYY-MM-DD is an Africa/Algiers calendar day: from = that day 00:00,
 * to = the START of the NEXT day (inclusive of the whole day). Full datetimes pass through.
 */
export function dateRange(from?: string, to?: string): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (from) {
    out.gte = DATE_ONLY.test(from)
      ? new Date(Date.parse(`${from}T00:00:00Z`) - ALGIERS_OFFSET_MS).toISOString()
      : new Date(from).toISOString();
  }
  if (to) {
    out.lt = DATE_ONLY.test(to)
      ? new Date(Date.parse(`${to}T00:00:00Z`) - ALGIERS_OFFSET_MS + DAY_MS).toISOString()
      : new Date(to).toISOString();
  }
  return out;
}

/** Fixed-window-ish sliding rate limiter, keyed (e.g. by token id). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number
  ) {}
  /** true = allowed (and counted). */
  take(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
