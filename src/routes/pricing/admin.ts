// Staff console for the pricing config (tag admin-pricing → excluded from the
// mobile client by orval; the dashboard's /pricing module calls it). Reads:
// finance / ops / commerce admins; writes: finance_admin (super_admin always).
// Every write drops the pricing cache; the pricing_changes log is written by DB
// triggers (same transaction as the write), keyed on updated_by / created_by.
import { isPartnerDealKey, pricingDealCopy, PARTNER_DEAL_KEYS } from "../../lib/pricing/copy";
import {
  fieldsFor,
  isLegKey,
  isPricingKey,
  legClassError,
  legOf,
  PRICING_FIELDS,
  PRICING_GROUPS,
  PRICING_SCHEMAS,
  PRICING_SCOPES,
  PRICING_SEEDS,
  PRICING_UNITS,
  scopeError,
  type PricingKey,
} from "../../lib/pricing/catalog";
import { fareBreakdown, SEED_FORMULA, surchargeFor } from "../../lib/pricing/fare";
import { haversineKm, routeKm } from "../../lib/courier-pricing";
import { rideKm } from "../../lib/ride-pricing";
import { feeExample, type ExampleValues } from "../../lib/pricing/examples";
import { legsFromValue, type ClassLeg, type VehicleClass } from "../../lib/pricing/vehicle-classes";
import { priceStoreDelivery } from "../../lib/pricing/store-delivery";
import { liveClassViews } from "./vehicle-classes";
import { simulate, SIM_DEFAULTS, type SimInputs, type SimPrices } from "../../lib/pricing/simulate";
import { orderPricingContext } from "../../lib/pricing/fees";
import {
  getAllPrices,
  getPrice,
  getPrices,
  getClassLegs,
  getVehicleClasses,
  invalidatePricingCache,
  placeContext,
  pricingPlace,
  type PricingContext,
  type PricingPlace,
} from "../../lib/pricing";
import { isActive, overlaps, type OverrideLike } from "../../lib/pricing/resolve";
import { createNotification } from "../../lib/notifications";
import { canActivate } from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  CreatePricingOverrideBody,
  ListPricingOverridesQuery,
  PricingCatalogResponse,
  PricingFeeResponse,
  PricingHistoryQuery,
  PricingHistoryResponse,
  PricingKeyParam,
  PricingOverlapError,
  PricingOverrideIdParam,
  PricingOverrideResponse,
  PricingOverridesResponse,
  PricingPreviewBody,
  PricingPreviewResponse,
  PricingSimulateBody,
  PricingSimulateResponse,
  PricingStaleError,
  UpdatePricingDefaultBody,
  UpdatePricingOverrideBody,
} from "../../validators/pricing";

const app = router();

const readStaff = requireStaffRole("finance_admin", "ops_admin", "commerce_admin");
const writeStaff = requireStaffRole("finance_admin");

type OverrideRow = OverrideLike & {
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
};

const OVERRIDE_COLS =
  "id, key, service, wilaya_code, merchant_id, agent_id, zone_id, tier, value, starts_at, ends_at, note, created_by, updated_by, archived_at, created_at, updated_at";

const nameOf = (u?: { first_name: string | null; last_name: string | null }) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null;

async function namesById(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const map = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, first_name, last_name")
      .in("id", unique.slice(i, i + 100));
    for (const u of data ?? []) map.set(u.id, nameOf(u));
  }
  return map;
}

type OverrideScope = {
  service: string | null;
  wilaya_code: string | null;
  merchant_id: string | null;
  agent_id: string | null;
  zone_id: string | null;
  tier: string | null;
};

/** The scope columns of the overrides that won a resolution (for "why this price"). */
async function scopesById(ids: string[]) {
  const map = new Map<string, OverrideScope>();
  if (!ids.length) return map;
  const { data } = await supabaseAdmin
    .from("pricing_overrides")
    .select("id, service, wilaya_code, merchant_id, agent_id, zone_id, tier")
    .in("id", ids);
  for (const o of data ?? []) {
    map.set(o.id, {
      service: o.service,
      wilaya_code: o.wilaya_code,
      merchant_id: o.merchant_id,
      agent_id: o.agent_id,
      zone_id: o.zone_id ?? null,
      tier: o.tier ?? null,
    });
  }
  return map;
}

const resultIds = (keys: readonly PricingKey[], results: Record<string, { overrideId: string | null }>) =>
  keys.map((k) => results[k].overrideId);

/** The place as the staff API shows it. */
const placeView = (p: PricingPlace) => ({
  wilaya_code: p.wilaya,
  zone: p.zoneId ? { id: p.zoneId, name: p.zoneName ?? "", tier: p.tier ?? "" } : null,
  tier: p.tier,
  unzoned: p.unzoned,
});

