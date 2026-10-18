// Runtime pricing lookups: `getPrice("merchant_commission_rate", ctx)` →
// `{ value, overrideId }`. Settings + live overrides are read from the DB with
// a 15 s cache (same pattern as lib/ai-settings.ts); a load error logs and serves
// the last good snapshot (seeds only on a cold start), retrying after ~2 s.
import { supabaseAdmin } from "../supabase";
import { PRICING_KEYS, PRICING_SCHEMAS, PRICING_SEEDS, type PricingKey, type PricingValue } from "./catalog";
import { resolveFrom, type OverrideLike, type PricingContext } from "./resolve";

export type { PricingContext } from "./resolve";
export { PRICING_KEYS, PRICING_SEEDS, type PricingKey, type PricingValue } from "./catalog";

export type PriceResult<K extends PricingKey> = { value: PricingValue<K>; overrideId: string | null };

type Snapshot = { defaults: Record<string, unknown>; overrides: OverrideLike[] };

const TTL_MS = 15_000;
/** After a failed load, retry soon instead of holding the fallback for the full TTL. */
const ERROR_TTL_MS = 2_000;

let cache: { value: Snapshot; expires: number } | null = null;
let inflight: Promise<Snapshot> | null = null;
/** The last snapshot that loaded cleanly; served on a load error. Seeds only on a cold start. */
let lastGood: Snapshot | null = null;
/** Bumped by invalidatePricingCache(): a load that started before can't write the newer state. */
let generation = 0;

const SEED_SNAPSHOT: Snapshot = { defaults: { ...PRICING_SEEDS }, overrides: [] };

async function load(): Promise<Snapshot> {
  const nowIso = new Date().toISOString();
  const [settings, overrides] = await Promise.all([
    supabaseAdmin.from("pricing_settings").select("key, value"),
    supabaseAdmin
      .from("pricing_overrides")
      .select("id, key, service, wilaya_code, merchant_id, agent_id, value, starts_at, ends_at, created_at")
      .is("archived_at", null)
      // Ended overrides never match again; scheduled ones stay (resolved by ctx.at).
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`),
  ]);
  if (settings.error) throw new Error(settings.error.message);
  if (overrides.error) throw new Error(overrides.error.message);

  // Seeds fill any key the table doesn't have (e.g. before the migration).
  const defaults: Record<string, unknown> = { ...PRICING_SEEDS };
  for (const row of settings.data ?? []) {
    const key = row.key as PricingKey;
    const parsed = PRICING_SCHEMAS[key]?.safeParse(row.value);
    if (!parsed?.success) {
      console.error(`[pricing] invalid stored default for ${row.key}; using seed`);
      continue;
    }
    defaults[key] = parsed.data;
  }
  return { defaults, overrides: (overrides.data ?? []) as OverrideLike[] };
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() < cache.expires) return cache.value;
  if (inflight) return inflight;
  const gen = generation;
  const p: Promise<Snapshot> = load()
    .then((value) => {
      if (gen === generation) {
        lastGood = value;
        cache = { value, expires: Date.now() + TTL_MS };
      }
      return value;
    })
    .catch((err) => {
      const fallback = lastGood ?? SEED_SNAPSHOT;
      console.error(
        `[pricing] load failed; serving ${lastGood ? "the last good snapshot" : "seeds"}`,
        err instanceof Error ? err.message : err
      );
      if (gen === generation) cache = { value: fallback, expires: Date.now() + ERROR_TTL_MS };
      return fallback;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Drop the cache (staff writes call this so the change shows up immediately on this instance). */
export function invalidatePricingCache() {
  generation++;
  cache = null;
  inflight = null;
}

function resolveKey<K extends PricingKey>(snap: Snapshot, key: K, ctx: PricingContext): PriceResult<K> {
  const r = resolveFrom<unknown>(snap.defaults, snap.overrides, key, ctx);
  const parsed = PRICING_SCHEMAS[key].safeParse(r.value);
  if (parsed.success) return { value: parsed.data as PricingValue<K>, overrideId: r.overrideId };
  console.error(`[pricing] invalid stored value for ${key} (override ${r.overrideId}); using default/seed`);
  const fallback = PRICING_SCHEMAS[key].safeParse(snap.defaults[key]);
  return { value: (fallback.success ? fallback.data : PRICING_SEEDS[key]) as PricingValue<K>, overrideId: null };
}

/** The effective value of one fee for a context (default context = no scope → the default). */
export async function getPrice<K extends PricingKey>(key: K, ctx: PricingContext = {}): Promise<PriceResult<K>> {
  return resolveKey(await snapshot(), key, ctx);
}

/** Several fees for one context, in one cache read. */
export async function getPrices<const Ks extends readonly PricingKey[]>(
  keys: Ks,
  ctx: PricingContext = {}
): Promise<{ [K in Ks[number]]: PriceResult<K> }> {
  const snap = await snapshot();
  const out = {} as { [K in Ks[number]]: PriceResult<K> };
  for (const key of keys) (out as Record<string, unknown>)[key] = resolveKey(snap, key, ctx);
  return out;
}

/** Every key's effective value for a context (staff preview, rate snapshots). */
export async function getAllPrices(ctx: PricingContext = {}) {
  const snap = await snapshot();
  return PRICING_KEYS.map((key) => ({ key, ...resolveKey(snap, key, ctx) }));
}
