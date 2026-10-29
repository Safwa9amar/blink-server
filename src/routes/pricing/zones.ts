// Staff console for pricing zones + tiers (tag admin-pricing, same role split as
// admin.ts: reads finance / ops / commerce admins, writes finance_admin).
// Spec: blink/docs/superpowers/specs/2026-10-29-zone-pricing-design.md.
// Every write drops the pricing cache; the audit rows in pricing_changes come
// from DB triggers keyed on created_by / updated_by.
import { geometryAreaKm2, geometryWilaya, normalizeGeometry, type ZoneGeometry } from "../../lib/geo/zones";
import { isWilayaCode, PRICING_KEYS, PRICING_SCOPES, type PricingKey } from "../../lib/pricing/catalog";
import { fareBreakdown } from "../../lib/pricing/fare";
import { priceStoreDelivery } from "../../lib/pricing/store-delivery";
import { getClassLegs, getPrice, getPrices, invalidatePricingCache, placeContext, pricingPlace } from "../../lib/pricing";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  CreatePricingTierBody,
  CreatePricingZoneBody,
  ImportPricingZonesBody,
  ListPricingZonesQuery,
  PricingLookupQuery,
  PricingLookupResponse,
  PricingStaleError,
  PricingTierCodeParam,
  PricingTierInUseError,
  PricingTierResponse,
  PricingZoneIdParam,
  PricingZoneInUseError,
  PricingZoneResponse,
  PricingZonesImportResponse,
  PricingZonesResponse,
  UpdatePricingTierBody,
  UpdatePricingZoneBody,
} from "../../validators/pricing";

const app = router();

const readStaff = requireStaffRole("finance_admin", "ops_admin", "commerce_admin");
const writeStaff = requireStaffRole("finance_admin");

const ZONE_COLS = "id, name, tier, wilaya_code, geometry, priority, note, archived_at, created_at, updated_at";
const TIER_COLS = "code, names, color, sort_order, note, archived_at, updated_at";

type ZoneRow = {
  id: string;
  name: string;
  tier: string;
  wilaya_code: string | null;
  geometry: ZoneGeometry;
  priority: number;
  note: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};
type TierRow = {
  code: string;
  names: { en: string; fr: string; ar: string };
  color: string;
  sort_order: number;
  note: string | null;
  archived_at: string | null;
  updated_at: string;
};

const zoneView = (z: ZoneRow, overrideCount: number) => ({
  id: z.id,
  name: z.name,
  tier: z.tier,
  wilaya_code: z.wilaya_code,
  geometry: z.geometry as { type: "Polygon" | "MultiPolygon"; coordinates: any[] },
  priority: z.priority,
  note: z.note,
  area_km2: Math.round(geometryAreaKm2(z.geometry) * 1000) / 1000,
  override_count: overrideCount,
  archived_at: z.archived_at,
  created_at: z.created_at,
  updated_at: z.updated_at,
});

const tierView = (t: TierRow, zoneCount: number, overrideCount: number) => ({
  code: t.code,
  names: t.names,
  color: t.color,
  sort_order: t.sort_order,
  note: t.note,
  archived_at: t.archived_at,
  zone_count: zoneCount,
  override_count: overrideCount,
  updated_at: t.updated_at,
});

/** Live (non-archived) override counts per zone id and per tier code. */
async function overrideCounts() {
  const { data, error } = await supabaseAdmin
    .from("pricing_overrides")
    .select("zone_id, tier")
    .is("archived_at", null)
    .or("zone_id.not.is.null,tier.not.is.null");
  if (error) throw new Error(`[pricing] override counts failed: ${error.message}`);
  const byZone = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const o of data ?? []) {
    if (o.zone_id) byZone.set(o.zone_id, (byZone.get(o.zone_id) ?? 0) + 1);
    if (o.tier) byTier.set(o.tier, (byTier.get(o.tier) ?? 0) + 1);
  }
  return { byZone, byTier };
}

