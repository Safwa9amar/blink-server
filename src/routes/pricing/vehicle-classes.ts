// Staff console for vehicle classes + the class assigned to a rider (tag
// admin-pricing, same role split as admin.ts: reads finance / ops / commerce
// admins, writes finance_admin). Spec: specs/2026-10-29-zone-pricing-design.md,
// Addendum 2. Every write drops the pricing cache; the pricing_changes rows of
// class writes come from a DB trigger keyed on created_by / updated_by.
import { LEG_KEYS, legCodes, LEG_SERVICE } from "../../lib/pricing/catalog";
import { invalidatePricingCache } from "../../lib/pricing";
import { defaultClassOf } from "../../lib/pricing/vehicle-classes";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  CreateVehicleClassBody,
  ListVehicleClassesQuery,
  PricingStaleError,
  RiderUserIdParam,
  RiderVehicleClassView,
  SetRiderVehicleClassBody,
  UpdateVehicleClassBody,
  VehicleClassCodeParam,
  VehicleClassInUseError,
  VehicleClassResponse,
  VehicleClassesResponse,
} from "../../validators/pricing";

const app = router();

const readStaff = requireStaffRole("finance_admin", "ops_admin", "commerce_admin");
const writeStaff = requireStaffRole("finance_admin");

const COLS = "code, names, base_vehicle, services, exclusive, enabled, sort_order, note, archived_at, updated_at";
/** Code names a leg value can't use as a class (they are other fields of the value). */
const RESERVED_CODES = ["extra_stop_fee", "mode", "min_fee", "max_fee"];

type Row = {
  code: string;
  names: { en: string; fr: string; ar: string };
  base_vehicle: "bicycle" | "motorcycle";
  services: ("ride" | "courier" | "store")[];
  exclusive: boolean;
  enabled: boolean;
  sort_order: number;
  note: string | null;
  archived_at: string | null;
  updated_at: string;
};

const view = (r: Row, riderCount: number) => ({ ...r, rider_count: riderCount });

/** Riders working as this class: assigned to it, or (default classes) unassigned with that base vehicle. */
async function riderCount(code: string): Promise<number> {
  const assigned = await supabaseAdmin.from("rider_profiles").select("user_id", { count: "exact", head: true }).eq("vehicle_class", code);
  if (assigned.error) throw new Error(`[pricing] rider count failed: ${assigned.error.message}`);
  let n = assigned.count ?? 0;
  if (defaultClassOf(code)) {
    const dflt = await supabaseAdmin
      .from("rider_profiles")
      .select("user_id", { count: "exact", head: true })
      .is("vehicle_class", null)
      .eq("vehicle_type", code);
    if (dflt.error) throw new Error(`[pricing] rider count failed: ${dflt.error.message}`);
    n += dflt.count ?? 0;
  }
  return n;
}

async function rowOf(code: string): Promise<Row | null> {
  const { data, error } = await supabaseAdmin.from("vehicle_classes").select(COLS).eq("code", code).maybeSingle();
  if (error) throw new Error(`[pricing] vehicle class read failed: ${error.message}`);
  return (data as Row | null) ?? null;
}

/** Live overrides / stored defaults that hold a leg for `code` on a service it serves. */
async function legUsage(cls: Pick<Row, "code" | "services">): Promise<number> {
  // Only live OVERRIDES block archiving: defaults always carry the seed legs.
  const overrides = await supabaseAdmin.from("pricing_overrides").select("key, value").in("key", [...LEG_KEYS]).is("archived_at", null);
  if (overrides.error) throw new Error(`[pricing] override read failed: ${overrides.error.message}`);
  return (overrides.data ?? []).filter(
    (o) => cls.services.includes(LEG_SERVICE[o.key as (typeof LEG_KEYS)[number]]) && legCodes(o.key as (typeof LEG_KEYS)[number], o.value).includes(cls.code)
  ).length;
}

async function openOrders(code: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("vehicle_type", code)
    .in("status", ["searching", "processing", "heading_to_store", "preparation", "pickup", "on_the_way"]);
  if (error) throw new Error(`[pricing] open orders count failed: ${error.message}`);
  return count ?? 0;
}

