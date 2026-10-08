// Store drivers — the merchant's own riders (Store Settings → Manage Riders).
import { createNotification } from "../../lib/notifications";
import { CLEAR_OFFER } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import {
  bearer,
  createRoute,
  errorResponses,
  IdParam,
  json,
  OkSchema,
  router,
} from "../../openapi";
import {
  createDriverSchema,
  riderLookupSchema,
  RiderLookupResponse,
  StoreDriverListResponse,
  StoreDriverResponse,
  updateDriverSchema,
} from "../../validators/merchant";
import { deliveriesByRider, fullName, IN_DELIVERY, usersById } from "./orders-shared";
import { ownedStore } from "./shared";

const app = router();

/** Last 9 digits — matches 0555…, +213555…, 213 555… alike. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "").slice(-9);

async function toDrivers(rows: Record<string, any>[]) {
  const riderIds = rows.map((r) => r.rider_user_id).filter(Boolean);
  const [users, deliveries, { data: busy }] = await Promise.all([
    usersById(riderIds),
    deliveriesByRider(riderIds),
    rows.length
      ? supabaseAdmin
          .from("orders")
          .select("rider_id, store_driver_id")
          .in("status", IN_DELIVERY)
      : Promise.resolve({ data: [] as { rider_id: string | null; store_driver_id: string | null }[] }),
  ]);
  const busyDrivers = new Set((busy ?? []).map((b) => b.store_driver_id));
  const busyRiders = new Set((busy ?? []).map((b) => b.rider_id));
  const { data: ownDeliveries } = rows.length
    ? await supabaseAdmin
        .from("orders")
        .select("store_driver_id")
        .in("store_driver_id", rows.map((r) => r.id))
        .eq("status", "delivered")
    : { data: [] as { store_driver_id: string }[] };
  const ownCount = new Map<string, number>();
  for (const o of ownDeliveries ?? []) {
    ownCount.set(o.store_driver_id, (ownCount.get(o.store_driver_id) ?? 0) + 1);
  }
  return rows.map((r) => ({
    ...r,
    avatar: r.rider_user_id ? users.get(r.rider_user_id)?.profile_picture ?? null : null,
    deliveries: r.rider_user_id ? deliveries.get(r.rider_user_id) ?? 0 : ownCount.get(r.id) ?? 0,
    on_delivery: busyDrivers.has(r.id) || (!!r.rider_user_id && busyRiders.has(r.rider_user_id)),
  }));
}

/**
 * Withdraw the rider requests sent to a driver leaving the team (removed or
 * deactivated): a deactivated driver's accept would still hand them the
 * order, and a removed one's can only fail while the order stays held for
 * them until it expires. Unassigned searching orders only, never a job in
 * progress.
 */
const withdrawDriverRequests = (driverId: string) =>
  supabaseAdmin
    .from("orders")
    .update(CLEAR_OFFER)
    .eq("offered_driver_id", driverId)
    .is("rider_id", null)
    .eq("status", "searching");

async function ownedDriver(userId: string, driverId: string) {
  const { data } = await supabaseAdmin
    .from("store_drivers")
    .select("*, store:stores!inner(owner_id)")
    .eq("id", driverId)
    .eq("store.owner_id", userId)
    .maybeSingle();
  if (!data) return null;
  const { store: _s, ...driver } = data as Record<string, any>;
  return driver;
}

// ── GET /stores/{id}/drivers ─────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/stores/{id}/drivers",
    operationId: "listStoreDrivers",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(StoreDriverListResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    if (!(await ownedStore(user.id, id))) return c.json({ error: "Store not found" }, 404);
    const { data, error } = await supabaseAdmin
      .from("store_drivers")
      .select("*")
      .eq("store_id", id)
      .neq("status", "declined")
      .order("created_at", { ascending: true });
    if (error) return c.json({ error: error.message }, 404);
    return c.json({ drivers: (await toDrivers(data ?? [])) as any }, 200);
  }
);