function statusOf(o: OverrideLike, now = new Date()): "active" | "scheduled" | "ended" | "archived" {
  if (o.archived_at) return "archived";
  if (o.ends_at && Date.parse(o.ends_at) <= now.getTime()) return "ended";
  if (o.starts_at && Date.parse(o.starts_at) > now.getTime()) return "scheduled";
  return "active";
}

/** Partner names + zone names for a page of overrides. */
async function viewMaps(rows: OverrideRow[]) {
  const [names, zones] = await Promise.all([
    namesById(rows.map((o) => o.merchant_id ?? o.agent_id)),
    zoneNamesById(rows.map((o) => o.zone_id)),
  ]);
  return { names, zones };
}

async function zoneNamesById(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const { data } = await supabaseAdmin.from("pricing_zones").select("id, name").in("id", unique);
  for (const z of data ?? []) map.set(z.id, z.name);
  return map;
}

function overrideView(o: OverrideRow, maps: { names: Map<string, string | null>; zones: Map<string, string> }) {
  const partner = o.merchant_id ?? o.agent_id;
  const names = maps.names;
  return {
    id: o.id,
    key: o.key as PricingKey,
    service: o.service,
    wilaya_code: o.wilaya_code,
    merchant_id: o.merchant_id,
    agent_id: o.agent_id,
    zone_id: o.zone_id ?? null,
    tier: o.tier ?? null,
    zone_name: o.zone_id ? maps.zones.get(o.zone_id) ?? null : null,
    value: o.value,
    starts_at: o.starts_at,
    ends_at: o.ends_at,
    note: o.note,
    status: statusOf(o),
    partner_name: partner ? names.get(partner) ?? null : null,
    created_by: o.created_by,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

/** Postgres exclusion_violation: the DB's overlap guard (a race the app-level check can't see). */
const isExclusionViolation = (e: { code?: string } | null | undefined) => e?.code === "23P01";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Scope ids must be real accounts holding the matching partner role. */
async function partnerScopeError(scope: { merchant_id: string | null; agent_id: string | null }): Promise<string | null> {
  for (const [role, id] of [
    ["merchant", scope.merchant_id],
    ["agent", scope.agent_id],
  ] as const) {
    if (!id) continue;
    const { data, error } = await supabaseAdmin.from("users").select("id, role, granted_roles").eq("id", id).maybeSingle();
    if (error) throw new Error(`[pricing] partner lookup failed: ${error.message}`);
    if (!data) return `${role}_id doesn't match any account`;
    if (!canActivate([...((data.granted_roles as string[] | null) ?? []), data.role as string], role)) {
      return `That account isn't a ${role}`;
    }
  }
  return null;
}

/** The zone / tier an override targets must exist and be live (not archived). */
async function placeScopeError(scope: { zone_id: string | null; tier: string | null }): Promise<string | null> {
  if (scope.zone_id) {
    const { data, error } = await supabaseAdmin.from("pricing_zones").select("id, archived_at").eq("id", scope.zone_id).maybeSingle();
    if (error) throw new Error(`[pricing] zone lookup failed: ${error.message}`);
    if (!data) return "zone_id doesn't match any zone";
    if (data.archived_at) return "That zone is archived";
  }
  if (scope.tier) {
    const { data, error } = await supabaseAdmin.from("pricing_tiers").select("code, archived_at").eq("code", scope.tier).maybeSingle();
    if (error) throw new Error(`[pricing] tier lookup failed: ${error.message}`);
    if (!data) return "tier doesn't match any tier";
    if (data.archived_at) return "That tier is archived";
  }
  return null;
}

/** Live tier codes (the options of `tier` fields; what a tier-valued fee may name). */
async function liveTierCodes(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("pricing_tiers")
    .select("code")
    .is("archived_at", null)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`[pricing] tiers read failed: ${error.message}`);
  return (data ?? []).map((t) => t.code as string);
}

/** A value whose `tier` fields name a tier that isn't live → the error to return, else null. */
async function tierValueError(key: PricingKey, value: unknown): Promise<{ error: string; code: "tier"; details: { path: string; message: string }[] } | null> {
  const fields = PRICING_FIELDS[key].filter((f) => f.unit === "tier");
  if (!fields.length) return null;
  const live = await liveTierCodes();
  const details = fields
    .map((f) => ({ path: f.path, tier: f.path.split(".").reduce<any>((o, p) => o?.[p], value) }))
    .filter((x) => !live.includes(x.tier))
    .map((x) => ({ path: x.path, message: `"${x.tier}" isn't a live tier` }));
  return details.length ? { error: "Unknown or archived tier", code: "tier", details } : null;
}

/** Live (non-archived) classes read from the table, not the 15 s cache: a save right after creating a class must see it. */
async function liveClassesFresh(): Promise<VehicleClass[]> {
  invalidatePricingCache();
  return (await getVehicleClasses()).filter((c) => !c.archived);
}

/** The first live override with the same key + scope + overlapping window, if any. */
async function findConflict(candidate: OverrideLike, exceptId?: string) {
  const { data, error } = await supabaseAdmin
    .from("pricing_overrides")
    .select(OVERRIDE_COLS)
    .eq("key", candidate.key)
    .is("archived_at", null);
  if (error) throw new Error(`[pricing] overlap check failed: ${error.message}`);
  return ((data ?? []) as OverrideRow[]).find((o) => o.id !== exceptId && overlaps(candidate, o)) ?? null;
}

/** Tell the merchant / agent a deal targeting them changed. Best-effort. */
async function notifyPartner(
  kind: "created" | "updated" | "archived",
  o: OverrideRow,
  staffId: string
) {
  const partnerId = o.merchant_id ?? o.agent_id;
  if (!partnerId || !isPartnerDealKey(o.key)) return;
  try {
    invalidatePricingCache();
    const rate = (o.value as { rate?: number })?.rate;
    if (typeof rate !== "number") return;
    // What they fall back to (default, or a looser deal) — the archived one is already excluded.
    const fallback = await getPrice(o.key, {
      wilaya: o.wilaya_code,
      zoneId: o.zone_id ?? null,
      tier: o.tier ?? null,
      merchantId: o.merchant_id,
      agentId: o.agent_id,
    });
    const copy = pricingDealCopy({
      kind,
      key: o.key,
      rate,
      defaultRate: fallback.value.rate,
      startsAt: o.starts_at,
      endsAt: o.ends_at,
    });
    await createNotification({
      userId: partnerId,
      role: PARTNER_DEAL_KEYS[o.key],
      type: "alert",
      title: copy.en.title,
      description: copy.en.description,
      contentEng: copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
      payload: { kind: `pricing_deal_${kind}`, key: o.key, override_id: o.id, rate },
      createdBy: staffId,
    });
  } catch (err) {
    console.error("[pricing] partner notification failed", err instanceof Error ? err.message : err);
  }
}

function feeView(
  key: PricingKey,
  row: { value: unknown; updated_at: string | null; updated_by: string | null } | undefined,
  active: number,
  defaults: ExampleValues = PRICING_SEEDS,
  tiers: string[] = [],
  classes: readonly VehicleClass[] = []
) {
  return {
    key,
    group: PRICING_GROUPS[key],
    unit: PRICING_UNITS[key],
    scopes: PRICING_SCOPES[key],
    // `tier` fields list the live tiers as their options.
    // Leg fields are generated per live class serving the key's service (each carries `class`).
    fields: fieldsFor(key, classes.filter((c) => !c.archived)).map((f) => (f.unit === "tier" ? { ...f, options: tiers } : f)),
    value: row?.value ?? PRICING_SEEDS[key],
    seed: PRICING_SEEDS[key],
    updated_at: row?.updated_at ?? null,
    updated_by: row?.updated_by ?? null,
    active_overrides: active,
    example: feeExample(key, row?.value ?? PRICING_SEEDS[key], defaults),
  };
}

async function activeCounts() {
  const now = new Date();
  const { data } = await supabaseAdmin
    .from("pricing_overrides")
    .select("key, starts_at, ends_at, archived_at")
    .is("archived_at", null);
  const counts = new Map<string, number>();
  for (const o of (data ?? []) as OverrideLike[]) {
    if (isActive(o, now)) counts.set(o.key, (counts.get(o.key) ?? 0) + 1);
  }
  return counts;
}

// ─── GET /pricing/admin/catalog ──────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/catalog",
    operationId: "getPricingCatalogAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    responses: { 200: json(PricingCatalogResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const [{ data, error }, counts, tiers, classViews] = await Promise.all([
      supabaseAdmin.from("pricing_settings").select("key, value, updated_at, updated_by"),
      activeCounts(),
      liveTierCodes(),
      liveClassViews(),
    ]);
    if (error) throw new Error(`[pricing] settings read failed: ${error.message}`);
    const rows = new Map((data ?? []).map((r) => [r.key as string, r]));
    const keys = Object.keys(PRICING_SEEDS) as PricingKey[];
    const defaults = Object.fromEntries(keys.map((k) => [k, rows.get(k)?.value ?? PRICING_SEEDS[k]])) as ExampleValues;
    return c.json(
      { fees: keys.map((k) => feeView(k, rows.get(k), counts.get(k) ?? 0, defaults, tiers, classViews)), vehicle_classes: classViews },
      200
    );
  }
);