/** Live classes as the staff API shows them (catalog + list). */
export async function liveClassViews() {
  const { data, error } = await supabaseAdmin
    .from("vehicle_classes")
    .select(COLS)
    .is("archived_at", null)
    .order("sort_order", { ascending: true })
    .order("code", { ascending: true });
  if (error) throw new Error(`[pricing] vehicle classes read failed: ${error.message}`);
  const rows = (data ?? []) as Row[];
  const counts = await Promise.all(rows.map((r) => riderCount(r.code)));
  return rows.map((r, i) => view(r, counts[i]));
}

// ─── GET /pricing/admin/vehicle-classes ──────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/vehicle-classes",
    operationId: "listVehicleClassesAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { query: ListVehicleClassesQuery },
    responses: { 200: json(VehicleClassesResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const { include_archived } = c.req.valid("query");
    let q = supabaseAdmin.from("vehicle_classes").select(COLS).order("sort_order", { ascending: true }).order("code", { ascending: true });
    if (include_archived !== "true") q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) throw new Error(`[pricing] vehicle classes read failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    const counts = await Promise.all(rows.map((r) => riderCount(r.code)));
    return c.json({ vehicle_classes: rows.map((r, i) => view(r, counts[i])) }, 200);
  }
);

// ─── POST /pricing/admin/vehicle-classes ─────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/vehicle-classes",
    operationId: "createVehicleClassAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { body: { ...json(CreateVehicleClassBody), required: true } },
    responses: {
      201: json(VehicleClassResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: errorResponses[409],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const body = c.req.valid("json");
    if (RESERVED_CODES.includes(body.code)) return c.json({ error: "That code is reserved", code: "code" }, 400);
    if (await rowOf(body.code)) return c.json({ error: "A vehicle class with this code already exists", code: "class_exists" }, 409);

    let sort = body.sort_order;
    if (sort == null) {
      const { data } = await supabaseAdmin.from("vehicle_classes").select("sort_order").order("sort_order", { ascending: false }).limit(1);
      sort = ((data?.[0]?.sort_order as number | undefined) ?? 0) + 1;
    }
    const { data, error } = await supabaseAdmin
      .from("vehicle_classes")
      .insert({
        code: body.code,
        names: body.names,
        base_vehicle: body.base_vehicle,
        services: [...new Set(body.services)],
        exclusive: body.exclusive ?? false,
        enabled: body.enabled ?? true,
        sort_order: sort,
        note: body.note ?? null,
        created_by: staff.id,
        updated_by: staff.id,
      })
      .select(COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] vehicle class insert failed: ${error?.message}`);

    invalidatePricingCache();
    return c.json({ vehicle_class: view(data as Row, 0) }, 201);
  }
);