// ── GET /riders/lookup?phone= — find a Blink rider to invite ─────────
app.openapi(
  createRoute({
    method: "get",
    path: "/riders/lookup",
    operationId: "lookupBlinkRider",
    tags: ["merchant"],
    security: bearer,
    request: { query: riderLookupSchema },
    responses: {
      200: json(RiderLookupResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const key = phoneKey(c.req.valid("query").phone);
    if (key.length < 9) return c.json({ error: "Enter a full phone number" }, 400);
    const { data: riders } = await supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number, profile_picture")
      .eq("role", "rider")
      .ilike("phone_number", `%${key}`)
      .limit(1);
    const rider = riders?.[0];
    if (!rider) return c.json({ error: "No Blink rider with this number" }, 404);
    const [{ data: profile }, deliveries] = await Promise.all([
      supabaseAdmin.from("rider_profiles").select("vehicle_type").eq("user_id", rider.id).maybeSingle(),
      deliveriesByRider([rider.id]),
    ]);
    return c.json(
      {
        rider: {
          id: rider.id,
          name: fullName(rider) ?? "Blink rider",
          phone: rider.phone_number,
          avatar: rider.profile_picture,
          vehicle_type: profile?.vehicle_type ?? null,
          deliveries: deliveries.get(rider.id) ?? 0,
        },
      },
      200
    );
  }
);

// ── POST /stores/{id}/drivers — invite a Blink rider / add external ──
app.openapi(
  createRoute({
    method: "post",
    path: "/stores/{id}/drivers",
    operationId: "createStoreDriver",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam, body: { ...json(createDriverSchema), required: true } },
    responses: {
      201: json(StoreDriverResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id: storeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const store = await ownedStore(user.id, storeId);
    if (!store) return c.json({ error: "Store not found" }, 404);

    let row: Record<string, unknown>;
    if (body.kind === "blink") {
      const { data: rider } = await supabaseAdmin
        .from("users")
        .select("id, first_name, last_name, phone_number")
        .eq("id", body.rider_id!)
        .eq("role", "rider")
        .maybeSingle();
      if (!rider) return c.json({ error: "Rider not found" }, 404);
      const { data: existing } = await supabaseAdmin
        .from("store_drivers")
        .select("id, status")
        .eq("store_id", storeId)
        .eq("rider_user_id", rider.id)
        .maybeSingle();
      if (existing && existing.status !== "declined") {
        return c.json({ error: "This rider is already on your team" }, 400);
      }
      if (existing) await supabaseAdmin.from("store_drivers").delete().eq("id", existing.id);
      row = {
        store_id: storeId,
        kind: "blink",
        rider_user_id: rider.id,
        full_name: fullName(rider) ?? "Blink rider",
        phone: rider.phone_number,
        status: "invited",
      };
    } else {
      row = {
        store_id: storeId,
        kind: "external",
        full_name: body.full_name,
        phone: body.phone,
        vehicle_type: body.vehicle_type ?? null,
        plate_number: body.plate_number ?? null,
        notes: body.notes ?? null,
        status: "active",
      };
    }

    const { data, error } = await supabaseAdmin.from("store_drivers").insert(row).select().single();
    if (error || !data) return c.json({ error: error?.message ?? "Could not add driver" }, 400);

    if (body.kind === "blink") {
      await createNotification({
        userId: body.rider_id!,
        type: "alert",
        title: "Store invitation",
        description: `${store.name} invited you to deliver for their store.`,
        contentFr: { title: "Invitation d'un magasin", description: `${store.name} vous invite à livrer pour son magasin.` },
        contentAr: { title: "دعوة من متجر", description: `${store.name} يدعوك للتوصيل لمتجره.` },
        payload: { kind: "store_invitation", invitation_id: data.id, store_id: storeId },
        href: "/(rider)/store-invitations",
      }).catch(() => null);
    }

    const [driver] = await toDrivers([data]);
    return c.json({ driver: driver as any }, 201);
  }
);

// ── PATCH /drivers/{id} ──────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/drivers/{id}",
    operationId: "updateStoreDriver",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam, body: { ...json(updateDriverSchema), required: true } },
    responses: {
      200: json(StoreDriverResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const driver = await ownedDriver(user.id, id);
    if (!driver) return c.json({ error: "Driver not found" }, 404);
    // A Blink rider's identity comes from their account.
    const patch: Record<string, unknown> =
      driver.kind === "blink"
        ? { status: body.status, notes: body.notes }
        : { ...body };
    if (driver.status === "invited" && patch.status) delete patch.status;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (clean.status && clean.status !== "active") {
      // Deactivating: their pending requests go first.
      const { error: withdrawError } = await withdrawDriverRequests(id);
      if (withdrawError) return c.json({ error: withdrawError.message }, 400);
    }
    const { data, error } = await supabaseAdmin
      .from("store_drivers")
      .update(clean)
      .eq("id", id)
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Driver not found" }, 400);
    const [out] = await toDrivers([data]);
    return c.json({ driver: out as any }, 200);
  }
);

// ── DELETE /drivers/{id} ─────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "delete",
    path: "/drivers/{id}",
    operationId: "deleteStoreDriver",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(OkSchema),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    if (!(await ownedDriver(user.id, id))) return c.json({ error: "Driver not found" }, 404);
    const { error: withdrawError } = await withdrawDriverRequests(id);
    if (withdrawError) return c.json({ error: withdrawError.message }, 400);
    const { error } = await supabaseAdmin.from("store_drivers").delete().eq("id", id);
    if (error) return c.json({ error: error.message }, 404);
    return c.json({ success: true }, 200);
  }
);

export default app;