// ─── PUT /pricing/admin/defaults/{key} ───────────────────────────────
app.openapi(
  createRoute({
    method: "put",
    path: "/admin/defaults/{key}",
    operationId: "updatePricingDefaultAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingKeyParam, body: { ...json(UpdatePricingDefaultBody), required: true } },
    responses: {
      200: json(PricingFeeResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingStaleError, "Someone changed it since you loaded it (error stale)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!isPricingKey(key)) return c.json({ error: "Unknown pricing key" }, 404);

    const parsed = PRICING_SCHEMAS[key].safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid value",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400
      );
    }

    const tierProblem = await tierValueError(key, parsed.data);
    if (tierProblem) return c.json(tierProblem, 400);
    const classProblem = legClassError(key, parsed.data, await liveClassesFresh());
    if (classProblem) return c.json({ error: classProblem, code: "class" }, 400);

    const { data: current } = await supabaseAdmin
      .from("pricing_settings")
      .select("key, value, updated_at, updated_by")
      .eq("key", key)
      .maybeSingle();
    if (
      body.expected_updated_at &&
      Date.parse(body.expected_updated_at) !== Date.parse(current?.updated_at ?? "")
    ) {
      return c.json({ error: "stale" as const, updated_at: current?.updated_at ?? null }, 409);
    }

    const { data: saved, error } = await supabaseAdmin
      .from("pricing_settings")
      .upsert({ key, value: parsed.data, updated_by: staff.id }, { onConflict: "key" })
      .select("key, value, updated_at, updated_by")
      .single();
    if (error || !saved) throw new Error(`[pricing] default write failed: ${error?.message}`);

    invalidatePricingCache();
    const counts = await activeCounts();
    return c.json({ fee: feeView(key, saved, counts.get(key) ?? 0, PRICING_SEEDS, await liveTierCodes(), await liveClassesFresh()) }, 200);
  }
);

// ─── GET /pricing/admin/overrides ────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/overrides",
    operationId: "listPricingOverridesAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { query: ListPricingOverridesQuery },
    responses: { 200: json(PricingOverridesResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const q = c.req.valid("query");
    let query = supabaseAdmin.from("pricing_overrides").select(OVERRIDE_COLS);
    if (q.key) query = query.eq("key", q.key);
    if (q.wilaya_code) query = query.eq("wilaya_code", q.wilaya_code);
    if (q.merchant_id) query = query.eq("merchant_id", q.merchant_id);
    if (q.agent_id) query = query.eq("agent_id", q.agent_id);
    if (q.zone_id) query = query.eq("zone_id", q.zone_id);
    if (q.tier) query = query.eq("tier", q.tier);
    if (q.status === "archived") query = query.not("archived_at", "is", null);
    else if (q.status) query = query.is("archived_at", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(`[pricing] overrides read failed: ${error.message}`);

    let rows = (data ?? []) as OverrideRow[];
    if (q.status) rows = rows.filter((o) => statusOf(o) === q.status);
    const maps = await viewMaps(rows);
    return c.json({ overrides: rows.map((o) => overrideView(o, maps)) }, 200);
  }
);

// ─── POST /pricing/admin/overrides ───────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/overrides",
    operationId: "createPricingOverrideAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { body: { ...json(CreatePricingOverrideBody), required: true } },
    responses: {
      201: json(PricingOverrideResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: json(PricingOverlapError, "Same fee + scope already has a deal in that window (error overlap)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const body = c.req.valid("json");
    if (!isPricingKey(body.key)) return c.json({ error: "Unknown pricing key" }, 400);
    const key = body.key;

    const scope = {
      service: body.service ?? null,
      wilaya_code: body.wilaya_code ?? null,
      merchant_id: body.merchant_id ?? null,
      agent_id: body.agent_id ?? null,
      zone_id: body.zone_id ?? null,
      tier: body.tier ?? null,
    };
    const problem = scopeError(key, scope) ?? (await partnerScopeError(scope)) ?? (await placeScopeError(scope));
    // `code: "scope"` lets the dashboard send the editor back to the scope step.
    if (problem) return c.json({ error: problem, code: "scope" }, 400);

    const parsed = PRICING_SCHEMAS[key].safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid value",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400
      );
    }
    const tierProblem = await tierValueError(key, parsed.data);
    if (tierProblem) return c.json(tierProblem, 400);
    const classProblem = legClassError(key, parsed.data, await liveClassesFresh());
    if (classProblem) return c.json({ error: classProblem, code: "class" }, 400);
    const starts_at = body.starts_at ?? null;
    const ends_at = body.ends_at ?? null;
    if (starts_at && ends_at && Date.parse(ends_at) <= Date.parse(starts_at)) {
      return c.json({ error: "ends_at must be after starts_at" }, 400);
    }

    const candidate: OverrideLike = { id: "", key, ...scope, value: parsed.data, starts_at, ends_at };
    const conflict = await findConflict(candidate);
    if (conflict) return c.json({ error: "overlap" as const, conflict_id: conflict.id }, 409);

    const { data, error } = await supabaseAdmin
      .from("pricing_overrides")
      .insert({
        key,
        ...scope,
        value: parsed.data,
        starts_at,
        ends_at,
        note: body.note ?? null,
        created_by: staff.id,
        updated_by: staff.id,
      })
      .select(OVERRIDE_COLS)
      .single();
    if (isExclusionViolation(error)) {
      const raced = await findConflict(candidate);
      return c.json({ error: "overlap" as const, conflict_id: raced?.id ?? NIL_UUID }, 409);
    }
    if (error || !data) throw new Error(`[pricing] override insert failed: ${error?.message}`);
    const row = data as OverrideRow;

    invalidatePricingCache();
    await notifyPartner("created", row, staff.id);
    const maps = await viewMaps([row]);
    return c.json({ override: overrideView(row, maps) }, 201);
  }
);

// ─── PATCH /pricing/admin/overrides/{id} ─────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/overrides/{id}",
    operationId: "updatePricingOverrideAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingOverrideIdParam, body: { ...json(UpdatePricingOverrideBody), required: true } },
    responses: {
      200: json(PricingOverrideResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingOverlapError, "Overlaps another deal (error overlap)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const { data: current } = await supabaseAdmin
      .from("pricing_overrides")
      .select(OVERRIDE_COLS)
      .eq("id", id)
      .maybeSingle();
    if (!current) return c.json({ error: "Override not found" }, 404);
    const before = current as OverrideRow;
    if (before.archived_at) return c.json({ error: "This deal is archived" }, 400);
    if (!isPricingKey(before.key)) return c.json({ error: "Unknown pricing key" }, 400);

    const patch: Record<string, unknown> = { updated_by: staff.id };
    let value = before.value;
    if (body.value !== undefined) {
      const parsed = PRICING_SCHEMAS[before.key].safeParse(body.value);
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid value",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          400
        );
      }
      const tierProblem = await tierValueError(before.key, parsed.data);
      if (tierProblem) return c.json(tierProblem, 400);
      const classProblem = legClassError(before.key, parsed.data, await liveClassesFresh());
      if (classProblem) return c.json({ error: classProblem, code: "class" }, 400);
      value = parsed.data;
      patch.value = value;
    }
    const starts_at = body.starts_at !== undefined ? body.starts_at : before.starts_at;
    const ends_at = body.ends_at !== undefined ? body.ends_at : before.ends_at;
    if (body.starts_at !== undefined) patch.starts_at = starts_at;
    if (body.ends_at !== undefined) patch.ends_at = ends_at;
    if (body.note !== undefined) patch.note = body.note;
    if (starts_at && ends_at && Date.parse(ends_at) <= Date.parse(starts_at)) {
      return c.json({ error: "ends_at must be after starts_at" }, 400);
    }

    const conflict = await findConflict({ ...before, value, starts_at, ends_at }, id);
    if (conflict) return c.json({ error: "overlap" as const, conflict_id: conflict.id }, 409);

    const { data, error } = await supabaseAdmin
      .from("pricing_overrides")
      .update(patch)
      .eq("id", id)
      .select(OVERRIDE_COLS)
      .single();
    if (isExclusionViolation(error)) {
      const raced = await findConflict({ ...before, value, starts_at, ends_at }, id);
      return c.json({ error: "overlap" as const, conflict_id: raced?.id ?? NIL_UUID }, 409);
    }
    if (error || !data) throw new Error(`[pricing] override update failed: ${error?.message}`);
    const row = data as OverrideRow;

    invalidatePricingCache();
    // A note-only edit changes nothing the partner pays: no notification.
    const sameTime = (a: string | null, b: string | null) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
    const material =
      JSON.stringify(row.value) !== JSON.stringify(before.value) ||
      !sameTime(row.starts_at, before.starts_at) ||
      !sameTime(row.ends_at, before.ends_at);
    if (material) await notifyPartner("updated", row, staff.id);
    const maps = await viewMaps([row]);
    return c.json({ override: overrideView(row, maps) }, 200);
  }
);