async function zoneRow(id: string): Promise<ZoneRow | null> {
  const { data, error } = await supabaseAdmin.from("pricing_zones").select(ZONE_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error(`[pricing] zone read failed: ${error.message}`);
  return (data as ZoneRow | null) ?? null;
}

/** A live tier with this code exists? */
async function liveTier(code: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("pricing_tiers").select("code").eq("code", code).is("archived_at", null).maybeSingle();
  if (error) throw new Error(`[pricing] tier read failed: ${error.message}`);
  return !!data;
}

/** Resolve the wilaya to store: an explicit valid code, else derived from the geometry. */
function wilayaFor(explicit: string | null | undefined, geometry: ZoneGeometry): { wilaya: string | null } | { error: string } {
  if (explicit != null && explicit !== "") {
    if (!isWilayaCode(explicit)) return { error: "wilaya_code must be one of 1 to 58" };
    return { wilaya: explicit };
  }
  return { wilaya: geometryWilaya(geometry) };
}

// ─── GET /pricing/admin/zones ────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/zones",
    operationId: "listPricingZonesAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { query: ListPricingZonesQuery },
    responses: { 200: json(PricingZonesResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const withArchived = c.req.valid("query").include_archived === "true";
    let zq = supabaseAdmin.from("pricing_zones").select(ZONE_COLS);
    let tq = supabaseAdmin.from("pricing_tiers").select(TIER_COLS);
    if (!withArchived) {
      zq = zq.is("archived_at", null);
      tq = tq.is("archived_at", null);
    }
    const [zones, tiers, counts, unzoned] = await Promise.all([
      zq.order("priority", { ascending: false }).order("name", { ascending: true }).limit(2000),
      tq.order("sort_order", { ascending: true }),
      overrideCounts(),
      getPrice("zone_defaults"),
    ]);
    if (zones.error) throw new Error(`[pricing] zones read failed: ${zones.error.message}`);
    if (tiers.error) throw new Error(`[pricing] tiers read failed: ${tiers.error.message}`);

    const zoneRows = (zones.data ?? []) as ZoneRow[];
    // zone_count = live zones only, even when archived ones are listed.
    const zoneCount = new Map<string, number>();
    for (const z of zoneRows) if (!z.archived_at) zoneCount.set(z.tier, (zoneCount.get(z.tier) ?? 0) + 1);
    return c.json(
      {
        zones: zoneRows.map((z) => zoneView(z, counts.byZone.get(z.id) ?? 0)),
        tiers: ((tiers.data ?? []) as TierRow[]).map((t) => tierView(t, zoneCount.get(t.code) ?? 0, counts.byTier.get(t.code) ?? 0)),
        unzoned_tier: unzoned.value.unzoned_tier,
      },
      200
    );
  }
);

// ─── GET /pricing/admin/zones/lookup ─────────────────────────────────
// "What does a rider pay here?" — the place of a point, the effective value of
// every zone/tier-scopable fee there, and three sample 5 km fares.
const lookupServices = (key: PricingKey): (string | null)[] => {
  if (key === "courier_fare") return ["courier"];
  if (key === "ride_fare") return ["ride"];
  if (key === "store_delivery") return ["merchant"];
  return PRICING_SCOPES[key].service ?? [null];
};

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/zones/lookup",
    operationId: "lookupPricingZoneAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { query: PricingLookupQuery },
    responses: { 200: json(PricingLookupResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const { lat, lng } = c.req.valid("query");
    // Fresh read: a lookup right after drawing a zone must see it.
    invalidatePricingCache();
    const place = await pricingPlace({ lat, lng });
    const pc = placeContext(place);

    const entries = PRICING_KEYS.filter((k) => PRICING_SCOPES[k].zone || PRICING_SCOPES[k].tier).flatMap((key) =>
      lookupServices(key).map((service) => ({ key, service }))
    );
    const values = await Promise.all(
      entries.map(async ({ key, service }) => {
        const r = await getPrice(key, { ...pc, ...(service ? { service } : {}) });
        return { key, service, value: r.value as unknown, override_id: r.overrideId };
      })
    );

    // One sample per enabled class per service (a 5 road-km same-place trip), + the store sample.
    const KM = 5;
    const sample = async (scenario: "ride" | "courier") => {
      const key = scenario === "ride" ? "ride_fare" : "courier_fare";
      const [p, legs] = await Promise.all([
        getPrices([key, "fare_multiplier", "fare_formula", "service_area"] as const, { service: scenario, ...pc }),
        getClassLegs(key, { service: scenario, ...pc }),
      ]);
      const formula = p.fare_formula.value;
      return legs.map(({ cls, leg }) => {
        const fare = fareBreakdown(leg, KM, {
          multiplier: p.fare_multiplier.value.multiplier,
          extraStopFee: scenario === "courier" ? (p.courier_fare as any).value.extra_stop_fee : 0,
          formula,
          speedKmh: formula.speed_kmh[cls.base_vehicle],
        }).fare;
        const unavailable = !p.service_area.value.enabled ? ("out_of_service_area" as const) : KM > leg.max_km ? ("too_far" as const) : null;
        return { scenario, vehicle: cls.code, km: KM, fare, available: unavailable == null, unavailable };
      });
    };
    // Store: the distance-mode fee (null in merchant mode), at the point itself as store and customer.
    const storeSample = async () => {
      const sctx = { service: "merchant", ...pc };
      const [rule, p, legs] = await Promise.all([
        getPrice("store_delivery", sctx),
        getPrices(["fare_multiplier", "fare_formula"] as const, sctx),
        getClassLegs("store_delivery", sctx),
      ]);
      const q = priceStoreDelivery({
        rule: rule.value,
        merchantFee: 0,
        km: KM,
        legs,
        multiplier: p.fare_multiplier.value.multiplier,
        formula: p.fare_formula.value,
      });
      const distance = rule.value.mode === "distance" && q.mode === "distance";
      const vehicle = q.vehicle ?? legs[0]?.cls.code ?? "motorcycle";
      const leg = legs.find((l) => l.cls.code === vehicle)?.leg;
      return {
        scenario: "store" as const,
        vehicle,
        km: KM,
        fare: distance ? q.fee : null,
        available: true,
        unavailable: leg && KM > leg.max_km ? ("too_far" as const) : null,
        mode: rule.value.mode,
      };
    };
    const [rideSamples, courierSamples, store] = await Promise.all([sample("ride"), sample("courier"), storeSample()]);
    const samples = [...rideSamples, ...courierSamples, store];

    return c.json(
      {
        place: {
          wilaya_code: place.wilaya,
          zone: place.zoneId ? { id: place.zoneId, name: place.zoneName ?? "", tier: place.tier ?? "" } : null,
          tier: place.tier,
          unzoned: place.unzoned,
        },
        values,
        samples,
      },
      200
    );
  }
);

// ─── POST /pricing/admin/zones ───────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/zones",
    operationId: "createPricingZoneAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { body: { ...json(CreatePricingZoneBody), required: true } },
    responses: {
      201: json(PricingZoneResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const body = c.req.valid("json");
    const geo = normalizeGeometry(body.geometry);
    if (!geo.ok) return c.json({ error: geo.error, code: "geometry" }, 400);
    if (!(await liveTier(body.tier))) return c.json({ error: "tier doesn't match a live tier", code: "tier" }, 400);
    const w = wilayaFor(body.wilaya_code, geo.geometry);
    if ("error" in w) return c.json({ error: w.error, code: "wilaya" }, 400);

    const { data, error } = await supabaseAdmin
      .from("pricing_zones")
      .insert({
        name: body.name,
        tier: body.tier,
        wilaya_code: w.wilaya,
        geometry: geo.geometry,
        priority: body.priority ?? 0,
        note: body.note ?? null,
        created_by: staff.id,
        updated_by: staff.id,
      })
      .select(ZONE_COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] zone insert failed: ${error?.message}`);

    invalidatePricingCache();
    return c.json({ zone: zoneView(data as ZoneRow, 0) }, 201);
  }
);

// ─── POST /pricing/admin/zones/import ────────────────────────────────
const MAX_IMPORT = 200;

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/zones/import",
    operationId: "importPricingZonesAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { body: { ...json(ImportPricingZonesBody), required: true } },
    responses: {
      201: json(PricingZonesImportResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const body = c.req.valid("json");
    const fc = body.geojson as { type?: unknown; features?: unknown } | null;
    if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
      return c.json({ error: "geojson must be a FeatureCollection", code: "geometry" }, 400);
    }
    if (!fc.features.length) return c.json({ error: "The FeatureCollection has no features", code: "geometry" }, 400);
    if (fc.features.length > MAX_IMPORT) return c.json({ error: `At most ${MAX_IMPORT} features per import`, code: "geometry" }, 400);
    if (!(await liveTier(body.tier))) return c.json({ error: "tier doesn't match a live tier", code: "tier" }, 400);

    // All-or-nothing: validate every feature first, then one INSERT.
    const rows: Record<string, unknown>[] = [];
    for (const [i, f] of (fc.features as any[]).entries()) {
      const geo = normalizeGeometry(f?.geometry);
      if (!geo.ok) return c.json({ error: `Feature ${i + 1}: ${geo.error}`, code: "geometry" }, 400);
      const raw = f?.properties?.[body.name_property];
      const name = (typeof raw === "string" || typeof raw === "number" ? String(raw) : "").trim().slice(0, 80) || `Zone ${i + 1}`;
      rows.push({
        name,
        tier: body.tier,
        wilaya_code: geometryWilaya(geo.geometry),
        geometry: geo.geometry,
        priority: 0,
        created_by: staff.id,
        updated_by: staff.id,
      });
    }
    const { data, error } = await supabaseAdmin.from("pricing_zones").insert(rows).select(ZONE_COLS);
    if (error || !data) throw new Error(`[pricing] zone import failed: ${error?.message}`);

    invalidatePricingCache();
    return c.json({ zones: (data as ZoneRow[]).map((z) => zoneView(z, 0)) }, 201);
  }
);

// ─── PATCH /pricing/admin/zones/{id} ─────────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/zones/{id}",
    operationId: "updatePricingZoneAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingZoneIdParam, body: { ...json(UpdatePricingZoneBody), required: true } },
    responses: {
      200: json(PricingZoneResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingStaleError, "Someone changed it since you loaded it (error stale)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const current = await zoneRow(id);
    if (!current) return c.json({ error: "Zone not found" }, 404);
    if (current.archived_at) return c.json({ error: "This zone is archived" }, 400);
    if (body.expected_updated_at && Date.parse(body.expected_updated_at) !== Date.parse(current.updated_at)) {
      return c.json({ error: "stale" as const, updated_at: current.updated_at }, 409);
    }

    const patch: Record<string, unknown> = { updated_by: staff.id };
    let geometry = current.geometry;
    if (body.name !== undefined) patch.name = body.name;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.note !== undefined) patch.note = body.note;
    if (body.tier !== undefined) {
      if (!(await liveTier(body.tier))) return c.json({ error: "tier doesn't match a live tier", code: "tier" }, 400);
      patch.tier = body.tier;
    }
    if (body.geometry !== undefined) {
      const geo = normalizeGeometry(body.geometry);
      if (!geo.ok) return c.json({ error: geo.error, code: "geometry" }, 400);
      geometry = geo.geometry;
      patch.geometry = geometry;
    }
    // An explicit wilaya wins; a redrawn zone without one is re-derived.
    if (body.wilaya_code !== undefined || body.geometry !== undefined) {
      const w = wilayaFor(body.wilaya_code, geometry);
      if ("error" in w) return c.json({ error: w.error, code: "wilaya" }, 400);
      patch.wilaya_code = w.wilaya;
    }

    const { data, error } = await supabaseAdmin.from("pricing_zones").update(patch).eq("id", id).select(ZONE_COLS).single();
    if (error || !data) throw new Error(`[pricing] zone update failed: ${error?.message}`);

    invalidatePricingCache();
    const counts = await overrideCounts();
    return c.json({ zone: zoneView(data as ZoneRow, counts.byZone.get(id) ?? 0) }, 200);
  }
);

// ─── DELETE /pricing/admin/zones/{id} (archives) ─────────────────────
app.openapi(
  createRoute({
    method: "delete",
    path: "/admin/zones/{id}",
    operationId: "archivePricingZoneAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingZoneIdParam },
    responses: {
      200: json(PricingZoneResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingZoneInUseError, "Live overrides still target this zone (code zone_in_use)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { id } = c.req.valid("param");
    const current = await zoneRow(id);
    if (!current) return c.json({ error: "Zone not found" }, 404);
    const counts = await overrideCounts();
    const overrides = counts.byZone.get(id) ?? 0;
    if (current.archived_at) return c.json({ zone: zoneView(current, overrides) }, 200);
    if (overrides > 0) {
      return c.json(
        { error: "Archive or move the overrides targeting this zone first", code: "zone_in_use" as const, override_count: overrides },
        409
      );
    }
    const { data, error } = await supabaseAdmin
      .from("pricing_zones")
      .update({ archived_at: new Date().toISOString(), updated_by: staff.id })
      .eq("id", id)
      .select(ZONE_COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] zone archive failed: ${error?.message}`);
    invalidatePricingCache();
    return c.json({ zone: zoneView(data as ZoneRow, 0) }, 200);
  }
);

