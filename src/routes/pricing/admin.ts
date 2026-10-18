// Staff console for the pricing config (tag admin-pricing → excluded from the
// mobile client by orval; the dashboard's /pricing module calls it). Reads:
// finance / ops / commerce admins; writes: finance_admin (super_admin always).
// Every write drops the pricing cache; the pricing_changes log is written by DB
// triggers (same transaction as the write), keyed on updated_by / created_by.
import { isPartnerDealKey, pricingDealCopy, PARTNER_DEAL_KEYS } from "../../lib/pricing/copy";
import {
  isPricingKey,
  PRICING_FIELDS,
  PRICING_GROUPS,
  PRICING_SCHEMAS,
  PRICING_SCOPES,
  PRICING_SEEDS,
  PRICING_UNITS,
  scopeError,
  type PricingKey,
} from "../../lib/pricing/catalog";
import { legFare } from "../../lib/pricing/fare";
import { feeExample, type ExampleValues } from "../../lib/pricing/examples";
import { simulate, SIM_DEFAULTS, type SimPrices } from "../../lib/pricing/simulate";
import { orderPricingContext } from "../../lib/pricing/fees";
import { getAllPrices, getPrice, getPrices, invalidatePricingCache, type PricingContext } from "../../lib/pricing";
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
  "id, key, service, wilaya_code, merchant_id, agent_id, value, starts_at, ends_at, note, created_by, updated_by, archived_at, created_at, updated_at";

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

function statusOf(o: OverrideLike, now = new Date()): "active" | "scheduled" | "ended" | "archived" {
  if (o.archived_at) return "archived";
  if (o.ends_at && Date.parse(o.ends_at) <= now.getTime()) return "ended";
  if (o.starts_at && Date.parse(o.starts_at) > now.getTime()) return "scheduled";
  return "active";
}