// ─── DELETE /pricing/admin/overrides/{id} (archives) ─────────────────
app.openapi(
  createRoute({
    method: "delete",
    path: "/admin/overrides/{id}",
    operationId: "archivePricingOverrideAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: PricingOverrideIdParam },
    responses: {
      200: json(PricingOverrideResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { id } = c.req.valid("param");
    const { data: current } = await supabaseAdmin
      .from("pricing_overrides")
      .select(OVERRIDE_COLS)
      .eq("id", id)
      .maybeSingle();
    if (!current) return c.json({ error: "Override not found" }, 404);
    const before = current as OverrideRow;

    let row = before;
    if (!before.archived_at) {
      const { data, error } = await supabaseAdmin
        .from("pricing_overrides")
        .update({ archived_at: new Date().toISOString(), updated_by: staff.id })
        .eq("id", id)
        .select(OVERRIDE_COLS)
        .single();
      if (error || !data) throw new Error(`[pricing] override archive failed: ${error?.message}`);
      row = data as OverrideRow;
      invalidatePricingCache();
      // "Returns to default" only makes sense for a deal that was in force.
      if (statusOf(before) === "active") await notifyPartner("archived", row, staff.id);
    }
    const maps = await viewMaps([row]);
    return c.json({ override: overrideView(row, maps) }, 200);
  }
);

// ─── GET /pricing/admin/history ──────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/history",
    operationId: "listPricingHistoryAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { query: PricingHistoryQuery },
    responses: { 200: json(PricingHistoryResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const q = c.req.valid("query");
    let query = supabaseAdmin
      .from("pricing_changes")
      .select("id, key, override_id, zone_id, tier, vehicle_class, action, before, after, actor_id, created_at");
    if (q.key) query = query.eq("key", q.key);
    if (q.override_id) query = query.eq("override_id", q.override_id);
    if (q.zone_id) query = query.eq("zone_id", q.zone_id);
    if (q.tier) query = query.eq("tier", q.tier);
    if (q.vehicle_class) query = query.eq("vehicle_class", q.vehicle_class);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(q.limit);
    if (error) throw new Error(`[pricing] history read failed: ${error.message}`);
    const rows = data ?? [];
    const names = await namesById(rows.map((r) => r.actor_id));
    return c.json(
      { changes: rows.map((r) => ({ ...r, actor_name: r.actor_id ? names.get(r.actor_id) ?? null : null })) },
      200
    );
  }
);

// ─── POST /pricing/admin/preview ─────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/preview",
    operationId: "previewPricingAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { body: { ...json(PricingPreviewBody), required: true } },
    responses: {
      200: json(PricingPreviewResponse),
      400: json(ErrorSchema, "Bad request"),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const { context, sample, candidate } = c.req.valid("json");
    let candidateValue: { key: PricingKey; value: any } | null = null;
    if (candidate) {
      const parsed = PRICING_SCHEMAS[candidate.key].safeParse(candidate.value);
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid candidate value",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          400
        );
      }
      candidateValue = { key: candidate.key, value: parsed.data };
    }
    // Fresh read: a preview right after a save must show the save.
    invalidatePricingCache();
    const ctx = {
      service: context.service,
      wilaya: context.wilaya_code ?? null,
      zoneId: context.zone_id ?? null,
      tier: context.tier ?? null,
      merchantId: context.merchant_id ?? null,
      agentId: context.agent_id ?? null,
      at: context.at ? new Date(context.at) : undefined,
    };
    const prices = await getAllPrices(ctx);

    const winners = prices.map((p) => p.overrideId).filter((i): i is string => !!i);
    const scopes = await scopesById(winners);

    // Worked examples through the same maths the flows use. With a candidate,
    // it replaces that key's effective value (a fare_multiplier candidate only
    // for the service in context.service, or both when none is given).
    const km = sample?.km ?? 5;
    const stops = sample?.stops ?? 1;
    const amount = sample?.amount ?? 10_000;
    const cashType = context.service === "withdrawal" ? "withdrawal" : "deposit";
    const live = Object.fromEntries(prices.map((p) => [p.key, p.value])) as Record<string, any>;
    const [classes, courierLegs, rideLegs] = await Promise.all([
      getVehicleClasses(),
      getClassLegs("courier_fare", ctx),
      getClassLegs("ride_fare", ctx),
    ]);
    const [courierMult, rideMult, cashRate, courierFormula, rideFormula] = await Promise.all([
      getPrice("fare_multiplier", { ...ctx, service: "courier" }),
      getPrice("fare_multiplier", { ...ctx, service: "ride" }),
      getPrice("blink_cash_fee_rate", { ...ctx, service: cashType }),
      getPrice("fare_formula", { ...ctx, service: "courier" }),
      getPrice("fare_formula", { ...ctx, service: "ride" }),
    ]);

    const examplesWith = (cand: typeof candidateValue) => {
      const pick = (key: PricingKey, fallback: any) => (cand && cand.key === key ? cand.value : fallback);
      const multFor = (service: "courier" | "ride", fallback: number) =>
        cand?.key === "fare_multiplier" && (!context.service || context.service === service)
          ? (cand.value.multiplier as number)
          : fallback;
      const courier = pick("courier_fare", live.courier_fare);
      const ride = pick("ride_fare", live.ride_fare);
      const cm = multFor("courier", courierMult.value.multiplier);
      const rm = multFor("ride", rideMult.value.multiplier);
      const cash = pick("blink_cash_fee_rate", cashRate.value);
      const cf = pick("fare_formula", courierFormula.value);
      const rf = pick("fare_formula", rideFormula.value);
      // 5 km fare per enabled class serving each service (a candidate leg value replaces the resolved legs).
      const fares = (key: "courier_fare" | "ride_fare", resolved: ClassLeg[], value: any, mult: number, formula: any) => {
        const legs = cand?.key === key ? legsFromValue(key, cand.value, classes) : resolved;
        return Object.fromEntries(
          legs.map((l) => [
            l.cls.code,
            fareBreakdown(l.leg, km, {
              stops: key === "courier_fare" ? stops : 1,
              extraStopFee: key === "courier_fare" ? value.extra_stop_fee : 0,
              multiplier: mult,
              formula,
              speedKmh: formula.speed_kmh[l.cls.base_vehicle],
            }).fare,
          ])
        );
      };
      return {
        courier_fare: fares("courier_fare", courierLegs, courier, cm, cf),
        ride_fare: fares("ride_fare", rideLegs, ride, rm, rf),
        blink_cash_fee: { type: cashType as "deposit" | "withdrawal", amount, fees: Math.round(amount * cash.rate) },
      };
    };

    return c.json(
      {
        values: prices.map((p) => ({
          key: p.key,
          value: p.value,
          override_id: p.overrideId,
          scope: p.overrideId ? scopes.get(p.overrideId) ?? null : null,
        })),
        examples: examplesWith(null),
        ...(candidateValue ? { candidate_examples: examplesWith(candidateValue) } : {}),
        ...(candidateValue
          ? {
              candidate_example: {
                key: candidateValue.key,
                before: feeExample(candidateValue.key, live[candidateValue.key], live),
                after: feeExample(candidateValue.key, candidateValue.value, { ...live, [candidateValue.key]: candidateValue.value }),
              },
            }
          : {}),
      },
      200
    );
  }
);