// ─── Tiers ───────────────────────────────────────────────────────────
async function tierRow(code: string): Promise<TierRow | null> {
  const { data, error } = await supabaseAdmin.from("pricing_tiers").select(TIER_COLS).eq("code", code).maybeSingle();
  if (error) throw new Error(`[pricing] tier read failed: ${error.message}`);
  return (data as TierRow | null) ?? null;
}

async function tierUsage(code: string) {
  const [zones, counts, settings, defOverrides] = await Promise.all([
    supabaseAdmin.from("pricing_zones").select("id", { count: "exact", head: true }).eq("tier", code).is("archived_at", null),
    overrideCounts(),
    supabaseAdmin.from("pricing_settings").select("value").eq("key", "zone_defaults").maybeSingle(),
    supabaseAdmin.from("pricing_overrides").select("value").eq("key", "zone_defaults").is("archived_at", null),
  ]);
  if (zones.error) throw new Error(`[pricing] tier usage failed: ${zones.error.message}`);
  const names = (v: unknown) => (v as { unzoned_tier?: string } | null)?.unzoned_tier === code;
  return {
    zoneCount: zones.count ?? 0,
    overrideCount: counts.byTier.get(code) ?? 0,
    defaultInUse: names(settings.data?.value) || (defOverrides.data ?? []).some((o) => names(o.value)),
  };
}

