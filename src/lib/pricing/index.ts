// Runtime pricing lookups: `getPrice("merchant_commission_rate", ctx)` →
// `{ value, overrideId }`. Settings + live overrides are read from the DB with
// a 15 s cache (same pattern as lib/ai-settings.ts); a load error logs and serves
// the last good snapshot (seeds only on a cold start), retrying after ~2 s.
import { normalizeGeometry, toRuntimeZone, type RuntimeZone } from "../geo/zones";
import { supabaseAdmin } from "../supabase";
import { PRICING_KEYS, PRICING_SCHEMAS, PRICING_SEEDS, TIER_SEEDS, type LegKey, type PricingKey, type PricingValue } from "./catalog";
import { placeOf, type PricingPlace } from "./place";
import { resolveFrom, type OverrideLike, type PricingContext } from "./resolve";
import { resolveClassLegs, VEHICLE_CLASS_SEEDS, type ClassLeg, type VehicleClass } from "./vehicle-classes";

export type { PricingContext } from "./resolve";
export { placeContext, type PricingPlace } from "./place";
export { PRICING_KEYS, PRICING_SEEDS, type PricingKey, type PricingValue } from "./catalog";
export type { ClassLeg, VehicleClass } from "./vehicle-classes";

export type PriceResult<K extends PricingKey> = { value: PricingValue<K>; overrideId: string | null };

type Snapshot = {
  defaults: Record<string, unknown>;
  overrides: OverrideLike[];
  tiers: string[];
  zones: RuntimeZone[];
  /** Every vehicle class, archived ones flagged (matching still needs them for open jobs). */
  classes: VehicleClass[];
};

const TTL_MS = 15_000;
/** After a failed load, retry soon instead of holding the fallback for the full TTL. */
const ERROR_TTL_MS = 2_000;

let cache: { value: Snapshot; expires: number } | null = null;
let inflight: Promise<Snapshot> | null = null;
/** The last snapshot that loaded cleanly; served on a load error. Seeds only on a cold start. */
let lastGood: Snapshot | null = null;
/** Bumped by invalidatePricingCache(): a load that started before can't write the newer state. */
let generation = 0;

const SEED_SNAPSHOT: Snapshot = {
  defaults: { ...PRICING_SEEDS },
  overrides: [],
  tiers: TIER_SEEDS.map((t) => t.code),
  zones: [],
  classes: VEHICLE_CLASS_SEEDS,
};

async function load(): Promise<Snapshot> {
  const nowIso = new Date().toISOString();
  const [settings, overrides, tiers, zones, classRows] = await Promise.all([
    supabaseAdmin.from("pricing_settings").select("key, value"),
    supabaseAdmin
      .from("pricing_overrides")
      .select("id, key, service, wilaya_code, merchant_id, agent_id, zone_id, tier, value, starts_at, ends_at, created_at")
      .is("archived_at", null)
      // Ended overrides never match again; scheduled ones stay (resolved by ctx.at).
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`),
    supabaseAdmin.from("pricing_tiers").select("code").is("archived_at", null),
    supabaseAdmin.from("pricing_zones").select("id, name, tier, wilaya_code, priority, geometry").is("archived_at", null),
    supabaseAdmin
      .from("vehicle_classes")
      .select("code, names, base_vehicle, services, exclusive, enabled, sort_order, archived_at"),
  ]);
  if (settings.error) throw new Error(settings.error.message);
  if (overrides.error) throw new Error(overrides.error.message);
  if (tiers.error) throw new Error(tiers.error.message);
  if (zones.error) throw new Error(zones.error.message);

  // A missing vehicle_classes table (migration not applied yet) must not take
  // every price down: serve the seed classes, which price exactly as before.
  let classes = VEHICLE_CLASS_SEEDS;
  if (classRows.error) {
    console.error(`[pricing] vehicle classes read failed; using the seed classes: ${classRows.error.message}`);
  } else if (classRows.data?.length) {
    classes = classRows.data.map((r) => ({
      code: r.code as string,
      names: r.names as VehicleClass["names"],
      base_vehicle: r.base_vehicle as VehicleClass["base_vehicle"],
      services: (r.services ?? []) as VehicleClass["services"],
      exclusive: !!r.exclusive,
      enabled: !!r.enabled,
      sort_order: (r.sort_order as number) ?? 0,
      archived: !!r.archived_at,
    }));
  }

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
  // One bad stored shape must not fail the whole load (that would serve the
  // last snapshot / seeds for every price): skip it, its points are unzoned.
  const live: RuntimeZone[] = [];
  for (const z of zones.data ?? []) {
    const g = normalizeGeometry(z.geometry);
    if (!g.ok) {
      console.error(`[pricing] invalid stored geometry for zone ${z.id} (${g.error}); skipping it`);
      continue;
    }
    live.push(toRuntimeZone({ ...z, geometry: g.geometry }));
  }
  return {
    defaults,
    overrides: (overrides.data ?? []) as OverrideLike[],
    tiers: (tiers.data ?? []).map((t) => t.code as string),
    // bbox + area are precomputed once per load, not per lookup.
    zones: live,
    classes,
  };
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

/**
 * Where a point sits for pricing: `{ wilaya, zoneId, zoneName, tier }`. Pass
 * `wilaya` when the caller already knows it (a store's own wilaya) so it isn't
 * re-derived from the coordinates.
 */
export async function pricingPlace(
  point: { lat: number; lng: number },
  opts: { wilaya?: string | null; at?: Date } = {}
): Promise<PricingPlace> {
  const snap = await snapshot();
  return placeOf(point, snap, opts);
}

/** Every vehicle class (archived ones flagged `archived`); filter with classesFor() for the quotable ones. */
export async function getVehicleClasses(): Promise<VehicleClass[]> {
  return (await snapshot()).classes;
}

/**
 * The priced legs of the enabled classes serving a leg key's service, for a
 * context (per-class resolution: see vehicle-classes.ts). `key`'s non-leg
 * fields come from getPrice as before.
 */
export async function getClassLegs(key: LegKey, ctx: PricingContext = {}): Promise<ClassLeg[]> {
  const snap = await snapshot();
  return resolveClassLegs(snap.defaults, snap.overrides, key, snap.classes, ctx);
}

/** Every key's effective value for a context (staff preview, rate snapshots). */
export async function getAllPrices(ctx: PricingContext = {}) {
  const snap = await snapshot();
  return PRICING_KEYS.map((key) => ({ key, ...resolveKey(snap, key, ctx) }));
}