// ─── POST /pricing/admin/simulate ────────────────────────────────────
const SIM_KEYS = {
  store: ["service_fee", "merchant_commission_rate", "stamp_duty_rate", "rider_commission_rate", "store_delivery", "fare_multiplier", "fare_formula"],
  courier: ["courier_fare", "fare_multiplier", "fare_formula", "service_area", "rider_commission_rate"],
  ride: ["ride_fare", "fare_multiplier", "fare_formula", "service_area", "rider_commission_rate"],
  deposit: ["blink_cash_fee_rate", "agent_platform_share", "agent_tax_rate"],
  withdrawal: ["blink_cash_fee_rate", "agent_platform_share", "agent_tax_rate"],
} as const satisfies Record<string, readonly PricingKey[]>;

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/simulate",
    operationId: "simulatePricingAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { body: { ...json(PricingSimulateBody), required: true } },
    responses: {
      200: json(PricingSimulateResponse),
      400: json(ErrorSchema, "Bad request"),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    // Read-only and called on every keystroke (debounced): served from the 15 s cache.
    const { scenario, context = {}, inputs = {} } = c.req.valid("json");
    const at = context.at ? new Date(context.at) : undefined;
    const service = scenario === "store" ? "merchant" : scenario;
    const isFare = scenario === "courier" || scenario === "ride";
    let ctx: PricingContext = {
      service,
      wilaya: context.wilaya_code ?? null,
      merchantId: context.merchant_id ?? null,
      agentId: context.agent_id ?? null,
      at,
    };
    let delivery = inputs.delivery_fee;
    let place: PricingPlace | null = null;
    let storePoint: { lat: number; lng: number } | null = null;
    if (scenario === "store" && context.store_id) {
      const sc = await orderPricingContext({ type: "merchant", storeId: context.store_id });
      // A store without a known wilaya keeps the wilaya the caller picked.
      const { place: storePlace, ...scCtx } = sc;
      ctx = { ...ctx, ...scCtx, wilaya: sc.wilaya ?? ctx.wilaya, at };
      place = storePlace;
      if (delivery == null) {
        const { data } = await supabaseAdmin.from("stores").select("delivery_fee").eq("id", context.store_id).maybeSingle();
        if (data?.delivery_fee != null) delivery = Number(data.delivery_fee);
      }
      const { data: pt } = await supabaseAdmin.from("stores").select("latitude, longitude").eq("id", context.store_id).maybeSingle();
      if (pt?.latitude != null && pt?.longitude != null) storePoint = { lat: Number(pt.latitude), lng: Number(pt.longitude) };
    }

    // Where the trip is priced: a picked pickup point, else a zone, else a tier.
    if (context.pickup) {
      place = await pricingPlace(context.pickup, { at });
      ctx = { ...ctx, ...placeContext(place) };
    } else if (context.zone_id) {
      const { data: zone } = await supabaseAdmin
        .from("pricing_zones")
        .select("id, name, tier, wilaya_code")
        .eq("id", context.zone_id)
        .maybeSingle();
      if (!zone) return c.json({ error: "zone_id doesn't match any zone", code: "scope" }, 400);
      place = { wilaya: zone.wilaya_code, zoneId: zone.id, zoneName: zone.name, tier: zone.tier, unzoned: false, unzonedOverrideId: null };
      ctx = { ...ctx, ...placeContext(place) };
    } else if (context.tier) {
      place = { wilaya: ctx.wilaya ?? null, zoneId: null, zoneName: null, tier: context.tier, unzoned: false, unzonedOverrideId: null };
      ctx = { ...ctx, tier: context.tier };
    }

    const keys = SIM_KEYS[scenario];
    const results = await getPrices(keys, ctx);
    const prices: SimPrices = {};
    for (const k of keys) (prices as Record<string, unknown>)[k] = results[k as keyof typeof results].value;
    // Fares are per vehicle class: resolve each class's leg for this context.
    if (isFare) {
      prices.legs = await getClassLegs(scenario === "ride" ? "ride_fare" : "courier_fare", ctx);
      const wanted = inputs.vehicle ?? SIM_DEFAULTS.vehicle;
      if (!prices.legs.some((l) => l.cls.code === wanted)) {
        return c.json({ error: `"${wanted}" isn't an enabled ${scenario} class with a price here`, code: "class" }, 400);
      }
    }

    // Pickup + drop-off: the server derives km, the drop-off surcharge and the service area.
    const simInputs: SimInputs = { ...inputs, delivery_fee: delivery ?? SIM_DEFAULTS.delivery_fee };
    const extra: { key: PricingKey; value: unknown; override_id: string | null }[] = [];
    if (isFare && context.pickup && context.dropoff) {
      const formula = prices.fare_formula ?? SEED_FORMULA;
      const dropPlace = await pricingPlace(context.dropoff, { at });
      const rule = await getPrice("dropoff_surcharge", { service, ...placeContext(dropPlace), at });
      simInputs.km = routeKm(context.pickup, [context.dropoff], formula);
      simInputs.straight_km = haversineKm(context.pickup, context.dropoff);
      simInputs.surcharge = surchargeFor(rule.value, place?.tier ?? null, dropPlace.tier);
      extra.push({ key: "dropoff_surcharge", value: rule.value, override_id: rule.overrideId });
    }
    if (isFare) simInputs.in_service_area = (prices.service_area ?? { enabled: true }).enabled;

    // Store delivery: through store_delivery when a store (or a picked pickup) and a drop-off are given.
    let deliveryExtra: { delivery_mode: "merchant" | "distance"; vehicle: string | null; breakdown?: { step: any; amount: number }[] } | null = null;
    if (scenario === "store" && prices.store_delivery && (context.store_id || context.pickup)) {
      const origin = context.pickup ?? storePoint;
      const formula = prices.fare_formula ?? SEED_FORMULA;
      let km: number | null = null;
      let surcharge = 0;
      if (origin && context.dropoff) {
        km = routeKm(origin, [context.dropoff], formula);
        const dropPlace = await pricingPlace(context.dropoff, { at });
        const rule = await getPrice("dropoff_surcharge", { service, ...placeContext(dropPlace), at });
        surcharge = surchargeFor(rule.value, place?.tier ?? null, dropPlace.tier);
        extra.push({ key: "dropoff_surcharge", value: rule.value, override_id: rule.overrideId });
      }
      const q = priceStoreDelivery({
        rule: prices.store_delivery,
        merchantFee: delivery ?? SIM_DEFAULTS.delivery_fee,
        km,
        legs: await getClassLegs("store_delivery", ctx),
        multiplier: prices.fare_multiplier?.multiplier ?? 1,
        formula,
        surcharge,
      });
      simInputs.delivery_fee = q.fee;
      deliveryExtra = { delivery_mode: q.mode, vehicle: q.vehicle, breakdown: q.breakdown };
    }

    const result = simulate(scenario, simInputs, prices);

    const winners = [...resultIds(keys, results), ...extra.map((e) => e.override_id)].filter((i): i is string => !!i);
    const scopes = await scopesById(winners);
    return c.json(
      {
        scenario,
        ...result,
        values: [
          ...keys.map((k) => {
            const r = results[k as keyof typeof results];
            return { key: k as PricingKey, value: r.value, override_id: r.overrideId, scope: r.overrideId ? scopes.get(r.overrideId) ?? null : null };
          }),
          ...extra.map((e) => ({ ...e, scope: e.override_id ? scopes.get(e.override_id) ?? null : null })),
        ],
        place: place ? placeView(place) : null,
        ...(deliveryExtra
          ? { delivery_mode: deliveryExtra.delivery_mode, vehicle: deliveryExtra.vehicle, ...(deliveryExtra.breakdown ? { breakdown: deliveryExtra.breakdown } : {}) }
          : {}),
      },
      200
    );
  }
);

export default app;
