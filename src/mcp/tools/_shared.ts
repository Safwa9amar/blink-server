import { z } from "zod";
import { clampLimit, clampOffset, DEFAULT_LIMIT, isDateInput, MAX_LIMIT } from "../../lib/mcp-util";

export const limitField = z
  .number()
  .int()
  .optional()
  .describe(`Page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);
export const offsetField = z.number().int().optional().describe("Rows to skip (use next_offset from the previous page).");
export const uuidField = (what: string) => z.string().uuid().describe(what);
const dateField = (what: string) =>
  z
    .string()
    .refine(isDateInput, "Use YYYY-MM-DD (Africa/Algiers day) or an ISO datetime")
    .describe(what);
export const createdFrom = dateField(
  "Created on/after. YYYY-MM-DD means that Algiers calendar day 00:00; or a full ISO datetime."
).optional();
export const createdTo = dateField(
  "Created up to and INCLUDING this day when YYYY-MM-DD (Algiers); a full ISO datetime is exclusive."
).optional();

export function page(args: { limit?: number; offset?: number }) {
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  return { limit, offset, from: offset, to: offset + limit - 1 };
}

export function listResult<T>(items: T[], total: number | null, offset: number) {
  const next = total !== null && offset + items.length < total ? offset + items.length : null;
  return { items, total, next_offset: next };
}

/** Throw a short error for a failed supabase query. */
export function must<T>(res: { data: T | null; error: { message: string } | null; count?: number | null }): {
  data: T;
  count: number | null;
} {
  if (res.error) throw new Error(`Database error: ${res.error.message}`);
  return { data: res.data as T, count: res.count ?? null };
}