// ─── PATCH /pricing/admin/vehicle-classes/{code} ─────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/vehicle-classes/{code}",
    operationId: "updateVehicleClassAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: VehicleClassCodeParam, body: { ...json(UpdateVehicleClassBody), required: true } },
    responses: {
      200: json(VehicleClassResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(PricingStaleError, "Someone changed it since you loaded it (error stale)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { code } = c.req.valid("param");
    const body = c.req.valid("json");
    const current = await rowOf(code);
    if (!current) return c.json({ error: "Vehicle class not found" }, 404);
    if (current.archived_at) return c.json({ error: "This vehicle class is archived" }, 400);
    if (body.expected_updated_at && Date.parse(body.expected_updated_at) !== Date.parse(current.updated_at)) {
      return c.json({ error: "stale" as const, updated_at: current.updated_at }, 409);
    }
    // Riders are matched on their base vehicle: changing it under assigned riders would orphan them.
    if (body.base_vehicle && body.base_vehicle !== current.base_vehicle && (await riderCount(code)) > 0) {
      return c.json({ error: "Reassign this class's riders before changing its base vehicle", code: "class" }, 400);
    }

    const patch: Record<string, unknown> = { updated_by: staff.id };
    if (body.names !== undefined) patch.names = body.names;
    if (body.base_vehicle !== undefined) patch.base_vehicle = body.base_vehicle;
    if (body.services !== undefined) patch.services = [...new Set(body.services)];
    if (body.exclusive !== undefined) patch.exclusive = body.exclusive;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
    if (body.note !== undefined) patch.note = body.note;

    const { data, error } = await supabaseAdmin.from("vehicle_classes").update(patch).eq("code", code).select(COLS).single();
    if (error || !data) throw new Error(`[pricing] vehicle class update failed: ${error?.message}`);

    invalidatePricingCache();
    return c.json({ vehicle_class: view(data as Row, await riderCount(code)) }, 200);
  }
);

// ─── DELETE /pricing/admin/vehicle-classes/{code} (archives) ─────────
app.openapi(
  createRoute({
    method: "delete",
    path: "/admin/vehicle-classes/{code}",
    operationId: "archiveVehicleClassAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: VehicleClassCodeParam },
    responses: {
      200: json(VehicleClassResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(VehicleClassInUseError, "Riders, live overrides or open orders use it (code class_in_use)"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { code } = c.req.valid("param");
    const current = await rowOf(code);
    if (!current) return c.json({ error: "Vehicle class not found" }, 404);
    const riders = await riderCount(code);
    if (current.archived_at) return c.json({ vehicle_class: view(current, riders) }, 200);
    // The two base classes are the fallback of every rider without an assigned class.
    const [overrides, orders] = await Promise.all([legUsage(current), openOrders(code)]);
    const assigned = (await supabaseAdmin.from("rider_profiles").select("user_id", { count: "exact", head: true }).eq("vehicle_class", code)).count ?? 0;
    if (assigned > 0 || overrides > 0 || orders > 0 || (defaultClassOf(code) && riders > 0)) {
      return c.json(
        {
          error: "Reassign the riders, remove the overrides that price this class and wait for its open orders first",
          code: "class_in_use" as const,
          rider_count: riders,
          override_count: overrides,
          open_orders: orders,
        },
        409
      );
    }
    const { data, error } = await supabaseAdmin
      .from("vehicle_classes")
      .update({ archived_at: new Date().toISOString(), updated_by: staff.id })
      .eq("code", code)
      .select(COLS)
      .single();
    if (error || !data) throw new Error(`[pricing] vehicle class archive failed: ${error?.message}`);
    invalidatePricingCache();
    return c.json({ vehicle_class: view(data as Row, 0) }, 200);
  }
);

// ─── GET|PUT /pricing/admin/riders/{user_id}/vehicle-class ───────────
async function riderProfile(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .select("user_id, vehicle_type, vehicle_class")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`[pricing] rider read failed: ${error.message}`);
  return data as { user_id: string; vehicle_type: string | null; vehicle_class: string | null } | null;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/riders/{user_id}/vehicle-class",
    operationId: "getRiderVehicleClassAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [readStaff] as const,
    request: { params: RiderUserIdParam },
    responses: { 200: json(RiderVehicleClassView), 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404] },
  }),
  async (c) => {
    const { user_id } = c.req.valid("param");
    const p = await riderProfile(user_id);
    if (!p) return c.json({ error: "Rider not found" }, 404);
    return c.json({ user_id, vehicle_type: p.vehicle_type, vehicle_class: p.vehicle_class }, 200);
  }
);

app.openapi(
  createRoute({
    method: "put",
    path: "/admin/riders/{user_id}/vehicle-class",
    operationId: "setRiderVehicleClassAdmin",
    tags: ["admin-pricing"],
    security: bearer,
    middleware: [writeStaff] as const,
    request: { params: RiderUserIdParam, body: { ...json(SetRiderVehicleClassBody), required: true } },
    responses: {
      200: json(RiderVehicleClassView),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const { user_id } = c.req.valid("param");
    const { vehicle_class } = c.req.valid("json");
    const p = await riderProfile(user_id);
    if (!p) return c.json({ error: "Rider not found" }, 404);
    if (vehicle_class != null) {
      const cls = await rowOf(vehicle_class);
      if (!cls || cls.archived_at) return c.json({ error: "vehicle_class doesn't match a live class", code: "class" }, 400);
      // Matching is by base vehicle: a class only fits riders of its base vehicle.
      if (cls.base_vehicle !== p.vehicle_type) {
        return c.json({ error: `That class is for ${cls.base_vehicle} riders`, code: "class" }, 400);
      }
    }
    const { error } = await supabaseAdmin.from("rider_profiles").update({ vehicle_class }).eq("user_id", user_id);
    if (error) throw new Error(`[pricing] rider class update failed: ${error.message}`);
    // The pricing snapshot doesn't hold riders, but quote counts read them fresh: nothing to invalidate.
    return c.json({ user_id, vehicle_type: p.vehicle_type, vehicle_class }, 200);
  }
);

export default app;
