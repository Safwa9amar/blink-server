// Pure override resolution — no DB, no clock beyond `ctx.at` (see index.ts for
// the cached loader). Spec rules: an override matches when each non-null scope
// column equals the context's value; score = partner 4 / wilaya 2 / service 1;
// highest wins; no match → the default.

export type PricingContext = {
  service?: string;
  wilaya?: string | null;
  merchantId?: string | null;
  agentId?: string | null;
  at?: Date;
};

export type OverrideLike = {
  id: string;
  key: string;
  service: string | null;
  wilaya_code: string | null;
  merchant_id: string | null;
  agent_id: string | null;
  value: unknown;
  starts_at: string | null;
  ends_at: string | null;
  archived_at?: string | null;
  created_at?: string | null;
};

export type Resolved<V = unknown> = { value: V; overrideId: string | null };

const ts = (iso: string | null | undefined, empty: number) => (iso ? Date.parse(iso) : empty);

/** Active at `at`: not archived, `starts_at <= at < ends_at` (null bounds are open). */
export function isActive(o: Pick<OverrideLike, "starts_at" | "ends_at" | "archived_at">, at: Date): boolean {
  if (o.archived_at) return false;
  const t = at.getTime();
  return ts(o.starts_at, -Infinity) <= t && t < ts(o.ends_at, Infinity);
}

/** Does the override apply to this context, and how specific is it (0 = no scope, higher = more specific)? Null = no match. */
export function matchScore(o: OverrideLike, ctx: PricingContext): number | null {
  let score = 0;
  if (o.merchant_id != null) {
    if (o.merchant_id !== ctx.merchantId) return null;
    score += 4;
  }
  if (o.agent_id != null) {
    if (o.agent_id !== ctx.agentId) return null;
    score += 4;
  }
  if (o.wilaya_code != null) {
    if (o.wilaya_code !== ctx.wilaya) return null;
    score += 2;
  }
  if (o.service != null) {
    if (o.service !== ctx.service) return null;
    score += 1;
  }
  return score;
}

/**
 * The effective value of `key`: the best-scoring active matching override, else
 * `defaults[key]`. Equal scores (only possible for duplicate scopes, which the
 * save-time overlap guard prevents) go to the most recently created.
 */
export function resolveFrom<V = unknown>(
  defaults: Record<string, unknown>,
  overrides: OverrideLike[],
  key: string,
  ctx: PricingContext
): Resolved<V> {
  const at = ctx.at ?? new Date();
  let best: OverrideLike | null = null;
  let bestScore = -1;
  for (const o of overrides) {
    if (o.key !== key || !isActive(o, at)) continue;
    const score = matchScore(o, ctx);
    if (score == null) continue;
    if (score > bestScore || (score === bestScore && ts(o.created_at, 0) > ts(best?.created_at, 0))) {
      best = o;
      bestScore = score;
    }
  }
  return best ? { value: best.value as V, overrideId: best.id } : { value: defaults[key] as V, overrideId: null };
}

type OverlapShape = Pick<
  OverrideLike,
  "key" | "service" | "wilaya_code" | "merchant_id" | "agent_id" | "starts_at" | "ends_at" | "archived_at"
>;

/** Save-time guard: same key + identical scope + overlapping date windows. */
export function overlaps(a: OverlapShape, b: OverlapShape): boolean {
  if (a.archived_at || b.archived_at) return false;
  if (
    a.key !== b.key ||
    a.service !== b.service ||
    a.wilaya_code !== b.wilaya_code ||
    a.merchant_id !== b.merchant_id ||
    a.agent_id !== b.agent_id
  ) {
    return false;
  }
  return ts(a.starts_at, -Infinity) < ts(b.ends_at, Infinity) && ts(b.starts_at, -Infinity) < ts(a.ends_at, Infinity);
}