function overrideView(o: OverrideRow, names: Map<string, string | null>) {
  const partner = o.merchant_id ?? o.agent_id;
  return {
    id: o.id,
    key: o.key as PricingKey,
    service: o.service,
    wilaya_code: o.wilaya_code,
    merchant_id: o.merchant_id,
    agent_id: o.agent_id,
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
  defaults: ExampleValues = PRICING_SEEDS
) {
  return {
    key,
    group: PRICING_GROUPS[key],
    unit: PRICING_UNITS[key],
    scopes: PRICING_SCOPES[key],
    fields: PRICING_FIELDS[key],
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
    const [{ data, error }, counts] = await Promise.all([
      supabaseAdmin.from("pricing_settings").select("key, value, updated_at, updated_by"),
      activeCounts(),
    ]);
    if (error) throw new Error(`[pricing] settings read failed: ${error.message}`);
    const rows = new Map((data ?? []).map((r) => [r.key as string, r]));
    const keys = Object.keys(PRICING_SEEDS) as PricingKey[];
    const defaults = Object.fromEntries(keys.map((k) => [k, rows.get(k)?.value ?? PRICING_SEEDS[k]])) as ExampleValues;
    return c.json({ fees: keys.map((k) => feeView(k, rows.get(k), counts.get(k) ?? 0, defaults)) }, 200);
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
    return c.json({ fee: feeView(key, saved, counts.get(key) ?? 0) }, 200);
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
    if (q.status === "archived") query = query.not("archived_at", "is", null);
    else if (q.status) query = query.is("archived_at", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(`[pricing] overrides read failed: ${error.message}`);

    let rows = (data ?? []) as OverrideRow[];
    if (q.status) rows = rows.filter((o) => statusOf(o) === q.status);
    const names = await namesById(rows.map((o) => o.merchant_id ?? o.agent_id));
    return c.json({ overrides: rows.map((o) => overrideView(o, names)) }, 200);
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
    };
    const problem = scopeError(key, scope) ?? (await partnerScopeError(scope));
    if (problem) return c.json({ error: problem }, 400);

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
    const names = await namesById([row.merchant_id ?? row.agent_id]);
    return c.json({ override: overrideView(row, names) }, 201);
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
    const names = await namesById([row.merchant_id ?? row.agent_id]);
    return c.json({ override: overrideView(row, names) }, 200);
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
    const names = await namesById([row.merchant_id ?? row.agent_id]);
    return c.json({ override: overrideView(row, names) }, 200);
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
      .select("id, key, override_id, action, before, after, actor_id, created_at");
    if (q.key) query = query.eq("key", q.key);
    if (q.override_id) query = query.eq("override_id", q.override_id);
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
      merchantId: context.merchant_id ?? null,
      agentId: context.agent_id ?? null,
      at: context.at ? new Date(context.at) : undefined,
    };
    const prices = await getAllPrices(ctx);

    const winners = prices.map((p) => p.overrideId).filter((i): i is string => !!i);
    const scopes = new Map<string, { service: string | null; wilaya_code: string | null; merchant_id: string | null; agent_id: string | null }>();
    if (winners.length) {
      const { data } = await supabaseAdmin
        .from("pricing_overrides")
        .select("id, service, wilaya_code, merchant_id, agent_id")
        .in("id", winners);
      for (const o of data ?? []) {
        scopes.set(o.id, { service: o.service, wilaya_code: o.wilaya_code, merchant_id: o.merchant_id, agent_id: o.agent_id });
      }
    }

    // Worked examples through the same maths the flows use. With a candidate,
    // it replaces that key's effective value (a fare_multiplier candidate only
    // for the service in context.service, or both when none is given).
    const km = sample?.km ?? 5;
    const stops = sample?.stops ?? 1;
    const amount = sample?.amount ?? 10_000;
    const cashType = context.service === "withdrawal" ? "withdrawal" : "deposit";
    const live = Object.fromEntries(prices.map((p) => [p.key, p.value])) as Record<string, any>;
    const [courierMult, rideMult, cashRate] = await Promise.all([
      getPrice("fare_multiplier", { ...ctx, service: "courier" }),
      getPrice("fare_multiplier", { ...ctx, service: "ride" }),
      getPrice("blink_cash_fee_rate", { ...ctx, service: cashType }),
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
      return {
        courier_fare: {
          bicycle: legFare(courier.bicycle, km, { stops, extraStopFee: courier.extra_stop_fee, multiplier: cm }),
          motorcycle: legFare(courier.motorcycle, km, { stops, extraStopFee: courier.extra_stop_fee, multiplier: cm }),
        },
        ride_fare: { motorcycle: legFare(ride.motorcycle, km, { multiplier: rm }) },
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
  store: ["service_fee", "merchant_commission_rate", "stamp_duty_rate", "rider_commission_rate"],
  courier: ["courier_fare", "fare_multiplier", "rider_commission_rate"],
  ride: ["ride_fare", "fare_multiplier", "rider_commission_rate"],
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
    const { scenario, context = {}, inputs = {} } = c.req.valid("json");
    invalidatePricingCache();
    const at = context.at ? new Date(context.at) : undefined;
    const service = scenario === "store" ? "merchant" : scenario;
    let ctx: PricingContext = {
      service,
      wilaya: context.wilaya_code ?? null,
      merchantId: context.merchant_id ?? null,
      agentId: context.agent_id ?? null,
      at,
    };
    let delivery = inputs.delivery_fee;
    if (scenario === "store" && context.store_id) {
      const sc = await orderPricingContext({ type: "merchant", storeId: context.store_id });
      ctx = { ...ctx, ...sc, at };
      if (delivery == null) {
        const { data } = await supabaseAdmin.from("stores").select("delivery_fee").eq("id", context.store_id).maybeSingle();
        if (data?.delivery_fee != null) delivery = Number(data.delivery_fee);
      }
    }

    const keys = SIM_KEYS[scenario];
    const results = await getPrices(keys, ctx);
    const prices: SimPrices = {};
    for (const k of keys) (prices as Record<string, unknown>)[k] = results[k as keyof typeof results].value;
    const result = simulate(scenario, { ...inputs, delivery_fee: delivery ?? SIM_DEFAULTS.delivery_fee }, prices);

    const winners = keys.map((k) => results[k as keyof typeof results].overrideId).filter((i): i is string => !!i);
    const scopes = new Map<string, { service: string | null; wilaya_code: string | null; merchant_id: string | null; agent_id: string | null }>();
    if (winners.length) {
      const { data } = await supabaseAdmin
        .from("pricing_overrides")
        .select("id, service, wilaya_code, merchant_id, agent_id")
        .in("id", winners);
      for (const o of data ?? []) {
        scopes.set(o.id, { service: o.service, wilaya_code: o.wilaya_code, merchant_id: o.merchant_id, agent_id: o.agent_id });
      }
    }
    return c.json(
      {
        scenario,
        ...result,
        values: keys.map((k) => {
          const r = results[k as keyof typeof results];
          return { key: k as PricingKey, value: r.value, override_id: r.overrideId, scope: r.overrideId ? scopes.get(r.overrideId) ?? null : null };
        }),
      },
      200
    );
  }
);

export default app;
