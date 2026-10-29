// The "place" of a point for pricing: which wilaya, which drawn zone (if any)
// and therefore which tier. Pure — the snapshot loader in index.ts feeds it.
//  - inside a zone → the zone's tier (highest priority, then smaller area);
//  - outside every zone → the "unzoned tier" (`zone_defaults`, default rural,
//    overridable per wilaya). An archived/missing tier resolves to null, which
//    simply matches no tier-scoped override.
import { wilayaAt } from "../geo/wilaya";
import { zoneAt, type RuntimeZone } from "../geo/zones";
import { PRICING_SCHEMAS, PRICING_SEEDS } from "./catalog";
import { resolveFrom, type OverrideLike, type PricingContext } from "./resolve";

export type PricingPlace = {
  wilaya: string | null;
  zoneId: string | null;
  zoneName: string | null;
  tier: string | null;
  /** true when no zone contains the point (the tier is the wilaya's unzoned tier). */
  unzoned: boolean;
  /** The `zone_defaults` override that set the unzoned tier, for `pricing_applied`. */
  unzonedOverrideId: string | null;
};

export type PlaceData = {
  zones: RuntimeZone[];
  /** Live (non-archived) tier codes. */
  tiers: string[];
  defaults: Record<string, unknown>;
  overrides: OverrideLike[];
};

/** The tier of points outside every zone, for a wilaya. */
export function unzonedTier(data: PlaceData, wilaya: string | null, at?: Date): { tier: string | null; overrideId: string | null } {
  const r = resolveFrom(data.defaults, data.overrides, "zone_defaults", { wilaya, at });
  const parsed = PRICING_SCHEMAS.zone_defaults.safeParse(r.value);
  const tier = parsed.success ? parsed.data.unzoned_tier : PRICING_SEEDS.zone_defaults.unzoned_tier;
  return { tier: data.tiers.includes(tier) ? tier : null, overrideId: r.overrideId };
}

/** Place of a point. `wilaya` overrides the polygon lookup (e.g. a store's own wilaya). */
export function placeOf(
  point: { lat: number; lng: number },
  data: PlaceData,
  opts: { wilaya?: string | null; at?: Date } = {}
): PricingPlace {
  const wilaya = opts.wilaya ?? wilayaAt(point.lat, point.lng);
  const zone = zoneAt(point.lat, point.lng, data.zones);
  if (zone) {
    return { wilaya, zoneId: zone.id, zoneName: zone.name, tier: zone.tier, unzoned: false, unzonedOverrideId: null };
  }
  const u = unzonedTier(data, wilaya, opts.at);
  return { wilaya, zoneId: null, zoneName: null, tier: u.tier, unzoned: true, unzonedOverrideId: u.overrideId };
}

/** The pricing-context fields a place contributes. */
export const placeContext = (p: PricingPlace): Pick<PricingContext, "wilaya" | "zoneId" | "tier"> => ({
  wilaya: p.wilaya,
  zoneId: p.zoneId,
  tier: p.tier,
});