// ─── POST /pricing/admin/tiers ───────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/tiers",
    operationId: "createPricingTierAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { body: { ...json(CreatePricingTierBody), required: true } },
    responses: {
      201: json(PricingTierResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: errorResponses[409],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const body = c.req.valid("json");
    if (await tierRow(body.code)) return c.json({ error: "A tier with this code already exists", code: "tier_exists" }, 409);

    let sort = body.sort_order;
    if (sort == null) {
      const { data } = await supabaseAdmin.from("pricing_tiers").select("sort_order").order("sort_order", { ascending: false }).limit(1);
      sort = ((data?.[0]?.sort_order as number | undefined) ?? 0) + 1;
    }
    const { data, error } = await supabaseAdmin
      .from("pricing_tiers")
      .insert({
        code: body.code,
        names: body.names,
        color: body.color,
        sort_order: sort,
        note: body.note ?? null,
        created_by: staff.id,
        updated_by: staff.id,
      })
      .select(TIER_COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] tier insert failed: ${error?.message}`);

    invalidatePricingCache();
    return c.json({ tier: tierView(data as TierRow, 0, 0) }, 201);
  }
);

// ─── PATCH /pricing/admin/tiers/{code} ───────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/tiers/{code}",
    operationId: "updatePricingTierAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingTierCodeParam, body: { ...json(UpdatePricingTierBody), required: true } },
    responses: {
      200: json(PricingTierResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { code } = c.req.valid("param");
    const body = c.req.valid("json");
    const current = await tierRow(code);
    if (!current) return c.json({ error: "Tier not found" }, 404);
    if (current.archived_at) return c.json({ error: "This tier is archived" }, 400);

    const patch: Record<string, unknown> = { updated_by: staff.id };
    if (body.names !== undefined) patch.names = body.names;
    if (body.color !== undefined) patch.color = body.color;
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
    if (body.note !== undefined) patch.note = body.note;

    const { data, error } = await supabaseAdmin.from("pricing_tiers").update(patch).eq("code", code).select(TIER_COLS).single();
    if (error || !data) throw new Error(`[pricing] tier update failed: ${error?.message}`);

    invalidatePricingCache();
    const u = await tierUsage(code);
    return c.json({ tier: tierView(data as TierRow, u.zoneCount, u.overrideCount) }, 200);
  }
);

// ─── DELETE /pricing/admin/tiers/{code} (archives) ───────────────────
app.openapi(
  createRoute({
    method: "delete",
    path: "/admin/tiers/{code}",
    operationId: "archivePricingTierAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingTierCodeParam },
    responses: {
      200: json(PricingTierResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingTierInUseError, "A live zone / override / zone_defaults value uses it (code tier_in_use)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { code } = c.req.valid("param");
    const current = await tierRow(code);
    if (!current) return c.json({ error: "Tier not found" }, 404);
    const u = await tierUsage(code);
    if (current.archived_at) return c.json({ tier: tierView(current, u.zoneCount, u.overrideCount) }, 200);
    if (u.zoneCount > 0 || u.overrideCount > 0 || u.defaultInUse) {
      return c.json(
        {
          error: "Move the zones, overrides and the unzoned-tier setting off this tier first",
          code: "tier_in_use" as const,
          zone_count: u.zoneCount,
          override_count: u.overrideCount,
          default_in_use: u.defaultInUse,
        },
        409
      );
    }
    const { data, error } = await supabaseAdmin
      .from("pricing_tiers")
      .update({ archived_at: new Date().toISOString(), updated_by: staff.id })
      .eq("code", code)
      .select(TIER_COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] tier archive failed: ${error?.message}`);
    invalidatePricingCache();
    return c.json({ tier: tierView(data as TierRow, 0, 0) }, 200);
  }
);

export default app;
